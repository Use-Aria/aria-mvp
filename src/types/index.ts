// src/types/index.ts
// Normalized data model — all integrations map to these three types.
// Both Josh and Seb own this file — sync before every change.

export type Task = {
  id: string
  title: string
  due_date: string          // ISO 8601
  source: 'canvas' | 'todoist' | 'reminders'
  status: 'upcoming' | 'overdue' | 'completed'
  course?: string
  weight?: number           // grade percentage, from syllabus
  url?: string
}

export type CalendarEvent = {
  id: string
  title: string
  start_time: string        // ISO 8601
  end_time: string
  source: 'gcal' | 'canvas'
  type: 'class' | 'study' | 'personal' | 'exam'
  location?: string
}

export type Message = {
  id: string
  from: string
  preview: string
  source: 'gmail' | 'slack' | 'imessage'
  timestamp: string
  is_read: boolean
}
