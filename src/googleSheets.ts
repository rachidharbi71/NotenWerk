import type { SchoolClass } from './types'

const SPREADSHEET_NAME = 'notenwerk. HARBI – Notendaten'
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file'
const SHEETS = ['Übersicht', 'Klassen', 'Schüler', 'Leistungen', 'Aufgaben', 'Punkte', 'Noten', '_notenwerk']
let accessToken = ''
let scriptPromise: Promise<void> | null = null

interface TokenResponse { access_token?: string; error?: string; error_description?: string }
interface TokenClient { requestAccessToken: (overrides?: { prompt?: string }) => void }
interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
        error_callback: (error: { type?: string }) => void
      }) => TokenClient
      revoke: (token: string, callback: () => void) => void
    }
  }
}

declare global {
  interface Window { google?: GoogleIdentity }
}

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts.oauth2) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google-Anmeldung konnte nicht geladen werden. Prüfe deine Internetverbindung.'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

export async function authorizeGoogle(clientId: string): Promise<void> {
  await loadGoogleIdentity()
  if (!window.google) throw new Error('Google-Anmeldung ist nicht verfügbar.')
  await new Promise<void>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || 'Die Google-Freigabe wurde nicht erteilt.'))
          return
        }
        accessToken = response.access_token
        resolve()
      },
      error_callback: () => reject(new Error('Das Google-Anmeldefenster wurde geschlossen oder blockiert.')),
    })
    client.requestAccessToken({ prompt: 'consent' })
  })
}

export function disconnectGoogle(): void {
  if (accessToken && window.google) window.google.accounts.oauth2.revoke(accessToken, () => undefined)
  accessToken = ''
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!accessToken) throw new Error('Bitte zuerst mit Google verbinden.')
  const response = await fetch(`https://sheets.googleapis.com/v4${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) {
    if (response.status === 401) accessToken = ''
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message || `Google Sheets Fehler (${response.status}).`)
  }
  return response.json() as Promise<T>
}

async function findSpreadsheet(): Promise<string | null> {
  if (!accessToken) throw new Error('Bitte zuerst mit Google verbinden.')
  const query = encodeURIComponent(`name='${SPREADSHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`)
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error('Die notenwerk-Tabelle konnte in Google Drive nicht gesucht werden.')
  const data = await response.json() as { files?: { id: string }[] }
  return data.files?.[0]?.id ?? null
}

export async function ensureSpreadsheet(preferredId?: string): Promise<{ id: string; created: boolean }> {
  if (preferredId) {
    try {
      await api<{ spreadsheetId: string }>(`/spreadsheets/${preferredId}?fields=spreadsheetId`)
      return { id: preferredId, created: false }
    } catch {
      localStorage.removeItem('notenwerk-google-sheet-id')
    }
  }
  const existing = await findSpreadsheet()
  if (existing) return { id: existing, created: false }
  const result = await api<{ spreadsheetId: string }>('/spreadsheets', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: SPREADSHEET_NAME, locale: 'de_DE', timeZone: 'Europe/Berlin' },
      sheets: SHEETS.map((title) => ({ properties: { title } })),
    }),
  })
  await api(`/spreadsheets/${result.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [
      { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    ] }),
  })
  return { id: result.spreadsheetId, created: true }
}

type Cell = string | number | boolean | null
const rowsFor = (classes: SchoolClass[]): Record<string, Cell[][]> => {
  const overview: Cell[][] = [['notenwerk. HARBI', 'Automatisch synchronisierte Notendaten'], ['Aktualisiert', new Date().toISOString()], ['Version', 22], ['Klassen', classes.length], ['Schüler', classes.reduce((sum, item) => sum + item.students.length, 0)], [], ['Hinweis', 'Das Blatt _notenwerk enthält die technische Sicherung und darf nicht verändert werden.']]
  const classRows: Cell[][] = [['ID', 'Klasse', 'Fach', 'Schuljahr', 'Notenskala', 'Farbe', 'Einstellungen (JSON)']]
  const studentRows: Cell[][] = [['Klassen-ID', 'Schüler-ID', 'Nachname', 'Vorname', 'Kurs', 'Kurswechsel', 'Wechseldatum']]
  const assessmentRows: Cell[][] = [['Klassen-ID', 'Leistungs-ID', 'Titel', 'Art', 'Datum', 'Gewichtung']]
  const taskRows: Cell[][] = [['Leistungs-ID', 'Aufgaben-ID', 'Aufgabenname', 'Höchstpunkte', 'Zusatz']]
  const pointRows: Cell[][] = [['Schüler-ID', 'Aufgaben-ID', 'Punkte']]
  const gradeRows: Cell[][] = [['Schüler-ID', 'Leistungs-ID', 'Note']]
  classes.forEach((schoolClass) => {
    classRows.push([schoolClass.id, schoolClass.name, schoolClass.subject, schoolClass.schoolYear, schoolClass.gradeScale ?? '1-6', schoolClass.color, JSON.stringify({ gradeThresholds: schoolClass.gradeThresholds, weightSettings: schoolClass.weightSettings, percentageThresholds: schoolClass.percentageThresholds })])
    schoolClass.students.forEach((student) => {
      studentRows.push([schoolClass.id, student.id, student.lastName, student.firstName, student.course ?? 'V', student.courseChange ?? '', student.courseChangeDate ?? ''])
      Object.entries(student.taskPoints ?? {}).forEach(([taskId, points]) => pointRows.push([student.id, taskId, points ?? '']))
      Object.entries(student.grades).forEach(([assessmentId, grade]) => gradeRows.push([student.id, assessmentId, grade ?? '']))
    })
    schoolClass.assessments.forEach((assessment) => {
      assessmentRows.push([schoolClass.id, assessment.id, assessment.title, assessment.category, assessment.date, assessment.weight])
      assessment.tasks?.forEach((task) => taskRows.push([assessment.id, task.id, task.name, task.maxPoints, task.bonus ? 'Ja' : 'Nein']))
    })
  })
  const json = JSON.stringify(classes)
  const chunks = json.match(/[\s\S]{1,45000}/g) ?? ['[]']
  return { 'Übersicht': overview, 'Klassen': classRows, 'Schüler': studentRows, 'Leistungen': assessmentRows, 'Aufgaben': taskRows, 'Punkte': pointRows, 'Noten': gradeRows, '_notenwerk': [['Datenblock – nicht verändern'], ...chunks.map((chunk) => [chunk])] }
}

export async function uploadToGoogle(spreadsheetId: string, classes: SchoolClass[]): Promise<string> {
  const sheets = rowsFor(classes)
  await api(`/spreadsheets/${spreadsheetId}/values:batchClear`, { method: 'POST', body: JSON.stringify({ ranges: SHEETS }) })
  await api(`/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: SHEETS.map((name) => ({ range: `'${name}'!A1`, majorDimension: 'ROWS', values: sheets[name] })) }),
  })
  return new Date().toISOString()
}

export async function downloadFromGoogle(spreadsheetId: string): Promise<SchoolClass[]> {
  const result = await api<{ values?: string[][] }>(`/spreadsheets/${spreadsheetId}/values/'_notenwerk'!A2:A?majorDimension=ROWS`)
  const json = (result.values ?? []).map((row) => row[0] ?? '').join('')
  if (!json) throw new Error('In dieser Google-Tabelle sind noch keine notenwerk-Daten vorhanden.')
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) throw new Error('Das gespeicherte Datenformat ist ungültig.')
  return parsed as SchoolClass[]
}

export function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
}
