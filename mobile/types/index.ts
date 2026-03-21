// Mirrored from src/types/index.ts — keep in sync

export type Task = {
  id: string
  title: string
  due_date: string
  source: 'canvas' | 'todoist' | 'reminders'
  status: 'upcoming' | 'overdue' | 'completed'
  course?: string
  weight?: number
  url?: string
}

export type CalendarEvent = {
  id: string
  title: string
  start_time: string
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

export type ChatMessage = {
  id: string
  user_id: string
  direction: 'in' | 'out'
  body: string
  sent_at: string
  source: 'app'
}

export type UserPreferences = {
  has_alert_consent?: boolean
  accent_color?: string
  quiet_hours_start?: string
  quiet_hours_end?: string
  hidden_cards?: string[]
  card_order?: string[]
}
