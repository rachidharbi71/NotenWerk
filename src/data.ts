import type { SchoolClass } from './types'

export const demoClasses: SchoolClass[] = [
  {
    id: 'klasse-8b',
    name: 'Klasse 8b',
    subject: 'Mathematik',
    schoolYear: '26/27',
    color: '#0064E6',
    assessments: [
      { id: 'sa1', title: '1. Schulaufgabe', category: 'Schulaufgabe', date: '2026-10-08', weight: 2 },
      { id: 'ex1', title: 'Ex: Lineare Funktionen', category: 'Stegreifaufgabe', date: '2026-09-24', weight: 1 },
      { id: 'mu1', title: 'Mündliche Mitarbeit', category: 'Mündlich', date: '2026-10-15', weight: 1 },
      { id: 'pr1', title: 'Projekt: Datenanalyse', category: 'Projekt', date: '2026-10-22', weight: 1 },
    ],
    students: [
      { id: 's1', firstName: 'Emma', lastName: 'Becker', grades: { sa1: 1.7, ex1: 2, mu1: 1.3, pr1: 1 } },
      { id: 's2', firstName: 'Noah', lastName: 'Fischer', grades: { sa1: 2.3, ex1: 2.7, mu1: 2, pr1: 1.7 } },
      { id: 's3', firstName: 'Mia', lastName: 'Hoffmann', grades: { sa1: 1.3, ex1: 1.7, mu1: 1, pr1: 1.3 } },
      { id: 's4', firstName: 'Ben', lastName: 'Koch', grades: { sa1: 3.3, ex1: 3, mu1: 2.7, pr1: 2.3 } },
      { id: 's5', firstName: 'Lina', lastName: 'Krüger', grades: { sa1: 2, ex1: 2.3, mu1: 1.7, pr1: 1.3 } },
      { id: 's6', firstName: 'Paul', lastName: 'Meyer', grades: { sa1: 4, ex1: 3.7, mu1: 3.3, pr1: 2.7 } },
      { id: 's7', firstName: 'Lea', lastName: 'Schmidt', grades: { sa1: 2.7, ex1: 2.3, mu1: 2, pr1: 2 } },
      { id: 's8', firstName: 'Finn', lastName: 'Wagner', grades: { sa1: 3, ex1: 3.3, mu1: 2.7, pr1: 2.3 } },
    ],
  },
  {
    id: 'klasse-10a',
    name: 'Klasse 10a',
    subject: 'Mathematik',
    schoolYear: '26/27',
    color: '#12A594',
    assessments: [
      { id: '10sa1', title: '1. Schulaufgabe', category: 'Schulaufgabe', date: '2026-10-06', weight: 2 },
      { id: '10mu1', title: 'Mündliche Mitarbeit', category: 'Mündlich', date: '2026-10-16', weight: 1 },
    ],
    students: [
      { id: 's10', firstName: 'Sofia', lastName: 'Braun', grades: { '10sa1': 1.3, '10mu1': 1.7 } },
      { id: 's11', firstName: 'Elias', lastName: 'Richter', grades: { '10sa1': 2.7, '10mu1': 2.3 } },
      { id: 's12', firstName: 'Ida', lastName: 'Zimmermann', grades: { '10sa1': 2, '10mu1': 1.3 } },
    ],
  },
]
