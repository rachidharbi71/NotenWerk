export type Category =
  | 'Klassenarbeit'
  | 'Lernzielkontrolle'
  | 'Projekt'
  | 'Sonstiges'
  | 'Schulaufgabe'
  | 'Stegreifaufgabe'
  | 'Mündlich'

export type Course = 'V' | 'GK' | 'EK'
export type CourseChange = 'GK' | 'EK'
export type GradeScale = '1-6' | '0-15'

export interface AssessmentTask {
  id: string
  name: string
  maxPoints: number
  bonus: boolean
}

export interface Assessment {
  id: string
  title: string
  category: Category
  date: string
  weight: number
  tasks?: AssessmentTask[]
}

export interface Student {
  id: string
  firstName: string
  lastName: string
  grades: Record<string, number | null>
  taskPoints?: Record<string, number | null>
  course?: Course
  courseChange?: CourseChange | null
  courseChangeDate?: string | null
}

export type ParticipationType = 'Wochenplan' | 'Fehlendes Material' | 'Mündliche Mitarbeit'

export interface ParticipationRecord {
  id: string
  studentId: string
  type: ParticipationType
  date: string
  detail: string
  grade: number
}

export interface SchoolClass {
  id: string
  name: string
  subject: string
  schoolYear: string
  color: string
  gradeScale?: GradeScale
  gradeThresholds?: [number, number, number, number, number]
  weightSettings?: { written: number; oral: number; other?: number }
  participationWeights?: { weekly: number; material: number; oral: number }
  participation?: ParticipationRecord[]
  percentageThresholds?: Record<string, number[]>
  students: Student[]
  assessments: Assessment[]
}

export type View = 'overview' | 'gradebook' | 'students' | 'participation' | 'analytics' | 'gradeScheme' | 'weighting'
