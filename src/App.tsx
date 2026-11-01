import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from 'react'
import {
  BarChart3, BookOpen, Check, ChevronDown, CircleHelp, Cloud, CloudDownload, Download, ExternalLink, FileSpreadsheet, Sigma,
  FileText, GraduationCap, LayoutDashboard, ListOrdered, Menu, Pencil, Plus, RefreshCw, Scale, Search, ShieldCheck,
  Trash2, TrendingUp, UserPlus, Users, X,
} from 'lucide-react'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { demoClasses } from './data'
import type { Assessment, Category, Course, CourseChange, GradeScale, ParticipationRecord, ParticipationType, SchoolClass, Student, View } from './types'
import { average, classAverage, formatAverage, formatDate, gradeColor, gradeLabel, uid } from './utils'
import Modal from './components/Modal'
import { authorizeGoogle, disconnectGoogle, downloadFromGoogle, ensureSpreadsheet, spreadsheetUrl, uploadToGoogle } from './googleSheets'
import './App.css'

type ModalType = 'assessment' | 'student' | 'class' | 'help' | 'google' | null

function ParticipationIcon({ size = 24 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10" cy="6" r="2.4" /><path d="M7 15v-3.2c0-1.3 1-2.3 2.3-2.3h2.2c.8 0 1.5.4 1.9 1l1.1 1.5" /><path d="M14.5 12 17 6.5M17 6.5V3.8M17 6.5l1.8 1.2M5 15h15M6 15v5M19 15v5M5 18h15" /></svg>
}

const navItems: { id: View; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'students', label: 'Schüler', icon: Users },
  { id: 'overview', label: 'Übersicht', icon: LayoutDashboard },
  { id: 'participation', label: 'Mitarbeit', icon: ParticipationIcon },
  { id: 'analytics', label: 'Auswertung', icon: BarChart3 },
  { id: 'gradebook', label: 'Notenbuch', icon: BookOpen },
  { id: 'weighting', label: 'Gewichtung', icon: Scale },
  { id: 'gradeScheme', label: 'Notenschlüssel', icon: ListOrdered },
]

const weightOptions = [0, 0.5, 1, 1.5, 2, 2.5, 3]
const currentSchoolYear = () => {
  const now = new Date()
  const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1
  return `${String(start).slice(-2)}/${String(start + 1).slice(-2)}`
}
type PercentageCourse = Course | 'Abschluss'
const effectiveCourse = (student: { course?: Course; courseChange?: CourseChange | null }): Course => student.courseChange ?? student.course ?? 'V'
const isWrittenAssessment = (category: Category) => category === 'Klassenarbeit' || category === 'Lernzielkontrolle' || category === 'Schulaufgabe' || category === 'Stegreifaufgabe'

const defaultPercentageThresholds: Record<PercentageCourse, number[]> = {
  V: [92, 80, 67, 50, 30, 0],
  GK: [85, 70, 55, 40, 25, 0],
  EK: [90, 75, 60, 45, 25, 0],
  Abschluss: [87, 73, 59, 45, 18, 0],
}

const calculateTaskResult = (schoolClass: SchoolClass, student: Student, assessment: Assessment) => {
  const tasks = (assessment.tasks ?? []).filter((task) => task.name.trim() && task.maxPoints > 0)
  const entered = tasks.filter((task) => typeof student.taskPoints?.[task.id] === 'number')
  const regularMaximum = tasks.filter((task) => !task.bonus).reduce((sum, task) => sum + task.maxPoints, 0)
  if (!entered.length || !regularMaximum) return { grade: null as number | null, percentage: null as number | null, thresholds: null as number[] | null }
  const earned = entered.reduce((sum, task) => sum + (student.taskPoints?.[task.id] ?? 0), 0)
  const percentage = Math.max(0, (earned / regularMaximum) * 100)
  if (schoolClass.gradeScale === '0-15') return { grade: Math.round((percentage / 100) * 15), percentage, thresholds: null as number[] | null }
  const classYear = Number(schoolClass.name.match(/\d+/)?.[0])
  const hasCourses = schoolClass.students.some((item) => effectiveCourse(item) !== 'V')
  const key: PercentageCourse = classYear === 5 || classYear === 6 ? 'GK' : classYear === 10 ? 'Abschluss' : hasCourses ? effectiveCourse(student) : 'V'
  const thresholds = { ...defaultPercentageThresholds, ...schoolClass.percentageThresholds }[key]
  const grade = thresholds.findIndex((threshold) => percentage >= threshold) + 1 || 6
  return { grade, percentage, thresholds }
}

const participationRecordsFor = (schoolClass: SchoolClass): ParticipationRecord[] => {
  const legacy = schoolClass.assessments.filter((assessment) => assessment.category === 'Mündlich').flatMap((assessment) => schoolClass.students.flatMap((student) => {
    const grade = student.grades[assessment.id]
    if (typeof grade !== 'number') return []
    const label = grade === 1 ? 'Sehr gut' : grade === 2 ? 'Gut' : grade === 3 ? 'befriedigend' : grade === 5 ? 'mangelhaft' : `Note ${grade}`
    return [{ id: `alt-${assessment.id}-${student.id}`, studentId: student.id, type: 'Mündliche Mitarbeit' as const, date: assessment.date, detail: label, grade }]
  }))
  return [...(schoolClass.participation ?? []), ...legacy]
}

function loadClasses(): SchoolClass[] {
  try {
    const saved = localStorage.getItem('notenwerk-data')
    if (!saved) return demoClasses
    const parsed = JSON.parse(saved) as SchoolClass[]
    return parsed.map((schoolClass) => {
      const counters: Partial<Record<Category, number>> = {}
      return {
        ...schoolClass,
        assessments: schoolClass.assessments.map((assessment) => {
          if (/Schulaufgabe/.test(assessment.title) && !assessment.title.includes('Nr.')) return { ...assessment, category: 'Schulaufgabe' }
          if (/^(Ex|Stegreifaufgabe)[: ]/.test(assessment.title) && !assessment.title.includes('Nr.')) return { ...assessment, category: 'Stegreifaufgabe' }
          if (!['Klassenarbeit', 'Lernzielkontrolle', 'Projekt', 'Sonstiges'].includes(assessment.category)) return assessment
          counters[assessment.category] = (counters[assessment.category] ?? 0) + 1
          const topic = assessment.title.match(/^.*? Nr\.\d+ \((.*)\)$/)?.[1]
          return topic ? { ...assessment, title: `${assessment.category} Nr.${counters[assessment.category]} (${topic})` } : assessment
        }),
      }
    })
  } catch {
    return demoClasses
  }
}

export default function App() {
  const [classes, setClasses] = useState<SchoolClass[]>(loadClasses)
  const [activeClassId, setActiveClassId] = useState(() => loadClasses()[0]?.id ?? '')
  const [view, setView] = useState<View>('gradebook')
  const [modal, setModal] = useState<ModalType>(null)
  const [search, setSearch] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [toast, setToast] = useState('')
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([])
  const [expandedAssessmentId, setExpandedAssessmentId] = useState<string | null>(null)
  const [participationFormOpen, setParticipationFormOpen] = useState(false)
  const [participationStudents, setParticipationStudents] = useState<string[]>([])
  const [participationStudentOpen, setParticipationStudentOpen] = useState(false)
  const [participationType, setParticipationType] = useState<ParticipationType>('Mündliche Mitarbeit')
  const [participationWeeklyName, setParticipationWeeklyName] = useState('')
  const [participationDetail, setParticipationDetail] = useState('')
  const [googleClientId, setGoogleClientId] = useState(() => localStorage.getItem('notenwerk-google-client-id') ?? '')
  const [googleConnected, setGoogleConnected] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [googleError, setGoogleError] = useState('')
  const [spreadsheetId, setSpreadsheetId] = useState(() => localStorage.getItem('notenwerk-google-sheet-id') ?? '')
  const [lastSync, setLastSync] = useState('')
  const classesRef = useRef(classes)
  const syncQueue = useRef(Promise.resolve())
  const activeClass = classes.find((item) => item.id === activeClassId) ?? classes[0]

  useEffect(() => {
    setSelectedStudentIds([])
    setExpandedAssessmentId(null)
    setParticipationFormOpen(false)
    setParticipationStudents([])
    setParticipationStudentOpen(false)
    setParticipationType('Mündliche Mitarbeit')
    setParticipationWeeklyName('')
    setParticipationDetail('')
  }, [activeClassId])

  useEffect(() => {
    classesRef.current = classes
    localStorage.setItem('notenwerk-data', JSON.stringify(classes))
    localStorage.setItem('notenwerk-local-updated', new Date().toISOString())
  }, [classes])

  useEffect(() => {
    if (!googleConnected || !spreadsheetId) return
    const timer = window.setTimeout(() => {
      syncQueue.current = syncQueue.current.catch(() => undefined).then(async () => {
        try {
          const syncedAt = await uploadToGoogle(spreadsheetId, classesRef.current)
          setLastSync(syncedAt)
          setGoogleError('')
        } catch (error) {
          setGoogleError(error instanceof Error ? error.message : 'Automatische Synchronisierung fehlgeschlagen.')
        }
      })
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [classes, googleConnected, spreadsheetId])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  const updateClass = (updater: (schoolClass: SchoolClass) => SchoolClass) => {
    setClasses((current) => current.map((item) => item.id === activeClass.id ? updater(item) : item))
  }

  const filteredStudents = useMemo(() => activeClass.students.filter((student) =>
    `${student.lastName} ${student.firstName}`.toLowerCase().includes(search.toLowerCase()),
  ).sort((a, b) => a.lastName.localeCompare(b.lastName, 'de') || a.firstName.localeCompare(b.firstName, 'de')), [activeClass, search])

  const averages = activeClass.students.map((student) => average(student, activeClass))
  const validAverages = averages.filter((value): value is number => value !== null)
  const atRisk = validAverages.filter((value) => gradeColor(value, activeClass) === 'risk').length
  const goodStudents = validAverages.filter((value) => gradeColor(value, activeClass) === 'good').length

  function addAssessment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const topic = String(data.get('topic')).trim()
    const category = String(data.get('category')) as Category
    if (!topic) return
    updateClass((schoolClass) => {
      const number = schoolClass.assessments.filter((assessment) => assessment.category === category).length + 1
      return { ...schoolClass, assessments: [...schoolClass.assessments, {
        id: uid('leistung'), title: `${category} Nr.${number} (${topic})`, category,
        date: String(data.get('date')), weight: Number(data.get('weight')),
      }] }
    })
    setModal(null)
    setToast('Schriftliche Leistung wurde hinzugefügt')
  }

  function addParticipation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const detail = participationType === 'Wochenplan' ? `${participationWeeklyName.trim()} · ${participationDetail}` : participationDetail.trim()
    if (!participationStudents.length || !detail || (participationType === 'Wochenplan' && !participationWeeklyName.trim())) {
      setToast('Bitte mindestens einen Schüler auswählen und alle Felder ausfüllen')
      return
    }
    const grade = participationType === 'Wochenplan'
      ? participationDetail === 'Erledigt' ? 1 : participationDetail === 'Teilweise erledigt' ? 4 : 6
      : participationType === 'Fehlendes Material'
        ? 6
        : participationDetail === 'Sehr gut' ? 1 : participationDetail === 'Gut' ? 2 : participationDetail === 'befriedigend' ? 3 : 5
    const studentIds = participationStudents
    const date = new Date().toISOString().slice(0, 10)
    const records: ParticipationRecord[] = studentIds.map((studentId) => ({ id: uid('mitarbeit'), studentId, type: participationType, date, detail, grade }))
    updateClass((schoolClass) => ({ ...schoolClass, participation: [...(schoolClass.participation ?? []), ...records] }))
    setParticipationFormOpen(false)
    setParticipationStudents([])
    setParticipationStudentOpen(false)
    setParticipationWeeklyName('')
    setParticipationDetail('')
    setToast(`${records.length === 1 ? 'Mitarbeitseintrag' : 'Mitarbeitseinträge'} gespeichert`)
  }

  function deleteParticipationRecord(id: string) {
    updateClass((schoolClass) => {
      if (id.startsWith('alt-')) {
        const legacyId = id.slice(4)
        const student = schoolClass.students.find((item) => legacyId.endsWith(`-${item.id}`))
        if (student) {
          const assessmentId = legacyId.slice(0, -student.id.length - 1)
          return {
            ...schoolClass,
            students: schoolClass.students.map((item) => {
              if (item.id !== student.id) return item
              const grades = { ...item.grades }
              delete grades[assessmentId]
              return { ...item, grades }
            }),
          }
        }
      }
      return { ...schoolClass, participation: (schoolClass.participation ?? []).filter((record) => record.id !== id) }
    })
    setToast('Mitarbeitseintrag wurde gelöscht')
  }

  function addStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const bulk = String(data.get('bulk')).trim()
    const firstName = String(data.get('firstName')).trim()
    const lastName = String(data.get('lastName')).trim()
    const newStudents = bulk ? bulk.split(/\r?\n/).map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean).map((line) => {
      const normalized = line.includes('\t') ? line.split('\t').filter(Boolean).join(', ') : line
      const parts = normalized.includes(',') ? normalized.split(',').map((part) => part.trim()) : normalized.split(/\s+/)
      if (parts.length < 2) return null
      return normalized.includes(',') ? { lastName: parts[0], firstName: parts.slice(1).join(' ') } : { lastName: parts[0], firstName: parts.slice(1).join(' ') }
    }).filter((student): student is { firstName: string; lastName: string } => Boolean(student?.firstName && student?.lastName)) : (firstName && lastName ? [{ firstName, lastName }] : [])
    if (!newStudents.length) {
      setToast('Bitte einen Namen oder eine gültige Liste einfügen')
      return
    }
    updateClass((schoolClass) => ({ ...schoolClass, students: [...schoolClass.students, ...newStudents.map((student) => ({ ...student, id: uid('schueler'), grades: {} }))].sort((a, b) => a.lastName.localeCompare(b.lastName, 'de') || a.firstName.localeCompare(b.firstName, 'de')) }))
    setModal(null)
    setToast(newStudents.length === 1 ? `${newStudents[0].firstName} ${newStudents[0].lastName} wurde hinzugefügt` : `${newStudents.length} Schüler wurden hinzugefügt`)
  }

  function addClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const name = String(data.get('name')).trim()
    if (!name) return
    const newClass: SchoolClass = {
      id: uid('klasse'), name, subject: String(data.get('subject')).trim(), schoolYear: currentSchoolYear(),
      color: '#0064E6', students: [], assessments: [],
    }
    setClasses((current) => [...current, newClass])
    setActiveClassId(newClass.id)
    setModal(null)
    setToast('Neue Klasse wurde angelegt')
  }

  function renameActiveClass() {
    const name = window.prompt('Neuer Name der Klasse:', activeClass.name)?.trim()
    if (!name || name === activeClass.name) return
    updateClass((schoolClass) => ({ ...schoolClass, name }))
    setToast('Klasse wurde umbenannt')
  }

  function deleteActiveClass() {
    if (classes.length === 1) {
      setToast('Die letzte Klasse kann nicht gelöscht werden')
      return
    }
    if (!window.confirm(`Klasse „${activeClass.name}“ mit allen Schülern, Leistungen und Noten wirklich löschen?`)) return
    const remaining = classes.filter((item) => item.id !== activeClass.id)
    setClasses(remaining)
    setActiveClassId(remaining[0].id)
    setToast('Klasse wurde gelöscht')
  }

  function toggleAssessmentTasks(assessmentId: string) {
    if (expandedAssessmentId === assessmentId) {
      setExpandedAssessmentId(null)
      return
    }
    setExpandedAssessmentId(assessmentId)
    updateClass((schoolClass) => ({
      ...schoolClass,
      assessments: schoolClass.assessments.map((assessment) => assessment.id === assessmentId && !assessment.tasks?.length ? {
        ...assessment,
        tasks: [{ id: uid('aufgabe'), name: '', maxPoints: 0, bonus: false }],
      } : assessment),
    }))
  }

  function addAssessmentTask(assessmentId: string) {
    updateClass((schoolClass) => ({
      ...schoolClass,
      assessments: schoolClass.assessments.map((assessment) => assessment.id === assessmentId ? {
        ...assessment,
        tasks: [...(assessment.tasks ?? []), { id: uid('aufgabe'), name: '', maxPoints: 0, bonus: false }],
      } : assessment),
    }))
  }

  function updateAssessmentTask(assessmentId: string, taskId: string, field: 'name' | 'maxPoints' | 'bonus', value: string | number | boolean) {
    updateClass((schoolClass) => {
      const assessments = schoolClass.assessments.map((assessment) => assessment.id === assessmentId ? {
        ...assessment,
        tasks: assessment.tasks?.map((task) => task.id === taskId ? { ...task, [field]: value } : task),
      } : assessment)
      const assessment = assessments.find((item) => item.id === assessmentId)!
      return {
        ...schoolClass,
        assessments,
        students: schoolClass.students.map((student) => ({ ...student, grades: { ...student.grades, [assessmentId]: calculateTaskResult(schoolClass, student, assessment).grade } })),
      }
    })
  }

  function deleteAssessmentTask(assessmentId: string, taskId: string) {
    updateClass((schoolClass) => {
      const assessments = schoolClass.assessments.map((assessment) => assessment.id === assessmentId ? { ...assessment, tasks: assessment.tasks?.filter((task) => task.id !== taskId) } : assessment)
      const assessment = assessments.find((item) => item.id === assessmentId)!
      return {
        ...schoolClass,
        assessments,
        students: schoolClass.students.map((student) => {
          const taskPoints = { ...student.taskPoints }
          delete taskPoints[taskId]
          const nextStudent = { ...student, taskPoints }
          return { ...nextStudent, grades: { ...student.grades, [assessmentId]: calculateTaskResult(schoolClass, nextStudent, assessment).grade } }
        }),
      }
    })
  }

  function updateTaskPoints(studentId: string, assessmentId: string, taskId: string, value: string) {
    const parsed = value === '' ? null : Number(value)
    const assessment = activeClass.assessments.find((item) => item.id === assessmentId)
    const task = assessment?.tasks?.find((item) => item.id === taskId)
    if (!assessment || !task || (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > task.maxPoints))) return
    updateClass((schoolClass) => ({
      ...schoolClass,
      students: schoolClass.students.map((student) => {
        if (student.id !== studentId) return student
        const taskPoints = { ...student.taskPoints, [taskId]: parsed }
        const nextStudent = { ...student, taskPoints }
        const grade = calculateTaskResult(schoolClass, nextStudent, assessment).grade
        return { ...nextStudent, grades: { ...student.grades, [assessmentId]: grade } }
      }),
    }))
  }

  function updateCourse(studentId: string, course: Course) {
    updateClass((schoolClass) => ({
      ...schoolClass,
      students: schoolClass.students.map((student) => student.id === studentId ? { ...student, course } : student),
    }))
  }

  function updateCourseChange(studentId: string, value: string) {
    const courseChange = value === '' ? null : value as CourseChange
    updateClass((schoolClass) => ({
      ...schoolClass,
      students: schoolClass.students.map((student) => student.id === studentId ? {
        ...student,
        courseChange,
        courseChangeDate: courseChange ? new Date().toISOString().slice(0, 10) : null,
      } : student),
    }))
  }

  function updateGradeScale(gradeScale: GradeScale) {
    setClasses((current) => current.map((schoolClass) => ({
      ...schoolClass,
      gradeScale,
      gradeThresholds: gradeScale === '0-15' ? [13, 10, 7, 4, 1] : [1.5, 2.5, 3.5, 4.5, 5.5],
    })))
    setToast('Notenskala wurde für alle Klassen geändert')
  }

  function updateThreshold(index: number, value: number) {
    setClasses((current) => current.map((schoolClass) => {
      const thresholds = [...(schoolClass.gradeThresholds ?? (schoolClass.gradeScale === '0-15' ? [13, 10, 7, 4, 1] : [1.5, 2.5, 3.5, 4.5, 5.5]))] as [number, number, number, number, number]
      thresholds[index] = value
      return { ...schoolClass, gradeThresholds: thresholds }
    }))
  }

  function updateWeightSetting(kind: 'written' | 'oral' | 'other', value: number) {
    updateClass((schoolClass) => ({
      ...schoolClass,
      weightSettings: { written: schoolClass.weightSettings?.written ?? 2, oral: schoolClass.weightSettings?.oral ?? 1, other: schoolClass.weightSettings?.other ?? 1, [kind]: value },
    }))
  }

  function updateParticipationWeight(kind: 'weekly' | 'material' | 'oral', value: number) {
    updateClass((schoolClass) => ({
      ...schoolClass,
      participationWeights: { weekly: 1, material: 1, oral: 1, ...schoolClass.participationWeights, [kind]: value },
    }))
  }

  function applyWeightSetting(kind: 'written' | 'oral' | 'other') {
    updateClass((schoolClass) => ({
      ...schoolClass,
      assessments: schoolClass.assessments.map((assessment) => {
        const matches = kind === 'written' ? isWrittenAssessment(assessment.category) : kind === 'oral' ? assessment.category === 'Mündlich' : assessment.category === 'Projekt' || assessment.category === 'Sonstiges'
        return matches ? { ...assessment, weight: schoolClass.weightSettings?.[kind] ?? (kind === 'written' ? 2 : 1) } : assessment
      }),
    }))
    setToast('Gewichtung wurde auf vorhandene Leistungen angewendet')
  }

  function updatePercentageThreshold(course: PercentageCourse, index: number, value: number) {
    const bounded = Math.min(100, Math.max(0, value))
    setClasses((currentClasses) => currentClasses.map((schoolClass) => {
      const current = { ...defaultPercentageThresholds, ...schoolClass.percentageThresholds }
      const percentages = { ...current, [course]: [...current[course]] }
      percentages[course][index] = bounded
      return { ...schoolClass, percentageThresholds: percentages }
    }))
  }

  function updateAssessmentWeight(assessmentId: string, weight: number) {
    updateClass((schoolClass) => ({
      ...schoolClass,
      assessments: schoolClass.assessments.map((assessment) => assessment.id === assessmentId ? { ...assessment, weight } : assessment),
    }))
    setToast('Gewichtung wurde aktualisiert')
  }

  function deleteAssessment(id: string, title: string) {
    if (!window.confirm(`„${title}“ und alle zugehörigen Noten wirklich löschen?`)) return
    updateClass((schoolClass) => ({
      ...schoolClass,
      assessments: schoolClass.assessments.filter((item) => item.id !== id),
      students: schoolClass.students.map((student) => {
        const grades = { ...student.grades }
        delete grades[id]
        const taskPoints = { ...student.taskPoints }
        schoolClass.assessments.find((item) => item.id === id)?.tasks?.forEach((task) => delete taskPoints[task.id])
        return { ...student, grades, taskPoints }
      }),
    }))
    setToast('Leistung wurde gelöscht')
  }

  function deleteSelectedStudents() {
    if (!selectedStudentIds.length) return
    if (!window.confirm(`${selectedStudentIds.length} ausgewählte Schüler und alle ihre Noten wirklich löschen?`)) return
    updateClass((schoolClass) => ({ ...schoolClass, students: schoolClass.students.filter((student) => !selectedStudentIds.includes(student.id)) }))
    setToast(`${selectedStudentIds.length} Schüler wurden gelöscht`)
    setSelectedStudentIds([])
  }

  function deleteStudent(id: string, name: string) {
    if (!window.confirm(`${name} und alle Noten wirklich löschen?`)) return
    updateClass((schoolClass) => ({ ...schoolClass, students: schoolClass.students.filter((student) => student.id !== id) }))
    setToast('Schüler wurde entfernt')
  }

  async function connectGoogle() {
    const clientId = googleClientId.trim()
    if (!/^[^\s]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      setGoogleError('Bitte eine gültige Google-OAuth-Client-ID eintragen.')
      return
    }
    setGoogleBusy(true)
    setGoogleError('')
    try {
      localStorage.setItem('notenwerk-google-client-id', clientId)
      await authorizeGoogle(clientId)
      const sheet = await ensureSpreadsheet(spreadsheetId || undefined)
      setSpreadsheetId(sheet.id)
      localStorage.setItem('notenwerk-google-sheet-id', sheet.id)
      let loaded = false
      if (!sheet.created) {
        try {
          const remoteClasses = await downloadFromGoogle(sheet.id)
          if (window.confirm('In Google Sheets liegt bereits ein notenwerk-Datenstand vor.\n\nOK: Cloud-Daten laden und den lokalen Stand ersetzen.\nAbbrechen: Den lokalen Stand nach Google Sheets hochladen.')) {
            setClasses(remoteClasses)
            classesRef.current = remoteClasses
            setActiveClassId((current) => remoteClasses.some((item) => item.id === current) ? current : remoteClasses[0]?.id ?? '')
            loaded = true
          }
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('noch keine notenwerk-Daten')) throw error
        }
      }
      if (!loaded) {
        const syncedAt = await uploadToGoogle(sheet.id, classesRef.current)
        setLastSync(syncedAt)
      } else {
        setLastSync(new Date().toISOString())
      }
      setGoogleConnected(true)
      setToast(sheet.created ? 'Google-Tabelle erstellt und Daten synchronisiert' : 'Google Sheets wurde verbunden')
    } catch (error) {
      setGoogleError(error instanceof Error ? error.message : 'Google-Verbindung fehlgeschlagen.')
    } finally {
      setGoogleBusy(false)
    }
  }

  async function syncGoogleNow() {
    if (!spreadsheetId) return
    setGoogleBusy(true)
    setGoogleError('')
    try {
      const syncedAt = await uploadToGoogle(spreadsheetId, classesRef.current)
      setLastSync(syncedAt)
      setToast('Alle Daten wurden mit Google Sheets synchronisiert')
    } catch (error) {
      setGoogleError(error instanceof Error ? error.message : 'Synchronisierung fehlgeschlagen.')
    } finally {
      setGoogleBusy(false)
    }
  }

  async function loadGoogleNow() {
    if (!spreadsheetId || !window.confirm('Den lokalen Datenstand vollständig durch die Google-Sheets-Sicherung ersetzen?')) return
    setGoogleBusy(true)
    setGoogleError('')
    try {
      const remoteClasses = await downloadFromGoogle(spreadsheetId)
      setClasses(remoteClasses)
      classesRef.current = remoteClasses
      setActiveClassId((current) => remoteClasses.some((item) => item.id === current) ? current : remoteClasses[0]?.id ?? '')
      setLastSync(new Date().toISOString())
      setToast('Daten wurden aus Google Sheets geladen')
    } catch (error) {
      setGoogleError(error instanceof Error ? error.message : 'Daten konnten nicht geladen werden.')
    } finally {
      setGoogleBusy(false)
    }
  }

  function disconnectGoogleAccount() {
    disconnectGoogle()
    setGoogleConnected(false)
    setLastSync('')
    setToast('Google-Verbindung getrennt; lokale Daten bleiben erhalten')
  }

  function exportExcel() {
    const rows = activeClass.students.map((student) => {
      const row: Record<string, string | number> = { Name: `${student.lastName}, ${student.firstName}` }
      activeClass.assessments.forEach((assessment) => { row[assessment.title] = student.grades[assessment.id] ?? '' })
      row.Durchschnitt = average(student, activeClass)?.toFixed(2).replace('.', ',') ?? ''
      return row
    })
    const sheet = XLSX.utils.json_to_sheet(rows)
    sheet['!cols'] = [{ wch: 26 }, ...activeClass.assessments.map(() => ({ wch: 24 })), { wch: 16 }]
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, activeClass.name)
    XLSX.writeFile(workbook, `Notenwerk_${activeClass.name.replaceAll(' ', '_')}.xlsx`)
    setExportOpen(false)
    setToast('Excel-Datei wurde erstellt')
  }

  function exportPDF(assessmentId?: string) {
    const assessmentsToPrint = assessmentId ? activeClass.assessments.filter((assessment) => assessment.id === assessmentId) : activeClass.assessments
    const selectedAssessment = assessmentId ? assessmentsToPrint[0] : null
    const doc = new jsPDF({ orientation: assessmentsToPrint.length > 4 ? 'landscape' : 'portrait' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(18)
    doc.text(selectedAssessment ? `Notenwerk – Notenspiegel: ${selectedAssessment.title}` : 'Notenwerk – Notenübersicht', 14, 18)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(11)
    doc.text(`${activeClass.name} · ${activeClass.subject} · ${activeClass.schoolYear}`, 14, 26)
    autoTable(doc, {
      startY: 34,
      head: [['Name', ...assessmentsToPrint.map((item) => item.title), 'Schnitt']],
      body: activeClass.students.map((student) => [
        `${student.lastName}, ${student.firstName}`,
        ...assessmentsToPrint.map((assessment) => student.grades[assessment.id]?.toFixed(1).replace('.', ',') ?? '–'),
        formatAverage(selectedAssessment ? (student.grades[selectedAssessment.id] ?? null) : average(student, activeClass)),
      ]),
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [0, 100, 230] },
      columnStyles: { 0: { fontStyle: 'bold' } },
    })
    doc.save(`Notenwerk_${activeClass.name.replaceAll(' ', '_')}${selectedAssessment ? `_${selectedAssessment.title.replaceAll(' ', '_')}` : ''}.pdf`)
    setExportOpen(false)
    setToast('PDF-Datei wurde erstellt')
  }

  const makeDistribution = (values: number[]) => activeClass.gradeScale === '0-15' ? [
    { label: '13–15', count: values.filter((value) => value >= 13).length, color: 'good' },
    { label: '10–12', count: values.filter((value) => value >= 10 && value < 13).length, color: 'good' },
    { label: '7–9', count: values.filter((value) => value >= 7 && value < 10).length, color: 'medium' },
    { label: '4–6', count: values.filter((value) => value >= 4 && value < 7).length, color: 'risk' },
    { label: '0–3', count: values.filter((value) => value < 4).length, color: 'risk' },
  ] : [
    { label: '1–2', count: values.filter((value) => value <= 2).length, color: 'good' },
    { label: '2–3', count: values.filter((value) => value > 2 && value <= 3).length, color: 'good' },
    { label: '3–4', count: values.filter((value) => value > 3 && value <= 4).length, color: 'medium' },
    { label: '4–5', count: values.filter((value) => value > 4 && value <= 5).length, color: 'risk' },
    { label: '5–6', count: values.filter((value) => value > 5).length, color: 'risk' },
  ]
  const distribution = makeDistribution(validAverages)

  const isCourseClass = activeClass.students.some((student) => effectiveCourse(student) !== 'V')
  const gkStudents = activeClass.students.filter((student) => effectiveCourse(student) === 'GK')
  const ekStudents = activeClass.students.filter((student) => effectiveCourse(student) === 'EK')
  const writtenAssessments = activeClass.assessments.filter((assessment) => isWrittenAssessment(assessment.category))
  const writtenClassAverage = (() => {
    let sum = 0
    let weight = 0
    writtenAssessments.forEach((assessment) => activeClass.students.forEach((student) => {
      const grade = student.grades[assessment.id]
      if (typeof grade === 'number') {
        sum += grade * assessment.weight
        weight += assessment.weight
      }
    }))
    return weight ? sum / weight : null
  })()
  const assessmentMean = (assessmentId: string, course?: 'GK' | 'EK') => {
    const students = course ? activeClass.students.filter((student) => effectiveCourse(student) === course) : activeClass.students
    const grades = students.map((student) => student.grades[assessmentId]).filter((grade): grade is number => typeof grade === 'number')
    return grades.length ? grades.reduce((sum, grade) => sum + grade, 0) / grades.length : null
  }
  const distributionFor = (course?: 'GK' | 'EK') => {
    const students = course ? activeClass.students.filter((student) => effectiveCourse(student) === course) : activeClass.students
    const values = students.map((student) => average(student, activeClass)).filter((value): value is number => value !== null)
    return {
      total: values.length,
      values: makeDistribution(values),
    }
  }

  const currentHour = new Date().getHours()
  const greeting = currentHour < 11 ? 'Guten Morgen!' : currentHour < 18 ? 'Guten Tag!' : 'Guten Abend!'

  const renderOverview = () => (
    <>
      <div className="page-heading">
        <div><h1>{greeting}</h1><p>Hier ist der aktuelle Stand deiner Klasse {activeClass.name}.</p></div>
        <button className="primary-button" onClick={() => setModal('assessment')}><Plus size={18} /> Schriftliche Leistung hinzufügen</button>
      </div>
      <div className="metric-grid three">
        <Metric icon={Users} label="Schüler" value={String(activeClass.students.length)} note={isCourseClass ? `${gkStudents.length} GK-Schüler · ${ekStudents.length} EK-Schüler` : `in ${activeClass.name}`} />
        <Metric icon={TrendingUp} label="Klassenschnitt" value={formatAverage(writtenClassAverage)} note="Alle schriftlichen Arbeiten" accent />
        <Metric icon={BookOpen} label="Schriftliche Arbeiten" value={String(writtenAssessments.length)} note="Bisher angelegte Klassenarbeiten" />
      </div>
      <div className="overview-grid">
        <section className="panel distribution-panel">
          <div className="section-heading"><div><h2>Notenverteilung</h2><p>{isCourseClass ? 'Getrennte Auswertung für GK und EK' : 'Durchschnitte aller Schüler'}</p></div><button className="text-button" onClick={() => setView('analytics')}>Details <BarChart3 size={16} /></button></div>
          {isCourseClass ? <div className="course-distributions">
            {(['GK', 'EK'] as const).map((course) => { const data = distributionFor(course); return <div className="course-chart" key={course}><h3><span className={`course-dot course-${course.toLowerCase()}`} />{course}<small>{data.total} Schüler</small></h3><Distribution distribution={data.values} total={data.total} /></div> })}
          </div> : <Distribution distribution={distribution} total={validAverages.length} />}
        </section>
        <section className="panel quick-panel">
          <div className="section-heading"><div><h2>Schnellzugriff</h2><p>Direkt weiterarbeiten</p></div></div>
          <button onClick={() => setView('gradebook')}><BookOpen size={20} /><span><strong>Noten eintragen</strong><small>Zum Notenbuch der {activeClass.name}</small></span></button>
          <button onClick={() => setModal('student')}><UserPlus size={20} /><span><strong>Schüler hinzufügen</strong><small>Klasse erweitern</small></span></button>
        </section>
      </div>
      <section className="panel recent-panel">
        <div className="section-heading"><div><h2>Bisherige Klassenarbeiten und Lernzielkontrollen</h2><p>Themen und Durchschnitte der schriftlichen Arbeiten</p></div></div>
        {writtenAssessments.length > 0 && (isCourseClass ? <div className="course-average-header"><span></span><span>Ø GK</span><span>Ø EK</span><span></span></div> : <div className="single-average-header"><span>Ø</span><span></span></div>)}
        {writtenAssessments.length ? [...writtenAssessments].sort((a, b) => a.date.localeCompare(b.date)).map((assessment) => {
          const grades = activeClass.students.map((student) => student.grades[assessment.id]).filter((grade): grade is number => typeof grade === 'number')
          return <div className={`recent-row ${isCourseClass ? 'course-row' : ''}`} key={assessment.id}><span className="date-tile">{new Date(`${assessment.date}T12:00:00`).getDate()}<small>{new Intl.DateTimeFormat('de-DE', { month: 'short' }).format(new Date(`${assessment.date}T12:00:00`))}</small></span><div><strong>{assessment.title}</strong><small>{assessment.category} · {grades.length} eingetragene Noten</small></div>{isCourseClass ? <><strong className="numeric course-mean gk">{formatAverage(assessmentMean(assessment.id, 'GK'))}</strong><strong className="numeric course-mean ek">{formatAverage(assessmentMean(assessment.id, 'EK'))}</strong></> : <strong className="numeric">{formatAverage(assessmentMean(assessment.id))}</strong>}<button className="row-print" onClick={() => exportPDF(assessment.id)} title={`Notenspiegel für ${assessment.title} drucken`}><FileText size={16} /><span>Notenspiegel drucken</span></button></div>
        }) : <EmptyState text="Noch keine schriftlichen Arbeiten angelegt." action={() => setModal('assessment')} actionLabel="Erste Klassenarbeit anlegen" />}
      </section>
    </>
  )

  const renderGradeScheme = () => {
    const scale = activeClass.gradeScale ?? '1-6'
    const thresholds = activeClass.gradeThresholds ?? (scale === '0-15' ? [13, 10, 7, 4, 1] : [1.5, 2.5, 3.5, 4.5, 5.5])
    const percentages = { ...defaultPercentageThresholds, ...activeClass.percentageThresholds }
    const labels = ['Sehr gut', 'Gut', 'Befriedigend', 'Ausreichend', 'Mangelhaft']
    const gradeMatch = activeClass.name.match(/\d+/)
    const classYear = gradeMatch ? Number(gradeMatch[0]) : null
    const hasCourses = activeClass.students.some((student) => effectiveCourse(student) !== 'V')
    const assignedKey = classYear === 5 || classYear === 6 ? 'G-Kurs' : classYear === 10 ? 'Abschlussprüfung' : hasCourses ? 'GK/EK nach Schülerkurs' : 'V-Kurs'
    const courseLabels: Record<PercentageCourse, string> = { V: 'V-Kurs', GK: 'G-Kurs (GK)', EK: 'E-Kurs (EK)', Abschluss: 'Abschlussprüfung' }
    return <>
      <div className="page-heading"><div><span className="eyebrow">GLOBAL FÜR ALLE KLASSEN</span><h1>Notenschlüssel</h1><p>Die Notenschlüssel und Grenzen gelten gemeinsam für alle Klassen und Kurse.</p></div></div>
      <section className="panel settings-panel">
        <div className="section-heading"><div><h2>Prozentuale Grenzen für die Noten 1–6</h2><p>Mindestprozentzahl je Note – die oberen Bereichsgrenzen ergeben sich automatisch</p></div></div>
        <div className="course-thresholds four-keys">{(['V', 'GK', 'EK', 'Abschluss'] as const).map((course) => <div className={`course-threshold-card course-border-${course.toLowerCase()}`} key={course}><h3>{courseLabels[course]}</h3>{percentages[course].map((value, index) => { const upper = index === 0 ? 100 : percentages[course][index - 1] - 1; return <label key={index}><span>Note {index + 1}<small>{value}–{upper} %</small></span><span className="percent-input"><input type="number" min="0" max="100" step="1" value={value} onChange={(event) => updatePercentageThreshold(course, index, Number(event.target.value))} aria-label={`Prozentgrenze ${courseLabels[course]} Note ${index + 1}`} /><span>%</span></span></label> })}</div>)}</div>
        <div className="settings-note">Änderungen an diesen Notenschlüsseln werden sofort für alle Klassen gespeichert.</div>
      </section>
      <section className="panel settings-panel assignment-panel">
        <div className="section-heading"><div><h2>Automatische Anwendung</h2><p>Für {activeClass.name}: <strong>{assignedKey}</strong></p></div></div>
        <div className="assignment-rules"><span><strong>5. und 6. Klasse</strong>G-Kurs</span><span><strong>10. Schuljahr</strong>Abschlussprüfung</span><span><strong>Übrige Kurse mit GK/EK</strong>Schlüssel nach Schülerkurs</span><span><strong>Übrige ohne GK/EK</strong>V-Notenschlüssel</span></div>
      </section>
      <section className="panel settings-panel">
        <div className="section-heading"><div><h2>Notenskala und Notengrenzen</h2><p>{scale === '0-15' ? 'Mindestpunktzahl für die jeweilige Beurteilung' : 'Maximaler Durchschnitt für die jeweilige Beurteilung'} · global für alle Klassen</p></div></div>
        <label className="settings-label">Verwendetes System<select value={scale} onChange={(event) => updateGradeScale(event.target.value as GradeScale)}><option value="1-6">Deutsche Noten 1–6</option><option value="0-15">Oberstufenpunkte 0–15</option></select></label>
        <div className="settings-note">Beim Wechsel werden die Standardgrenzen des neuen Systems geladen. Bereits eingetragene Noten werden nicht umgerechnet.</div>
        <div className="threshold-list">{labels.map((label, index) => <label key={label}><span><strong className={`threshold-tone-${index}`}>{label}</strong><small>{scale === '0-15' ? `ab ${thresholds[index]} Punkten` : `bis ${String(thresholds[index]).replace('.', ',')}`}</small></span><input type="number" step={scale === '0-15' ? 1 : 0.1} min={scale === '0-15' ? 0 : 1} max={scale === '0-15' ? 15 : 6} value={thresholds[index]} onChange={(event) => updateThreshold(index, Number(event.target.value))} aria-label={`Notengrenze ${label}`} /></label>)}</div>
      </section>
    </>
  }

  const renderWeighting = () => {
    const written = activeClass.weightSettings?.written ?? 2
    const oral = activeClass.weightSettings?.oral ?? 1
    const other = activeClass.weightSettings?.other ?? 1
    const writtenAssessments = activeClass.assessments.filter((item) => isWrittenAssessment(item.category))
    const options = () => weightOptions.map((weight) => <option value={weight} key={weight}>{String(weight).replace('.', ',')}×</option>)
    return <>
      <div className="page-heading"><div><span className="eyebrow">{activeClass.name.toUpperCase()}</span><h1>Gewichtung</h1><p>Alle schriftlichen Arbeiten und die Gewichtungen der aktiven Klasse auf einen Blick.</p></div></div>
      <section className="panel settings-panel weighting-panel">
        <div className="section-heading"><div><h2>Schriftliche Leistungen</h2><p>Individuelle schriftliche Gewichtung sowie Standards für Mündliches und Sonstiges</p></div><Scale size={20} /></div>
        {writtenAssessments.length ? <div className="weighting-table-wrap"><table className="weighting-table"><thead><tr><th>Schriftliche Arbeit</th><th>Schriftlich</th><th>Mündliche Mitarbeit</th><th>Sonstiges</th></tr></thead><tbody>{writtenAssessments.map((assessment) => <tr key={assessment.id}><td><strong>{assessment.title}</strong><small>{assessment.category} · {formatDate(assessment.date)}</small></td><td><select value={assessment.weight} onChange={(event) => updateAssessmentWeight(assessment.id, Number(event.target.value))} aria-label={`Schriftliche Gewichtung für ${assessment.title}`}>{options()}</select></td><td><select value={oral} onChange={(event) => updateWeightSetting('oral', Number(event.target.value))} aria-label={`Mündliche Gewichtung bei ${assessment.title}`}>{options()}</select></td><td><select value={other} onChange={(event) => updateWeightSetting('other', Number(event.target.value))} aria-label={`Sonstige Gewichtung bei ${assessment.title}`}>{options()}</select></td></tr>)}</tbody></table></div> : <EmptyState text="Noch keine schriftlichen Arbeiten angelegt." action={() => setModal('assessment')} actionLabel="Schriftliche Leistung hinzufügen" />}
        <div className="weighting-actions"><label className="settings-label">Standard schriftlich<select value={written} onChange={(event) => updateWeightSetting('written', Number(event.target.value))}>{options()}</select></label><button className="secondary-button" onClick={() => applyWeightSetting('written')}>Schriftlichen Standard auf alle anwenden</button><button className="secondary-button" onClick={() => applyWeightSetting('oral')}>Mündlichen Standard anwenden</button><button className="secondary-button" onClick={() => applyWeightSetting('other')}>Sonstigen Standard anwenden</button></div>
      </section>
      <section className="panel settings-panel weighting-panel participation-weighting-panel">
        <div className="section-heading"><div><h2>Mündliche Mitarbeit</h2><p>Separate Gewichtung der Einträge in der akkumulierten Mitarbeitsnote</p></div><ParticipationIcon size={22} /></div>
        <div className="participation-weight-grid">{([['weekly', 'Wochenplan'], ['material', 'Fehlendes Material'], ['oral', 'Mündliche Mitarbeit']] as const).map(([kind, label]) => <label className="settings-label" key={kind}>{label}<select value={activeClass.participationWeights?.[kind] ?? 1} onChange={(event) => updateParticipationWeight(kind, Number(event.target.value))} aria-label={`Gewichtung ${label}`}>{options()}</select></label>)}</div>
        <div className="settings-note">0× schließt die jeweilige Mitarbeitsart von der Berechnung aus. Sind alle drei Gewichtungen 0×, wird keine akkumulierte Note berechnet.</div>
      </section>
      <div className="settings-note standalone">Mündliche Mitarbeit und Sonstiges besitzen jeweils eine klassenweite Standardgewichtung. Die schriftliche Gewichtung kann pro Arbeit abweichen.</div>
    </>
  }

  const selectedAssessment = activeClass.assessments.find((assessment) => assessment.id === expandedAssessmentId && isWrittenAssessment(assessment.category))
  const gradebookColumns = (selectedAssessment?.tasks ?? []).filter((task) => task.name.trim() && task.maxPoints > 0)
  const formatPoints = (value: number) => value.toFixed(1).replace('.', ',')
  const tendencyGrade = (student: Student, assessment: Assessment) => {
    const result = calculateTaskResult(activeClass, student, assessment)
    if (result.grade === null || result.percentage === null) return { text: '–', grade: null }
    if (!result.thresholds) return { text: String(result.grade), grade: result.grade }
    const lower = result.thresholds[result.grade - 1]
    const upper = result.grade === 1 ? 100 : result.thresholds[result.grade - 2]
    const position = upper === lower ? 0.5 : (Math.min(100, result.percentage) - lower) / (upper - lower)
    const tendency = position >= 2 / 3 ? '+' : position <= 1 / 3 ? '−' : ''
    return { text: `${result.grade}${result.grade === 6 ? '' : tendency}`, grade: result.grade }
  }
  const regularMaximumPoints = gradebookColumns.filter((task) => !task.bonus).reduce((sum, task) => sum + task.maxPoints, 0)

  const renderParticipation = () => {
    const records = participationRecordsFor(activeClass)
    const students = [...activeClass.students].sort((a, b) => a.lastName.localeCompare(b.lastName, 'de') || a.firstName.localeCompare(b.firstName, 'de'))
    const classYear = Number(activeClass.name.match(/\d+/)?.[0])
    const weeklyAvailable = /M/i.test(activeClass.name) && classYear !== 9 && classYear !== 10
    const weights = { weekly: 1, material: 1, oral: 1, ...activeClass.participationWeights }
    const typeWeight = (type: ParticipationType) => type === 'Wochenplan' ? weights.weekly : type === 'Fehlendes Material' ? weights.material : weights.oral
    const accumulatedGrade = (studentId: string) => {
      const studentRecords = records.filter((record) => record.studentId === studentId)
      if (!studentRecords.length) return 4
      const totalWeight = studentRecords.reduce((sum, record) => sum + typeWeight(record.type), 0)
      if (!totalWeight) return null
      return studentRecords.reduce((sum, record) => sum + record.grade * typeWeight(record.type), 0) / totalWeight
    }
    const closeForm = () => {
      setParticipationFormOpen(false)
      setParticipationStudents([])
    setParticipationStudentOpen(false)
      setParticipationType('Mündliche Mitarbeit')
      setParticipationWeeklyName('')
      setParticipationDetail('')
    }
    const renderRecordCell = (student: Student, type: ParticipationType) => {
      const typeRecords = records.filter((record) => record.studentId === student.id && record.type === type)
      if (!typeRecords.length) return <span className="participation-empty">–</span>
      return <div className="participation-records">{typeRecords.map((record) => { const tone = Math.max(1, Math.min(6, Math.round(record.grade))); return <div className="participation-record" key={record.id}><span><strong>{record.detail} <b className={`participation-grade-note tone-${tone}`}><i>(</i>{String(record.grade).replace('.', ',')}<i>)</i></b></strong><small>{formatDate(record.date)}</small></span><button onClick={() => deleteParticipationRecord(record.id)} aria-label={`${record.detail} für ${student.firstName} ${student.lastName} löschen`} title="Eintrag löschen"><X size={13} /></button></div> })}</div>
    }
    return <>
      <div className="page-heading"><div><h1>Mitarbeit</h1><p>Wochenpläne, fehlendes Material und mündliche Mitarbeit fortlaufend dokumentieren.</p></div><button className="primary-button" onClick={() => setParticipationFormOpen((open) => !open)} aria-expanded={participationFormOpen}><Plus size={18} /> Mitarbeitseintrag hinzufügen</button></div>
      {participationFormOpen && <section className="panel participation-form-panel"><form onSubmit={addParticipation} className="participation-form"><div className="participation-form-grid"><div className="participation-student-field"><span>Schüler</span><div className="participation-student-picker"><button type="button" className="participation-student-trigger" onClick={() => setParticipationStudentOpen((open) => !open)} aria-expanded={participationStudentOpen}><span>{participationStudents.length ? `${participationStudents.length} Schüler ausgewählt` : 'Schüler auswählen'}</span><ChevronDown size={17} /></button>{participationStudentOpen && <div className="participation-student-options">{students.map((student) => <label key={student.id}><input type="checkbox" checked={participationStudents.includes(student.id)} onChange={() => setParticipationStudents((current) => current.includes(student.id) ? current.filter((id) => id !== student.id) : [...current, student.id])} /><span>{student.lastName}, {student.firstName}</span></label>)}</div>}</div></div><label>Mitarbeitsart<select value={participationType} onChange={(event) => { setParticipationType(event.target.value as ParticipationType); setParticipationDetail(''); setParticipationWeeklyName('') }}>{weeklyAvailable && <option>Wochenplan</option>}<option>Fehlendes Material</option><option>Mündliche Mitarbeit</option></select></label>{participationType === 'Wochenplan' && <><label>Wochenplan-Nr<input value={participationWeeklyName} onChange={(event) => setParticipationWeeklyName(event.target.value)} placeholder="Nummer oder Name" required autoFocus /></label><label>Eintrag<select value={participationDetail} onChange={(event) => setParticipationDetail(event.target.value)} required><option value="">Bitte auswählen</option><option>Erledigt</option><option>Teilweise erledigt</option><option>Nicht erledigt</option></select></label></>}{participationType === 'Fehlendes Material' && <label className="participation-detail-field">Eintrag<input value={participationDetail} onChange={(event) => setParticipationDetail(event.target.value)} placeholder="Welches Material fehlt?" required autoFocus /></label>}{participationType === 'Mündliche Mitarbeit' && <label>Eintrag<select value={participationDetail} onChange={(event) => setParticipationDetail(event.target.value)} required autoFocus><option value="">Bitte auswählen</option><option>Sehr gut</option><option>Gut</option><option>befriedigend</option><option>mangelhaft</option></select></label>}</div><div className="participation-form-actions"><button className="primary-button participation-save-button" type="submit"><Check size={17} /> Speichern</button><button className="secondary-button participation-discard-button" type="button" onClick={closeForm}><X size={17} /> Verwerfen</button></div></form></section>}
      <div className="gradebook-summary"><span><Users size={17} /> {activeClass.students.length} Schüler</span><span><ParticipationIcon size={17} /> {records.length} Einträge</span><span>Ohne Einträge: Note (4)</span></div>
      <section className="panel gradebook-panel participation-panel">
        <div className="section-heading"><div><h2>Mitarbeitsübersicht</h2><p>{activeClass.name} · Die akkumulierte Mitarbeitsnote berücksichtigt die Gewichtungen der Mitarbeitsarten.</p></div></div>
        {students.length ? <div className="table-scroll"><table className={`grade-table participation-overview-table ${weeklyAvailable ? '' : 'without-weekly'}`}><thead><tr><th className="student-column">Schüler</th>{weeklyAvailable && <th>Wochenplan</th>}<th>Fehlendes Material</th><th>Mitarbeit</th><th className="average-column">Akkumulierte<br />Mitarbeitsnote</th></tr></thead><tbody>{students.map((student, index) => { const accumulated = accumulatedGrade(student.id); return <tr key={student.id}><td className="student-cell"><span className="student-index">{String(index + 1).padStart(2, '0')}</span><span className="avatar">{student.firstName[0]}{student.lastName[0]}</span><div><strong>{student.lastName}, {student.firstName}</strong><small>{effectiveCourse(student) === 'V' ? '' : effectiveCourse(student)}</small></div></td>{weeklyAvailable && <td>{renderRecordCell(student, 'Wochenplan')}</td>}<td>{renderRecordCell(student, 'Fehlendes Material')}</td><td>{renderRecordCell(student, 'Mündliche Mitarbeit')}</td><td className="average-cell"><span className={`average-badge ${gradeColor(accumulated, activeClass)}`}>{formatAverage(accumulated)}</span></td></tr> })}</tbody></table></div> : <EmptyState text="Diese Klasse hat noch keine Schüler." action={() => setModal('student')} actionLabel="Ersten Schüler hinzufügen" />}
      </section>
    </>
  }

  const renderGradebook = () => (
    <>
      <div className="page-heading gradebook-heading">
        <div><h1>Notenbuch</h1><p>Aufgaben und Punkte verwalten – die Note der Arbeit wird automatisch berechnet.</p></div>
        <button className="primary-button" onClick={() => setModal('assessment')}><Plus size={18} /> Leistung hinzufügen</button>
      </div>
      <div className="gradebook-summary">
        <span><Users size={17} /> {activeClass.students.length} Schüler</span><span><BookOpen size={17} /> {activeClass.assessments.length} Leistungen</span><span className="summary-average">Ø {formatAverage(classAverage(activeClass))}</span>
      </div>
      {writtenAssessments.length > 0 && <section className="written-work-section" aria-label="Schriftliche Arbeiten">
        <div className="written-work-heading"><div><h2>Schriftliche Arbeiten</h2><p>Arbeit auswählen und Aufgaben mit Höchstpunkten festlegen</p></div><span>{writtenAssessments.length}</span></div>
        <div className="written-work-list">{writtenAssessments.map((assessment) => {
          const expanded = expandedAssessmentId === assessment.id
          const taskCount = (assessment.tasks ?? []).filter((task) => task.name.trim() && task.maxPoints > 0).length
          return <article className={`written-work-item ${expanded ? 'expanded' : ''}`} key={assessment.id}>
            <button className="written-work-trigger" onClick={() => toggleAssessmentTasks(assessment.id)} aria-expanded={expanded} aria-controls={`aufgaben-${assessment.id}`}><span><small>{assessment.category}</small><strong>{assessment.title}</strong></span><span className="task-count">{taskCount} {taskCount === 1 ? 'Aufgabe' : 'Aufgaben'}</span><ChevronDown size={19} /></button>
            {expanded && <div className="task-editor" id={`aufgaben-${assessment.id}`}>
              <div className="task-editor-labels"><span>Aufgabenname</span><span>Punkte</span><span>Zusatz</span><span></span></div>
              {(assessment.tasks ?? []).map((task) => <div className={`task-editor-row ${task.bonus ? 'is-bonus' : ''}`} key={task.id}>
                <input value={task.name} onChange={(event) => updateAssessmentTask(assessment.id, task.id, 'name', event.target.value)} placeholder="z. B. Aufgabe 1" aria-label={`Aufgabenname für ${assessment.title}`} />
                <input type="number" min="0" step="0.5" value={task.maxPoints || ''} onChange={(event) => updateAssessmentTask(assessment.id, task.id, 'maxPoints', Number(event.target.value))} placeholder="0" aria-label={`Höchstpunktzahl für ${task.name || 'Aufgabe'}`} />
                <select className={`bonus-select ${task.bonus ? 'yes' : 'no'}`} value={task.bonus ? 'yes' : 'no'} onChange={(event) => updateAssessmentTask(assessment.id, task.id, 'bonus', event.target.value === 'yes')} aria-label={`Zusatz für ${task.name || 'Aufgabe'}`}><option value="no">✕</option><option value="yes">✓</option></select>
                <button className="icon-button subtle-danger" onClick={() => deleteAssessmentTask(assessment.id, task.id)} aria-label={`${task.name || 'Aufgabe'} löschen`} title="Aufgabe löschen"><Trash2 size={16} /></button>
              </div>)}
              <div className="task-editor-actions"><button className="secondary-button" onClick={() => addAssessmentTask(assessment.id)}><Plus size={17} /> Aufgaben hinzufügen</button><button className="text-button danger-text" onClick={() => deleteAssessment(assessment.id, assessment.title)}><Trash2 size={15} /> Arbeit löschen</button></div>
              <p className="task-editor-hint">Zusatzaufgaben erhalten eine hellblaue Spalte. Ihre Punkte zählen zum Ergebnis, aber nicht zur regulären Höchstpunktzahl.</p>
            </div>}
          </article>
        })}</div>
      </section>}
      {selectedAssessment && <section className="gradebook-panel">
        <div className="table-toolbar">
          <label className="search-field"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Schüler suchen …" aria-label="Schüler suchen" />{search && <button onClick={() => setSearch('')} aria-label="Suche löschen"><X size={16} /></button>}</label>
          <span className="save-hint"><Check size={15} /> Änderungen automatisch gespeichert</span>
        </div>
        <div className="table-scroll">
          <table className="grade-table task-grade-table">
            <thead><tr><th className="student-column">Schüler</th>{gradebookColumns.map((task) => <th className={task.bonus ? 'bonus-column' : ''} key={task.id}><div className="assessment-head task-head"><strong title={task.name}>{task.name}</strong><small>{String(task.maxPoints).replace('.', ',')}</small></div></th>)}<th className="average-column total-column"><span className="result-heading"><Sigma size={17} /><span>Erreichte Punktzahl aus:<small>{formatPoints(regularMaximumPoints)}</small></span></span></th><th className="average-column note-column"><span className="result-heading"><GraduationCap size={18} /><span>Note</span></span></th></tr></thead>
            <tbody>{filteredStudents.map((student, index) => {
              const totalPoints = gradebookColumns.reduce((sum, task) => sum + (student.taskPoints?.[task.id] ?? 0), 0)
              const note = tendencyGrade(student, selectedAssessment)
              return <tr key={student.id}><td className="student-cell"><span className="student-index">{String(index + 1).padStart(2, '0')}</span><span className="avatar">{student.firstName[0]}{student.lastName[0]}</span><div><strong>{student.lastName}, {student.firstName}</strong><small>{effectiveCourse(student) === 'V' ? '' : effectiveCourse(student)}</small></div></td>{gradebookColumns.map((task) => <td className={task.bonus ? 'bonus-column' : ''} key={task.id}><input className="grade-input points-input" type="number" min="0" max={task.maxPoints} step="0.5" value={student.taskPoints?.[task.id] ?? ''} onChange={(event) => updateTaskPoints(student.id, selectedAssessment.id, task.id, event.target.value)} aria-label={`Punkte für ${student.firstName} ${student.lastName}, ${task.name}`} placeholder="–" /></td>)}<td className="average-cell total-cell"><span className="total-points">{formatPoints(totalPoints)}</span></td><td className="average-cell"><span className={`average-badge ${gradeColor(note.grade, activeClass)}`}>{note.text}</span></td></tr>
            })}</tbody>
          </table>
          {!gradebookColumns.length && <div className="empty-task-table">Lege oben eine Aufgabe mit Namen und Höchstpunktzahl an. Die Tabelle wird automatisch erzeugt.</div>}
          {!filteredStudents.length && <EmptyState text={search ? 'Kein Schüler entspricht deiner Suche.' : 'Diese Klasse hat noch keine Schüler.'} action={() => search ? setSearch('') : setModal('student')} actionLabel={search ? 'Suche zurücksetzen' : 'Ersten Schüler hinzufügen'} />}
        </div>
        <div className="table-legend"><span>{selectedAssessment.title}</span><span>Die Punktesumme enthält geschenkte Zusatzpunkte; die Note erscheint erst nach einer Punkteeingabe.</span></div>
      </section>}
    </>
  )

  const renderStudents = () => {
    const allFilteredSelected = filteredStudents.length > 0 && filteredStudents.every((student) => selectedStudentIds.includes(student.id))
    return <>
      <div className="page-heading"><div><span className="eyebrow">{activeClass.name.toUpperCase()} · SCHULJAHR {currentSchoolYear()}</span><h1>Schüler</h1><p>Verwalte die Kurszugehörigkeit und dokumentiere Kurswechsel.</p></div><button className="primary-button" onClick={() => setModal('student')}><UserPlus size={18} /> Schüler hinzufügen</button></div>
      <div className="student-toolbar"><label className="search-field"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name suchen …" aria-label="Schüler suchen" /></label><div className="selection-actions"><span>{selectedStudentIds.length ? `${selectedStudentIds.length} ausgewählt` : `${filteredStudents.length} von ${activeClass.students.length}`}</span>{selectedStudentIds.length > 0 && <button className="danger-button" onClick={deleteSelectedStudents}><Trash2 size={16} /> Ausgewählte löschen</button>}</div></div>
      <section className="student-list">
        <div className="student-list-header"><span className="student-select-heading"><input type="checkbox" checked={allFilteredSelected} onChange={() => setSelectedStudentIds(allFilteredSelected ? selectedStudentIds.filter((id) => !filteredStudents.some((student) => student.id === id)) : [...new Set([...selectedStudentIds, ...filteredStudents.map((student) => student.id)])])} aria-label="Alle angezeigten Schüler auswählen" />Name</span><span>Kurs</span><span>Kurswechsel</span><span>Datum des Wechsels</span><span></span></div>
        {filteredStudents.map((student) => {
          const course = student.course ?? 'V'
          const selected = selectedStudentIds.includes(student.id)
          return <div className={`student-list-row ${selected ? 'selected' : ''}`} key={student.id}>
            <div className="student-name"><input className="student-checkbox" type="checkbox" checked={selected} onChange={() => setSelectedStudentIds((current) => selected ? current.filter((id) => id !== student.id) : [...current, student.id])} aria-label={`${student.firstName} ${student.lastName} auswählen`} /><span className="avatar">{student.firstName[0]}{student.lastName[0]}</span><div><strong>{student.lastName}, {student.firstName}</strong><small>{activeClass.name} · {activeClass.subject}</small></div></div>
            <label className="course-field"><span>Kurs</span><select className={`course-select course-${course.toLowerCase()}`} value={course} disabled={Boolean(student.courseChange)} onChange={(event) => updateCourse(student.id, event.target.value as Course)} aria-label={`Kurs für ${student.firstName} ${student.lastName}`}><option value="V">V</option><option value="GK">GK</option><option value="EK">EK</option></select></label>
            <label className="change-field"><span>Kurswechsel</span><select className={`course-select change-select ${student.courseChange ? `course-${student.courseChange.toLowerCase()}` : ''}`} value={student.courseChange ?? ''} onChange={(event) => updateCourseChange(student.id, event.target.value)} aria-label={`Kurswechsel für ${student.firstName} ${student.lastName}`}><option value="">–</option><option value="GK">GK</option><option value="EK">EK</option></select></label>
            <label className="date-field"><span>Datum des Wechsels</span><input className="change-date" value={student.courseChangeDate ? formatDate(student.courseChangeDate) : ''} placeholder="–" readOnly disabled aria-label={`Datum des Kurswechsels für ${student.firstName} ${student.lastName}`} /></label>
            <button className="icon-button subtle-danger" onClick={() => deleteStudent(student.id, `${student.firstName} ${student.lastName}`)} aria-label={`${student.firstName} ${student.lastName} löschen`} title="Schüler löschen"><Trash2 size={17} /></button>
          </div>
        })}
      </section>
    </>
  }

  const renderAnalytics = () => (
    <>
      <div className="page-heading"><div><span className="eyebrow">LEISTUNGSBILD</span><h1>Auswertung</h1><p>Erkenne Stärken und Förderbedarf auf einen Blick.</p></div><button className="secondary-button" onClick={() => exportPDF()}><FileText size={18} /> Bericht als PDF</button></div>
      <div className="metric-grid three"><Metric icon={TrendingUp} label="Klassenschnitt" value={formatAverage(classAverage(activeClass))} note={gradeLabel(classAverage(activeClass), activeClass)} accent /><Metric icon={GraduationCap} label="Gut oder besser" value={String(goodStudents)} note={`von ${activeClass.students.length} Schülern`} /><Metric icon={Users} label="Förderbedarf" value={String(atRisk)} note="Entsprechend dem aktiven Notenschlüssel" /></div>
      <div className="analytics-grid">
        <section className="panel distribution-panel"><div className="section-heading"><div><h2>Notenverteilung</h2><p>Nach gewichtetem Gesamtdurchschnitt</p></div></div><Distribution distribution={distribution} total={validAverages.length} /></section>
        <section className="panel"><div className="section-heading"><div><h2>Leistungen im Vergleich</h2><p>Klassendurchschnitt je Eintrag</p></div></div><div className="assessment-stats">{activeClass.assessments.map((assessment) => {
          const values = activeClass.students.map((student) => student.grades[assessment.id]).filter((grade): grade is number => typeof grade === 'number')
          const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
          return <div key={assessment.id}><div><strong>{assessment.title}</strong><span>{formatAverage(mean)}</span></div><div className="stat-track"><span style={{ width: `${mean ? (activeClass.gradeScale === '0-15' ? (mean / 15) * 100 : ((6 - mean) / 5) * 100) : 0}%` }} /></div><small>{values.length} eingetragene Noten · {assessment.weight}× gewichtet</small></div>
        })}{!activeClass.assessments.length && <p className="muted">Noch keine Leistungen vorhanden.</p>}</div></section>
      </div>
      <section className="panel attention-panel"><div className="section-heading"><div><h2>Individuelle Übersicht</h2><p>Sortiert nach aktuellem Durchschnitt</p></div></div>{[...activeClass.students].sort((a, b) => activeClass.gradeScale === '0-15' ? (average(b, activeClass) ?? -1) - (average(a, activeClass) ?? -1) : (average(a, activeClass) ?? 7) - (average(b, activeClass) ?? 7)).map((student, index) => { const avg = average(student, activeClass); return <div className="ranking-row" key={student.id}><span>{index + 1}</span><strong>{student.lastName}, {student.firstName}</strong><span className={`status-text ${gradeColor(avg, activeClass)}`}>{gradeLabel(avg, activeClass)}</span><b className="numeric">{formatAverage(avg)}</b></div> })}</section>
    </>
  )

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
        <div className="brand"><button className="mobile-close" onClick={() => setMobileMenu(false)} aria-label="Menü schließen"><X size={20} /></button></div>
        <div className="sidebar-class"><label>Aktive Klasse</label><div className="class-selector"><span style={{ background: activeClass.color }} /><select value={activeClass.id} onChange={(event) => { setActiveClassId(event.target.value); setSearch('') }} aria-label="Aktive Klasse auswählen">{classes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><ChevronDown size={15} /></div><div className="class-management"><button onClick={() => setModal('class')}><Plus size={15} /> Neu</button><button onClick={renameActiveClass} title="Aktive Klasse umbenennen"><Pencil size={14} /> Umbenennen</button><button onClick={deleteActiveClass} title="Aktive Klasse löschen"><Trash2 size={14} /> Löschen</button></div></div>
        <nav className="main-nav" aria-label="Hauptnavigation">{navItems.map((item) => { const Icon = item.icon; return <button className={`nav-${item.id} ${view === item.id ? 'active' : ''}`} key={item.id} onClick={() => { setView(item.id); setMobileMenu(false) }}><Icon size={19} /><span>{item.label}</span>{item.id === 'students' && <small>{activeClass.students.length}</small>}</button> })}</nav>
        <div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={19} /><div><strong>Privat & geschützt</strong><span>Lokal, optional mit Google-Sicherung.</span></div></div><button className="help-link" onClick={() => setModal('help')}><CircleHelp size={18} /> Hilfe & Datenschutz</button><div className="copyright-note">© Notenwerk26 HARBI · Alle Rechte vorbehalten</div></div>
      </aside>
      {mobileMenu && <button className="sidebar-scrim" onClick={() => setMobileMenu(false)} aria-label="Menü schließen" />}
      <main className="main-content">
        <header className="topbar"><img className="topbar-logo" src="/harbi-logo.png" alt="Notenwerk HARBI Logo" /><button className="mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Menü öffnen"><Menu size={22} /></button><div className="breadcrumb"><span>{activeClass.name}</span><span>/</span><strong>{navItems.find((item) => item.id === view)?.label}</strong></div><div className="top-actions"><button className={`cloud-button ${googleConnected ? 'connected' : ''}`} onClick={() => setModal('google')}><Cloud size={17} /><span>{googleConnected ? 'Google verbunden' : 'Google Sheets'}</span></button><span className="local-status"><span /> Lokal gespeichert</span><div className="export-wrap"><button className="secondary-button" onClick={() => setExportOpen(!exportOpen)} aria-expanded={exportOpen}><Download size={17} /> Exportieren <ChevronDown size={15} /></button>{exportOpen && <div className="export-menu"><button onClick={exportExcel}><FileSpreadsheet size={18} /><span><strong>Excel-Datei</strong><small>Notenliste als .xlsx</small></span></button><button onClick={() => exportPDF()}><FileText size={18} /><span><strong>PDF-Dokument</strong><small>Zum Drucken & Teilen</small></span></button></div>}</div></div></header>
        <div className="content-wrap">{view === 'overview' && renderOverview()}{view === 'gradebook' && renderGradebook()}{view === 'students' && renderStudents()}{view === 'participation' && renderParticipation()}{view === 'gradeScheme' && renderGradeScheme()}{view === 'weighting' && renderWeighting()}{view === 'analytics' && renderAnalytics()}</div>
      </main>
      <nav className="mobile-nav" aria-label="Mobile Navigation">{navItems.map((item) => { const Icon = item.icon; return <button className={`nav-${item.id} ${view === item.id ? 'active' : ''}`} key={item.id} onClick={() => setView(item.id)}><Icon size={20} /><span>{item.label}</span></button> })}</nav>

      {modal === 'assessment' && <Modal title="Neue schriftliche Leistung" description={`Eintrag für ${activeClass.name} · ${activeClass.subject}`} onClose={() => setModal(null)}><form onSubmit={addAssessment} className="modal-form"><div className="form-row"><label>Art der schriftlichen Arbeit<select name="category" defaultValue="Klassenarbeit"><option>Klassenarbeit</option><option>Lernzielkontrolle</option><option>Projekt</option><option>Sonstiges</option></select></label><label>Datum<input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label></div><label>Thema<input name="topic" required placeholder="z. B. Satz des Pythagoras" autoFocus /></label><label>Gewichtung<select name="weight" defaultValue={activeClass.weightSettings?.written ?? 2}>{weightOptions.map((weight) => <option value={weight} key={weight}>{String(weight).replace('.', ',')}×</option>)}</select><small>Die Gewichtung bestimmt, wie stark diese Leistung in den Durchschnitt eingeht.</small></label><div className="settings-note">Der Name wird automatisch erzeugt, zum Beispiel „Klassenarbeit Nr.1 (Satz des Pythagoras)“. Die Nummerierung erfolgt für jede Art separat.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(null)}>Abbrechen</button><button className="primary-button" type="submit"><Plus size={17} /> Leistung anlegen</button></div></form></Modal>}
      {modal === 'student' && <Modal title="Schüler hinzufügen" description={`Einzeln oder als komplette Liste in ${activeClass.name}`} onClose={() => setModal(null)}><form onSubmit={addStudent} className="modal-form"><div className="form-row"><label>Nachname<input name="lastName" placeholder="Nachname" autoFocus /></label><label>Vorname<input name="firstName" placeholder="Vorname" /></label></div><div className="form-divider"><span>oder Liste aus Word einfügen</span></div><label>Schülerliste<textarea name="bulk" rows={7} placeholder={'Eine Zeile pro Schüler, zum Beispiel:\nBecker Emma\nFischer, Noah\nHoffmann Mia'} /></label><p className="form-note">Akzeptiert werden „Nachname Vorname“ und „Nachname, Vorname“. Zeilennummern und Aufzählungszeichen werden automatisch entfernt.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(null)}>Abbrechen</button><button className="primary-button" type="submit"><UserPlus size={17} /> Hinzufügen</button></div></form></Modal>}
      {modal === 'class' && <Modal title="Neue Klasse anlegen" description="Erstelle ein eigenes Notenbuch für eine Klasse." onClose={() => setModal(null)}><form onSubmit={addClass} className="modal-form"><div className="form-row"><label>Klassenname<input name="name" required placeholder="z. B. Klasse 9c" autoFocus /></label><label>Fach<input name="subject" required placeholder="z. B. Deutsch" /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(null)}>Abbrechen</button><button className="primary-button" type="submit"><Plus size={17} /> Klasse anlegen</button></div></form></Modal>}
      {modal === 'google' && <Modal title="Google-Sheets-Synchronisierung" description="Automatische Sicherung und Datenabruf über dein eigenes Google-Konto" onClose={() => setModal(null)}><div className="google-sync-content">
        <div className={`google-connection-status ${googleConnected ? 'online' : ''}`}><Cloud size={24} /><div><strong>{googleConnected ? 'Google Sheets ist verbunden' : 'Noch nicht verbunden'}</strong><span>{googleConnected ? 'Änderungen werden automatisch in deine persönliche Tabelle übertragen.' : 'Die lokale Speicherung bleibt auch ohne Google-Verbindung aktiv.'}</span></div></div>
        {!googleConnected && <><label className="settings-label google-client-field">Google-OAuth-Client-ID<input value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} placeholder="….apps.googleusercontent.com" autoComplete="off" spellCheck={false} /></label>
        <details className="google-setup"><summary>Einmalige Einrichtung in Google Cloud anzeigen</summary><ol><li>Öffne die Google Cloud Console und erstelle ein Projekt.</li><li>Aktiviere die <strong>Google Sheets API</strong> und die <strong>Google Drive API</strong>.</li><li>Konfiguriere den OAuth-Zustimmungsbildschirm und hinterlege deine E-Mail-Adresse als Testnutzer.</li><li>Erstelle eine OAuth-Client-ID für eine <strong>Webanwendung</strong>.</li><li>Trage die aktuelle Adresse dieser Anwendung unter „Autorisierte JavaScript-Quellen“ ein, zum Beispiel <code>http://localhost:5173</code> oder die veröffentlichte Adresse.</li><li>Kopiere die Client-ID hier hinein. Ein Client-Secret wird nicht benötigt.</li></ol></details>
        <button className="primary-button full-width" disabled={googleBusy} onClick={connectGoogle}><Cloud size={18} />{googleBusy ? 'Verbindung wird hergestellt …' : 'Mit Google verbinden und Tabelle einrichten'}</button></>}
        {googleConnected && <div className="google-actions"><button className="primary-button" disabled={googleBusy} onClick={syncGoogleNow}><RefreshCw size={17} /> Jetzt synchronisieren</button><button className="secondary-button" disabled={googleBusy} onClick={loadGoogleNow}><CloudDownload size={17} /> Cloud-Daten laden</button><button className="secondary-button" onClick={() => window.open(spreadsheetUrl(spreadsheetId), '_blank', 'noopener,noreferrer')}><ExternalLink size={17} /> Google-Tabelle öffnen</button><button className="text-button danger-text" onClick={disconnectGoogleAccount}>Verbindung trennen</button></div>}
        {lastSync && <p className="google-last-sync">Zuletzt synchronisiert: {new Date(lastSync).toLocaleString('de-DE')}</p>}
        {googleError && <div className="google-error" role="alert">{googleError}</div>}
        <div className="settings-note"><strong>Datenschutz:</strong> Erst nach deiner Freigabe werden Namen, Noten und Klassendaten in eine Tabelle in deinem eigenen Google Drive übertragen. Das Zugriffstoken bleibt nur im Arbeitsspeicher und wird nicht gespeichert. Gib die Tabelle nicht öffentlich frei und prüfe die datenschutzrechtlichen Vorgaben deiner Schule.</div>
      </div></Modal>}
      {modal === 'help' && <Modal title="Hilfe & Datenschutz" onClose={() => setModal(null)}><div className="help-content"><div><ShieldCheck size={22} /><section><h3>Lokal und optional mit Google</h3><p>Alle Klassen, Namen und Noten werden weiterhin lokal in diesem Browser gespeichert. Nur wenn du Google Sheets ausdrücklich verbindest, werden die Daten zusätzlich in dein eigenes Google Drive übertragen.</p></section></div><div><Download size={22} /><section><h3>Regelmäßig sichern</h3><p>Nutze zusätzlich den Excel-Export als Sicherungskopie. Bei aktivierter Google-Synchronisierung kannst du den Cloud-Stand über „Cloud-Daten laden“ wiederherstellen.</p></section></div><div><BookOpen size={22} /><section><h3>So funktioniert die Berechnung</h3><p>Das Notenschlüssel kann pro Klasse auf 1–6 oder 0–15 Punkte eingestellt werden. Der Gesamtdurchschnitt berücksichtigt die Gewichtung jeder Leistung. Leere Felder werden nicht berechnet.</p></section></div><button className="primary-button full-width" onClick={() => setModal(null)}>Verstanden</button></div></Modal>}
      {toast && <div className="toast" role="status"><Check size={18} />{toast}</div>}
    </div>
  )
}

function Metric({ icon: Icon, label, value, note, accent = false }: { icon: typeof Users; label: string; value: string; note: string; accent?: boolean }) {
  return <section className={`metric ${accent ? 'accent' : ''}`}><div className="metric-top"><span>{label}</span><Icon size={19} /></div><strong className="numeric">{value}</strong><small>{note}</small></section>
}

function Distribution({ distribution, total }: { distribution: { label: string; count: number; color: string }[]; total: number }) {
  const max = Math.max(...distribution.map((item) => item.count), 1)
  return <div className="distribution"><div className="bar-chart">{distribution.map((item) => <div className="bar-column" key={item.label}><span className="bar-value">{item.count}</span><div className="bar-track"><span className={item.color} style={{ height: `${Math.max((item.count / max) * 100, item.count ? 8 : 2)}%` }} /></div><strong>{item.label}</strong><small>{total ? Math.round((item.count / total) * 100) : 0}%</small></div>)}</div><div className="chart-caption"><span><i className="good" />Oberer Bereich</span><span><i className="medium" />Mittlerer Bereich</span><span><i className="risk" />Unterer Bereich</span></div></div>
}

function EmptyState({ text, action, actionLabel }: { text: string; action: () => void; actionLabel: string }) {
  return <div className="empty-state"><BookOpen size={28} /><p>{text}</p><button className="text-button" onClick={action}>{actionLabel}</button></div>
}
