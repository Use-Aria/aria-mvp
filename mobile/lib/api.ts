import { supabase } from './supabase'
import type { Task, CalendarEvent, ChatMessage } from '@/types'

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

/**
 * Expected response shape for briefing preview API.
 * Route /api/briefing/preview does not exist yet — preview screen
 * handles 404/500 gracefully with fallback message.
 */
export type BriefingPreviewResponse = {
  briefing_text: string
  deadline_count: number
  event_count: number
}

/**
 * Authenticated fetch wrapper. Attaches Supabase JWT as Authorization header.
 * Throws on non-2xx responses with status code and body in the message.
 */
async function authFetch(path: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API ${res.status}: ${body}`)
  }
  return res.json()
}

export const api = {
  /** Health check endpoint */
  health: () => authFetch('/api/health'),

  /** Trigger a Canvas iCal sync for the authenticated user */
  triggerCanvasSync: () => authFetch('/api/sync/canvas', { method: 'POST' }),

  /**
   * Get briefing preview for onboarding Step 7.
   * Note: /api/briefing/preview is not yet implemented — preview screen handles 404/500.
   */
  getBriefingPreview: (): Promise<BriefingPreviewResponse> => authFetch('/api/briefing/preview'),

  /** Get upcoming deadlines as normalized Task array */
  getDeadlines: (): Promise<Task[]> => authFetch('/api/deadlines'),

  /** Get calendar events as normalized CalendarEvent array */
  getEvents: (): Promise<CalendarEvent[]> => authFetch('/api/events'),

  /**
   * Get in-app chat messages (separate thread from SMS).
   * @param limit - max messages to fetch (default 20)
   * @param before - cursor for pagination (ISO timestamp)
   */
  getChatMessages: (limit = 20, before?: string): Promise<ChatMessage[]> =>
    authFetch(`/api/chat?limit=${limit}${before ? `&before=${before}` : ''}`),

  /** Send a chat message from the app (not SMS) */
  sendChatMessage: (body: string): Promise<ChatMessage> =>
    authFetch('/api/chat', { method: 'POST', body: JSON.stringify({ body, source: 'app' }) }),

  /** Send phone OTP via Twilio Verify (credentials live server-side) */
  sendPhoneOtp: (phone: string) =>
    authFetch('/api/auth/phone/send', { method: 'POST', body: JSON.stringify({ phone }) }),

  /** Verify phone OTP and establish Supabase session */
  verifyPhoneOtp: (phone: string, code: string) =>
    authFetch('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ phone, code }) }),

  /**
   * Validate Canvas iCal URL by attempting a backend sync.
   * Returns error details distinguishing format vs reachability vs empty feed.
   */
  validateCanvasUrl: (icalUrl: string) =>
    authFetch('/api/sync/canvas', { method: 'POST', body: JSON.stringify({ ical_url: icalUrl }) }),
}
