import type { Task, ChatMessage } from '@/types'

/**
 * Mock data for demo mode (EXPO_PUBLIC_DEMO_MODE=true).
 * Dates are set relative to April 1, 2026 (demo day).
 * Turn off by removing or setting EXPO_PUBLIC_DEMO_MODE=false in .env.
 */

export const MOCK_TASKS: Task[] = [
  {
    id: 'mock-1',
    title: 'CPSC 323 — Problem Set 5',
    due_date: '2026-04-03T23:59:00.000Z',
    source: 'canvas',
    status: 'upcoming',
    course: 'CPSC 323',
    weight: 15,
  },
  {
    id: 'mock-2',
    title: 'ECON 121 — Midterm Exam',
    due_date: '2026-04-04T14:00:00.000Z',
    source: 'canvas',
    status: 'upcoming',
    course: 'ECON 121',
    weight: 30,
  },
  {
    id: 'mock-3',
    title: 'HIST 115 — Response Paper',
    due_date: '2026-04-02T17:00:00.000Z',
    source: 'canvas',
    status: 'upcoming',
    course: 'HIST 115',
    weight: 10,
  },
  {
    id: 'mock-4',
    title: 'MATH 230 — Problem Set 8',
    due_date: '2026-04-07T23:59:00.000Z',
    source: 'canvas',
    status: 'upcoming',
    course: 'MATH 230',
    weight: 12,
  },
  {
    id: 'mock-5',
    title: 'CPSC 200 — Lab Report',
    due_date: '2026-04-09T23:59:00.000Z',
    source: 'canvas',
    status: 'upcoming',
    course: 'CPSC 200',
    weight: 8,
  },
]

// Newest message first — FlatList is inverted so this renders correctly
export const MOCK_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: 'mock-msg-5',
    user_id: 'demo-user',
    direction: 'in',
    body: "Done — I've blocked 2–4 PM Thursday for ECON 121 review and set a reminder. Good luck on the midterm!",
    sent_at: '2026-04-01T08:04:00.000Z',
    source: 'app',
  },
  {
    id: 'mock-msg-4',
    user_id: 'demo-user',
    direction: 'out',
    body: 'Block some time Thursday for ECON review',
    sent_at: '2026-04-01T08:03:00.000Z',
    source: 'app',
  },
  {
    id: 'mock-msg-3',
    user_id: 'demo-user',
    direction: 'in',
    body: 'Most urgent: HIST 115 response paper due tomorrow at 5 PM (10% of grade), then CPSC 323 pset Thursday at midnight (15%). ECON 121 midterm is Friday at 2 PM — that one is 30% of your grade.',
    sent_at: '2026-04-01T08:02:00.000Z',
    source: 'app',
  },
  {
    id: 'mock-msg-2',
    user_id: 'demo-user',
    direction: 'out',
    body: "What's most urgent this week?",
    sent_at: '2026-04-01T08:01:00.000Z',
    source: 'app',
  },
  {
    id: 'mock-msg-1',
    user_id: 'demo-user',
    direction: 'in',
    body: "Good morning! You have 5 deadlines this week — it's a heavy one. HIST 115 paper is due tomorrow, CPSC 323 pset Thursday, and your ECON midterm Friday. Want me to help you plan it out?",
    sent_at: '2026-04-01T07:00:00.000Z',
    source: 'app',
  },
]
