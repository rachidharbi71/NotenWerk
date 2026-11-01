import type { SchoolClass, Student } from './types'

export function average(student: Student, schoolClass: SchoolClass): number | null {
  let total = 0
  let weight = 0
  schoolClass.assessments.forEach((assessment) => {
    const grade = student.grades[assessment.id]
    if (typeof grade === 'number') {
      total += grade * assessment.weight
      weight += assessment.weight
    }
  })
  return weight ? total / weight : null
}

export function classAverage(schoolClass: SchoolClass): number | null {
  const values = schoolClass.students.map((student) => average(student, schoolClass)).filter((v): v is number => v !== null)
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export function formatAverage(value: number | null): string {
  return value === null ? '–' : value.toFixed(2).replace('.', ',')
}

export function gradeLabel(value: number | null, schoolClass?: SchoolClass): string {
  if (value === null) return 'Keine Noten'
  const thresholds = schoolClass?.gradeThresholds ?? (schoolClass?.gradeScale === '0-15' ? [13, 10, 7, 4, 1] : [1.5, 2.5, 3.5, 4.5, 5.5])
  if (schoolClass?.gradeScale === '0-15') {
    if (value >= thresholds[0]) return 'Sehr gut'
    if (value >= thresholds[1]) return 'Gut'
    if (value >= thresholds[2]) return 'Befriedigend'
    if (value >= thresholds[3]) return 'Ausreichend'
    if (value >= thresholds[4]) return 'Mangelhaft'
    return 'Förderbedarf'
  }
  if (value <= thresholds[0]) return 'Sehr gut'
  if (value <= thresholds[1]) return 'Gut'
  if (value <= thresholds[2]) return 'Befriedigend'
  if (value <= thresholds[3]) return 'Ausreichend'
  if (value <= thresholds[4]) return 'Mangelhaft'
  return 'Förderbedarf'
}

export function gradeColor(value: number | null, schoolClass?: SchoolClass): string {
  if (value === null) return 'neutral'
  const thresholds = schoolClass?.gradeThresholds ?? (schoolClass?.gradeScale === '0-15' ? [13, 10, 7, 4, 1] : [1.5, 2.5, 3.5, 4.5, 5.5])
  if (schoolClass?.gradeScale === '0-15') {
    if (value >= thresholds[1]) return 'good'
    if (value >= thresholds[3]) return 'medium'
    return 'risk'
  }
  if (value <= thresholds[1]) return 'good'
  if (value <= thresholds[3]) return 'medium'
  return 'risk'
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`))
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}
