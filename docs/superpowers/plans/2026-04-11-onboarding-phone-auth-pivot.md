# Onboarding Phone Auth Pivot — Implementation Plan

> **STATUS (2026-04-11): TASKS 1–10 ALL COMPLETE. Committed to `onboarding` branch.**
> Task 0 (Supabase dashboard setup) is still PENDING — manual step required before simulator testing.
> See PROGRESS.md for exact OB-P0 steps and next actions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Apple/Google OAuth auth screen with a phone number + Supabase OTP flow, making phone the primary auth identity for all users.

**Architecture:** User enters phone on `auth.tsx` → `supabase.auth.signInWithOtp({ phone })` sends OTP → `verify-phone.tsx` calls `supabase.auth.verifyOtp(...)` to create the session → `profile.tsx` collects name/university/year (phone already in session) → `tools.tsx` prompts all users to connect Google via the existing web-based `/api/auth/google` backend route. Custom Twilio Verify backend routes (`/api/auth/phone/send` and `/api/auth/phone/verify`) are deleted — Supabase handles OTP send + verify.

**Tech Stack:** Supabase phone auth (SMS OTP), expo-web-browser (Google OAuth in tools), Next.js API routes, React Native / Expo

---

## Screen Flow (after pivot)

```
welcome → auth (phone entry) → verify-phone (OTP) → profile (name/uni/year) → tcpa → tools (Google required) → success → home
```

Note: `_layout.tsx` must reflect this new order (verify-phone before profile).

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/app/api/auth/phone/send/route.ts` | **DELETE** | Replaced by Supabase signInWithOtp |
| `src/app/api/auth/phone/verify/route.ts` | **DELETE** | Replaced by Supabase verifyOtp |
| `src/app/api/onboarding/profile/route.ts` | **MODIFY** | Remove `phone` from request body; read from `user.phone` (Supabase session) |
| `mobile/app/(onboarding)/auth.tsx` | **REWRITE** | Phone entry + signInWithOtp; remove Apple/Google OAuth |
| `mobile/app/(onboarding)/verify-phone.tsx` | **MODIFY** | Use supabase.auth.verifyOtp; no mount API call; navigate to profile |
| `mobile/app/(onboarding)/profile.tsx` | **MODIFY** | Remove phone field; update form validation; navigate to tcpa |
| `mobile/app/(onboarding)/tools.tsx` | **MODIFY** | Google connect via WebBrowser + existing `/api/auth/google`; remove expo-auth-session nonce logic |
| `mobile/app/(onboarding)/_layout.tsx` | **MODIFY** | Reorder: auth → verify-phone → profile (was auth → profile → verify-phone) |
| `mobile/lib/api.ts` | **MODIFY** | Remove sendPhoneOtp/verifyPhoneOtp; update saveProfile (drop phone); export API_BASE |
| `mobile/package.json` | **MODIFY** | Remove expo-apple-authentication |
| `mobile/__tests__/onboarding.test.tsx` | **REWRITE** | Replace todo stubs with real tests for new auth flow |
| `src/app/api/auth/phone/` | **DELETE DIR** | Remove empty directory after files deleted |

**No changes needed:** `_layout.tsx` screen names, `success.tsx`, `tcpa.tsx`, `onboarding/complete/route.ts`, `sync/canvas/route.ts`, `supabase/migrations/008_onboarding_completion.sql`

---

## Task 0: Supabase Dashboard — Enable Phone Auth (Manual)

> This is a one-time manual step. Do it before any code changes or you cannot test.

- [ ] **Step 1: Enable Phone provider in Supabase Auth**

Log into [supabase.com](https://supabase.com) → your project → Authentication → Providers → Phone.
Toggle "Enable Phone provider" ON.

- [ ] **Step 2: Configure Twilio SMS**

In the same Phone provider settings:
- Select "Twilio" as SMS provider
- **Account SID** → `TWILIO_ACCOUNT_SID` from `.env.local`
- **Auth Token** → `TWILIO_AUTH_TOKEN` from `.env.local`
- **Messaging Service SID** → a Twilio Messaging Service SID (`MG...`) — NOT `TWILIO_PHONE_NUMBER` and NOT `TWILIO_VERIFY_SERVICE_SID` (`VA...`). These are different things.
  - Create one: Twilio Console → Messaging → Services → Create Messaging Service → add your phone number as a sender → copy the `MG...` SID
- **Twilio Content SID** → leave blank (WhatsApp only)
- **Test Phone Numbers and OTPs** → optional but recommended for simulator testing: add your number (`+1XXXXXXXXXX`) with a hardcoded OTP like `123456`. Supabase will accept this code without sending a real SMS.

Click Save.

- [ ] **Step 3: Verify the config**

In Supabase dashboard → Authentication → Users, you'll see the option to create a test user with a phone number. Confirm the form accepts phone numbers. No code to run — this is just verification the provider is enabled.

---

## Task 1: Delete Custom Phone OTP Backend Routes

**Files:**
- Delete: `src/app/api/auth/phone/send/route.ts`
- Delete: `src/app/api/auth/phone/verify/route.ts`
- Delete: `src/app/api/auth/phone/` (directory, after files removed)

These routes called Twilio Verify directly. With Supabase phone auth, Supabase handles OTP send and verify — the routes are no longer called by anything in the new flow.

- [ ] **Step 1: Delete the send route**

```bash
rm src/app/api/auth/phone/send/route.ts
```

- [ ] **Step 2: Delete the verify route**

```bash
rm src/app/api/auth/phone/verify/route.ts
```

- [ ] **Step 3: Remove the empty directories**

```bash
rm -rf src/app/api/auth/phone
```

- [ ] **Step 4: Confirm no imports reference these routes**

```bash
grep -r "auth/phone" src/ mobile/
```

Expected: no matches (or only comments). If any imports exist, remove them.

- [ ] **Step 5: Commit**

```bash
git add -p
git commit -m "chore(onboarding): delete custom phone OTP routes — replaced by Supabase phone auth"
```

---

## Task 2: Update Profile Route — Read Phone from Session

**Files:**
- Modify: `src/app/api/onboarding/profile/route.ts`

With Supabase phone auth, `user.phone` contains the verified E.164 phone number from the session. The profile route no longer needs `phone` in the request body — it reads from the session and writes to the `users` table.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_onboarding_profile_pivot.py`:

```python
"""
Tests for updated /api/onboarding/profile route after phone-auth pivot.
Phone is now read from session (user.phone), not from request body.
"""
import json
from unittest.mock import MagicMock, patch, AsyncMock


def make_mock_user(user_id="user-123", phone="+15551234567"):
    user = MagicMock()
    user.id = user_id
    user.phone = phone
    return user


def test_profile_accepts_body_without_phone(client, auth_headers):
    """POST /api/onboarding/profile should succeed with name/university/year only."""
    body = {
        "name": "Alice",
        "university": "Yale University",
        "graduation_year": 2027,
    }
    # phone should come from session, not body
    response = client.post("/api/onboarding/profile", json=body, headers=auth_headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_profile_rejects_missing_name(client, auth_headers):
    body = {"university": "Yale", "graduation_year": 2027}
    response = client.post("/api/onboarding/profile", json=body, headers=auth_headers)
    assert response.status_code == 400


def test_profile_rejects_missing_university(client, auth_headers):
    body = {"name": "Alice", "graduation_year": 2027}
    response = client.post("/api/onboarding/profile", json=body, headers=auth_headers)
    assert response.status_code == 400


def test_profile_rejects_bad_grad_year(client, auth_headers):
    body = {"name": "Alice", "university": "Yale", "graduation_year": 1990}
    response = client.post("/api/onboarding/profile", json=body, headers=auth_headers)
    assert response.status_code == 400


def test_profile_requires_auth(client):
    body = {"name": "Alice", "university": "Yale", "graduation_year": 2027}
    response = client.post("/api/onboarding/profile", json=body)
    assert response.status_code == 401
```

- [ ] **Step 2: Verify test reflects what needs to change**

The current route requires `phone` in the body. The new route should accept `{ name, university, graduation_year }` without `phone`. This test documents that contract.

- [ ] **Step 3: Update the route implementation**

Replace `src/app/api/onboarding/profile/route.ts` with:

```typescript
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/onboarding/profile
 * Saves user profile fields (name, university, graduation_year) to the users table.
 * Phone is read from the authenticated Supabase session (set by phone OTP auth).
 *
 * Auth: JWT required — user must be signed in via Supabase phone auth.
 * The user row is upserted by auth UID.
 *
 * Per CLAUDE.md: phone numbers must never appear in plaintext log files.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // --- Auth: resolve user from JWT ---
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    // --- Parse and validate request body ---
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { name, university, graduation_year } = body as Record<string, unknown>

    if (
      typeof name !== 'string' || name.trim().length === 0 ||
      typeof university !== 'string' || university.trim().length === 0 ||
      typeof graduation_year !== 'number' || !Number.isInteger(graduation_year) ||
      graduation_year < 2020 || graduation_year > 2035
    ) {
      return NextResponse.json(
        { error: 'name, university, and graduation_year (integer 2020–2035) are required' },
        { status: 400 },
      )
    }

    // Phone comes from Supabase session (set by phone OTP auth — already E.164)
    const phone = user.phone ?? ''

    // --- Write to DB using service role (bypasses RLS) ---
    const adminClient = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { error: upsertError } = await adminClient
      .from('users')
      .upsert(
        {
          id: user.id,
          name: name.trim(),
          phone,
          university: university.trim(),
          graduation_year,
        },
        { onConflict: 'id' },
      )

    if (upsertError) {
      console.error('[onboarding/profile] DB upsert failed:', upsertError.message)
      return NextResponse.json({ error: 'Failed to save profile' }, { status: 500 })
    }

    console.log('[onboarding/profile] profile saved for user:', user.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[onboarding/profile] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/onboarding/profile/route.ts
git commit -m "feat(onboarding): profile route reads phone from session instead of request body"
```

---

## Task 3: Update api.ts — Remove Phone OTP Methods, Update saveProfile, Export API_BASE

**Files:**
- Modify: `mobile/lib/api.ts`

Remove `sendPhoneOtp` and `verifyPhoneOtp` (now handled by Supabase directly on the client). Update `saveProfile` to drop the `phone` field. Export `API_BASE` so `tools.tsx` can construct the Google OAuth URL.

- [ ] **Step 1: Update mobile/lib/api.ts**

```typescript
import { supabase } from './supabase'
import type { Task, CalendarEvent, ChatMessage } from '@/types'

export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

/**
 * Expected response shape for briefing preview API.
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
   * Get briefing preview for onboarding preview screen.
   * Note: /api/briefing/preview may not be implemented — handle 404/500 gracefully.
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

  /**
   * Validate Canvas iCal URL by attempting a backend sync.
   * Returns error details distinguishing format vs reachability vs empty feed.
   */
  validateCanvasUrl: (icalUrl: string) =>
    authFetch('/api/sync/canvas', { method: 'POST', body: JSON.stringify({ ical_url: icalUrl }) }),

  /** Save user profile (name, university, graduation_year) during onboarding.
   * Phone is now sourced from the Supabase session — not sent in the body. */
  saveProfile: (data: { name: string; university: string; graduation_year: number }) =>
    authFetch('/api/onboarding/profile', { method: 'POST', body: JSON.stringify(data) }),

  /** Mark onboarding complete and enqueue welcome SMS */
  completeOnboarding: () =>
    authFetch('/api/onboarding/complete', { method: 'POST', body: JSON.stringify({}) }),

  /**
   * Upload a syllabus PDF for a course.
   * Sends as multipart/form-data — does NOT use authFetch (different Content-Type).
   */
  uploadSyllabus: async (fileUri: string, courseName: string): Promise<void> => {
    const { data: { session } } = await supabase.auth.getSession()
    const formData = new FormData()
    formData.append('file', { uri: fileUri, name: `${courseName}.pdf`, type: 'application/pdf' } as unknown as Blob)
    formData.append('course_name', courseName)
    const res = await fetch(`${API_BASE}/api/upload/syllabus`, {
      method: 'POST',
      headers: {
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: formData,
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`API ${res.status}: ${body}`)
    }
  },
}
```

- [ ] **Step 2: Confirm no other files import sendPhoneOtp or verifyPhoneOtp**

```bash
grep -r "sendPhoneOtp\|verifyPhoneOtp" mobile/
```

Expected: no matches after this change. If any remain, remove them.

- [ ] **Step 3: Commit**

```bash
git add mobile/lib/api.ts
git commit -m "feat(onboarding): remove phone OTP api methods, update saveProfile signature, export API_BASE"
```

---

## Task 4: Rewrite auth.tsx — Phone Entry Screen

**Files:**
- Modify: `mobile/app/(onboarding)/auth.tsx`

Replace Apple/Google OAuth buttons with a phone number entry form. Uses the existing `PhoneInput` component. Calls `supabase.auth.signInWithOtp({ phone })` which sends the OTP via Supabase's configured Twilio integration. Navigates to `verify-phone` on success, passing phone as a route param.

E.164 conversion: strip non-digits from `PhoneInput`'s formatted output, prepend `+1` (Yale = US students for MVP).

- [ ] **Step 1: Write failing test for auth screen**

In `mobile/__tests__/onboarding.test.tsx`, replace all `.todo` stubs with:

```typescript
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { supabase } from '@/lib/supabase'

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

// Mock supabase
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: jest.fn(),
      verifyOtp: jest.fn(),
      getSession: jest.fn(() => ({
        data: { session: { user: { id: 'user-123', phone: '+15551234567' }, access_token: 'tok' } },
      })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(() => ({ data: null, error: null })),
    })),
  },
}))

// Mock lib/theme
jest.mock('@/lib/theme', () => ({
  useTheme: () => ({ accent: '#6C47FF', colors: { dominant: '#fff', textPrimary: '#000', textSecondary: '#888', cardBorder: '#ddd', secondary: '#f9f9f9' } }),
}))

const mockSignInWithOtp = supabase.auth.signInWithOtp as jest.Mock
const mockVerifyOtp = supabase.auth.verifyOtp as jest.Mock

// ── Auth screen ──────────────────────────────────────────────────────────────

import Auth from '@/app/(onboarding)/auth'

describe('Auth screen — phone entry', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders phone input and disabled Send Code button', () => {
    const { getByPlaceholderText, getByText } = render(<Auth />)
    expect(getByPlaceholderText('+1 (555) 000-0000')).toBeTruthy()
    expect(getByText('Send code')).toBeTruthy()
  })

  it('Send Code button is disabled with fewer than 10 digits', () => {
    const { getByPlaceholderText, getByText } = render(<Auth />)
    fireEvent.changeText(getByPlaceholderText('+1 (555) 000-0000'), '+1 (555) 123')
    const btn = getByText('Send code')
    expect(btn.props.accessibilityState?.disabled || btn.parent?.props.disabled).toBeTruthy()
  })

  it('calls supabase.auth.signInWithOtp with E.164 phone on valid submit', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null })
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush })

    const { getByPlaceholderText, getByText } = render(<Auth />)
    fireEvent.changeText(getByPlaceholderText('+1 (555) 000-0000'), '+1 (555) 123-4567')
    fireEvent.press(getByText('Send code'))

    await waitFor(() => {
      expect(mockSignInWithOtp).toHaveBeenCalledWith({ phone: '+15551234567' })
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/(onboarding)/verify-phone',
        params: { phone: '+15551234567' },
      })
    })
  })

  it('shows error when signInWithOtp fails', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: { message: 'SMS quota exceeded' } })
    const { getByPlaceholderText, getByText, findByText } = render(<Auth />)
    fireEvent.changeText(getByPlaceholderText('+1 (555) 000-0000'), '+1 (555) 123-4567')
    fireEvent.press(getByText('Send code'))
    expect(await findByText(/couldn't send/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --testNamePattern="Auth screen" 2>&1 | tail -20
```

Expected: FAIL — `Auth` screen still has Apple/Google buttons, no phone input.

- [ ] **Step 3: Rewrite auth.tsx**

```typescript
import React, { useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import PhoneInput from '@/components/onboarding/PhoneInput'

/**
 * Onboarding Step 2 — Phone number entry.
 *
 * Collects the user's phone number and sends a 6-digit OTP via Supabase
 * phone auth (backed by Twilio). The phone number is the primary auth
 * identity — no Apple or Google sign-in at this step.
 *
 * On success: navigate to verify-phone with the E.164 phone as a route param.
 *
 * E.164 conversion: PhoneInput formats as "+1 (555) 123-4567". We strip
 * non-digits and prepend "+1" for US numbers (MVP = Yale students).
 */
export default function Auth() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const phoneDigits = phone.replace(/\D/g, '').length
  const isPhoneValid = phoneDigits >= 10

  /** Convert PhoneInput display value to E.164 (e.g. "+1 (555) 123-4567" → "+15551234567") */
  const toE164 = (display: string): string => {
    const digits = display.replace(/\D/g, '')
    return `+1${digits.slice(-10)}`
  }

  const handleSendCode = async () => {
    if (!isPhoneValid || loading) return
    setError(null)
    setLoading(true)

    const e164 = toE164(phone)
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: e164 })
    setLoading(false)

    if (otpError) {
      setError("Couldn't send the code. Check your number and try again.")
      return
    }

    router.push({ pathname: '/(onboarding)/verify-phone', params: { phone: e164 } })
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={{ flex: 1, paddingHorizontal: 28, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ fontSize: 13, fontWeight: '700', color: accent, letterSpacing: 1.2, marginBottom: 10 }}>
            ARIA · AI PERSONAL ASSISTANT
          </Text>
          <Text style={{ fontSize: 34, fontWeight: '800', color: colors.textPrimary, lineHeight: 40, marginBottom: 12 }}>
            What's your number?
          </Text>
          <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 40 }}>
            We'll text you a code to verify your number. No app download required.
          </Text>

          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 }}>
            Phone number
          </Text>
          <PhoneInput
            value={phone}
            onChangeText={setPhone}
            isValid={isPhoneValid}
            error={error ?? undefined}
          />

          <TouchableOpacity
            onPress={handleSendCode}
            disabled={!isPhoneValid || loading}
            style={{
              backgroundColor: accent,
              borderRadius: 14,
              height: 56,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 32,
              opacity: !isPhoneValid || loading ? 0.4 : 1,
            }}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#FFFFFF' }}>
                Send code
              </Text>
            )}
          </TouchableOpacity>

          <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 20 }}>
            Yale students only · Closed beta
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --testNamePattern="Auth screen" 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/app/(onboarding)/auth.tsx mobile/__tests__/onboarding.test.tsx
git commit -m "feat(onboarding): replace Apple/Google auth with phone number entry + Supabase OTP"
```

---

## Task 5: Update verify-phone.tsx — Use Supabase verifyOtp

**Files:**
- Modify: `mobile/app/(onboarding)/verify-phone.tsx`

Key changes:
1. No API call on mount — OTP was already sent by `auth.tsx` via `supabase.auth.signInWithOtp`
2. Start cooldown timer on mount (not after a send call)
3. Replace `api.verifyPhoneOtp` with `supabase.auth.verifyOtp({ phone, token: code, type: 'sms' })`
4. Replace `api.sendPhoneOtp` resend with `supabase.auth.signInWithOtp({ phone })`
5. Navigate to `profile` on success (was `tcpa` — profile is now after verify-phone)
6. Update ProgressBar step from `4` → `3` (new order: auth=2, verify-phone=3, profile=4)
7. Remove `api` import

- [ ] **Step 1: Add verify-phone tests to the test file**

Append to `mobile/__tests__/onboarding.test.tsx`:

```typescript
// ── VerifyPhone screen ───────────────────────────────────────────────────────

import VerifyPhone from '@/app/(onboarding)/verify-phone'

// Mock useLocalSearchParams
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({ phone: '+15551234567' }),
}))

describe('VerifyPhone screen — Supabase OTP', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders the PIN input and phone number', () => {
    const { getByText } = render(<VerifyPhone />)
    expect(getByText(/\+15551234567/)).toBeTruthy()
  })

  it('calls supabase.auth.verifyOtp with phone and code on 6 digits', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null })
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush })

    const { getByTestId } = render(<VerifyPhone />)
    // Simulate PinInput completing with 6 digits
    // PinInput calls onComplete when 6th digit entered
    fireEvent(getByTestId('pin-input'), 'complete', '123456')

    await waitFor(() => {
      expect(mockVerifyOtp).toHaveBeenCalledWith({
        phone: '+15551234567',
        token: '123456',
        type: 'sms',
      })
      expect(mockPush).toHaveBeenCalledWith('/(onboarding)/profile')
    })
  })

  it('shows error when verifyOtp fails', async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })
    const { getByTestId, findByText } = render(<VerifyPhone />)
    fireEvent(getByTestId('pin-input'), 'complete', '999999')
    expect(await findByText(/didn't match|expired/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to confirm it fails (expected)**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --testNamePattern="VerifyPhone screen" 2>&1 | tail -20
```

Expected: FAIL — current implementation calls api.sendPhoneOtp on mount and doesn't call supabase.auth.verifyOtp.

- [ ] **Step 3: Update verify-phone.tsx**

```typescript
import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, SafeAreaView, ActivityIndicator } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'
import PinInput from '@/components/onboarding/PinInput'

const RESEND_COOLDOWN_SECONDS = 30

/**
 * Onboarding Step 3 — Phone OTP verification.
 *
 * OTP was already sent by auth.tsx via supabase.auth.signInWithOtp.
 * This screen calls supabase.auth.verifyOtp to verify the code and
 * create the Supabase session.
 *
 * On success: navigate to profile (step 4).
 *
 * Error handling:
 *   Supabase "Token has expired" → prompt resend
 *   Supabase "invalid" → wrong code, try again
 *
 * Resend: calls supabase.auth.signInWithOtp again (same phone).
 * Cooldown starts on mount since OTP was already sent by auth screen.
 */
export default function VerifyPhone() {
  const router = useRouter()
  const { phone } = useLocalSearchParams<{ phone: string }>()
  const { accent, colors } = useTheme()

  const [pinError, setPinError] = useState<string | undefined>(undefined)
  const [isVerifying, setIsVerifying] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SECONDS)
  const [canResend, setCanResend] = useState(false)
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCooldown = () => {
    setCanResend(false)
    setResendCooldown(RESEND_COOLDOWN_SECONDS)
    if (cooldownRef.current) clearInterval(cooldownRef.current)
    cooldownRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current)
          setCanResend(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  // OTP was already sent by auth.tsx — just start the cooldown timer on mount
  useEffect(() => {
    startCooldown()
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleComplete = async (code: string) => {
    if (isVerifying) return
    setPinError(undefined)
    setIsVerifying(true)

    const { error } = await supabase.auth.verifyOtp({
      phone: phone ?? '',
      token: code,
      type: 'sms',
    })

    setIsVerifying(false)

    if (error) {
      const msg = error.message.toLowerCase()
      if (msg.includes('expired')) {
        setPinError("Code expired. Tap 'Resend' to get a new one.")
      } else {
        setPinError("That code didn't match. Try again.")
      }
      return
    }

    router.push('/(onboarding)/profile')
  }

  const handleResend = async () => {
    if (!canResend || isVerifying) return
    setPinError(undefined)
    const { error } = await supabase.auth.signInWithOtp({ phone: phone ?? '' })
    if (error) {
      setPinError("Couldn't resend the code. Please try again.")
      return
    }
    startCooldown()
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={3} />

      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32 }}>
        <Text style={{ fontSize: 28, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 }}>
          Enter the code
        </Text>
        <Text style={{ fontSize: 16, color: colors.textSecondary, marginBottom: 32 }}>
          Sent to {phone}
        </Text>

        <PinInput onComplete={handleComplete} error={pinError} />

        {isVerifying ? (
          <ActivityIndicator color={accent} style={{ marginTop: 24 }} />
        ) : (
          <TouchableOpacity
            onPress={handleResend}
            disabled={!canResend || isVerifying}
            style={{ marginTop: 24, alignItems: 'center' }}
          >
            <Text
              style={{
                fontSize: 16,
                color: canResend && !isVerifying ? accent : colors.textSecondary,
                fontWeight: canResend && !isVerifying ? '600' : '400',
              }}
            >
              {canResend ? 'Resend code' : `Resend in ${resendCooldown}s`}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  )
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --testNamePattern="VerifyPhone screen" 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/app/(onboarding)/verify-phone.tsx mobile/__tests__/onboarding.test.tsx
git commit -m "feat(onboarding): verify-phone uses Supabase verifyOtp, navigates to profile"
```

---

## Task 6: Update profile.tsx — Remove Phone Field

**Files:**
- Modify: `mobile/app/(onboarding)/profile.tsx`

Remove phone field and PhoneInput import. Update form validation. Remove phone from `api.saveProfile` call. Update ProgressBar step to `4` (was `3` — order swapped after phone auth moved earlier). Navigate to `tcpa` on success (no phone param needed).

- [ ] **Step 1: Add profile tests to the test file**

Append to `mobile/__tests__/onboarding.test.tsx`:

```typescript
// ── Profile screen ───────────────────────────────────────────────────────────

import Profile from '@/app/(onboarding)/profile'
import { api } from '@/lib/api'

jest.mock('@/lib/api', () => ({
  api: {
    saveProfile: jest.fn(),
  },
}))

const mockSaveProfile = api.saveProfile as jest.Mock

describe('Profile screen — no phone field', () => {
  beforeEach(() => jest.clearAllMocks())

  it('does NOT render a phone number input', () => {
    const { queryByPlaceholderText } = render(<Profile />)
    expect(queryByPlaceholderText('+1 (555) 000-0000')).toBeNull()
  })

  it('renders name, university, graduation year fields', () => {
    const { getByPlaceholderText } = render(<Profile />)
    expect(getByPlaceholderText('Your name')).toBeTruthy()
    expect(getByPlaceholderText('e.g. Yale University')).toBeTruthy()
    expect(getByPlaceholderText('e.g. 2027')).toBeTruthy()
  })

  it('Continue button disabled without all fields', () => {
    const { getByText } = render(<Profile />)
    const btn = getByText('Continue')
    expect(btn.parent?.props.disabled).toBeTruthy()
  })

  it('calls api.saveProfile with name, university, graduation_year only (no phone)', async () => {
    mockSaveProfile.mockResolvedValue({ ok: true })
    const mockPush = jest.fn()
    jest.spyOn(require('expo-router'), 'useRouter').mockReturnValue({ push: mockPush })

    const { getByPlaceholderText, getByText } = render(<Profile />)
    fireEvent.changeText(getByPlaceholderText('Your name'), 'Alice')
    fireEvent.changeText(getByPlaceholderText('e.g. Yale University'), 'Yale University')
    fireEvent.changeText(getByPlaceholderText('e.g. 2027'), '2027')
    fireEvent.press(getByText('Continue'))

    await waitFor(() => {
      expect(mockSaveProfile).toHaveBeenCalledWith({
        name: 'Alice',
        university: 'Yale University',
        graduation_year: 2027,
      })
      expect(mockSaveProfile).not.toHaveBeenCalledWith(expect.objectContaining({ phone: expect.anything() }))
      expect(mockPush).toHaveBeenCalledWith('/(onboarding)/tcpa')
    })
  })
})
```

- [ ] **Step 2: Run test to confirm it fails (expected)**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --testNamePattern="Profile screen" 2>&1 | tail -20
```

Expected: FAIL — current profile has phone field and sends it in the API call.

- [ ] **Step 3: Update profile.tsx**

```typescript
import React, { useState } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import { api } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'

/**
 * Onboarding Step 4 — Profile collection.
 *
 * Collects name, university, and graduation year.
 * Phone is NOT collected here — it was captured and verified in auth + verify-phone.
 * The backend reads phone from the Supabase session (user.phone).
 *
 * Submits to POST /api/onboarding/profile, then navigates to tcpa.
 */
export default function Profile() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [name, setName] = useState('')
  const [university, setUniversity] = useState('')
  const [gradYear, setGradYear] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const gradYearNum = parseInt(gradYear, 10)
  const isGradYearValid = !isNaN(gradYearNum) && gradYearNum >= 2024 && gradYearNum <= 2035

  const isFormValid =
    name.trim().length > 0 &&
    university.trim().length > 0 &&
    isGradYearValid

  const handleContinue = async () => {
    if (!isFormValid || isLoading) return
    setError(null)
    setIsLoading(true)

    try {
      await api.saveProfile({
        name: name.trim(),
        university: university.trim(),
        graduation_year: gradYearNum,
      })
      router.push('/(onboarding)/tcpa')
    } catch {
      setError("Couldn't save your profile. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  const inputStyle = {
    height: 56,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    borderColor: colors.cardBorder,
    color: colors.textPrimary,
    backgroundColor: colors.dominant,
  }

  const labelStyle = {
    fontSize: 13,
    fontWeight: '600' as const,
    color: colors.textSecondary,
    marginBottom: 6,
    marginTop: 16,
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={4} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={{ fontSize: 28, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 }}>
            Tell us about you
          </Text>
          <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 8 }}>
            This helps Aria personalise your briefings.
          </Text>

          {error ? (
            <Text style={{ color: '#FF3B30', fontSize: 14, marginTop: 8 }}>{error}</Text>
          ) : null}

          {/* Name */}
          <Text style={labelStyle}>Full name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={colors.textSecondary}
            autoComplete="name"
            returnKeyType="next"
            style={inputStyle}
          />

          {/* University */}
          <Text style={labelStyle}>University</Text>
          <TextInput
            value={university}
            onChangeText={setUniversity}
            placeholder="e.g. Yale University"
            placeholderTextColor={colors.textSecondary}
            returnKeyType="next"
            style={inputStyle}
          />

          {/* Graduation year */}
          <Text style={labelStyle}>Graduation year</Text>
          <TextInput
            value={gradYear}
            onChangeText={(t) => setGradYear(t.replace(/\D/g, '').slice(0, 4))}
            placeholder="e.g. 2027"
            placeholderTextColor={colors.textSecondary}
            keyboardType="number-pad"
            maxLength={4}
            returnKeyType="done"
            onSubmitEditing={handleContinue}
            style={[
              inputStyle,
              gradYear.length === 4 && !isGradYearValid ? { borderColor: '#FF3B30' } : {},
            ]}
          />
          {gradYear.length === 4 && !isGradYearValid ? (
            <Text style={{ color: '#FF3B30', fontSize: 14, marginTop: 6 }}>
              Enter a year between 2024 and 2035
            </Text>
          ) : null}

          <TouchableOpacity
            onPress={handleContinue}
            disabled={!isFormValid || isLoading}
            style={{
              backgroundColor: accent,
              borderRadius: 12,
              height: 56,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 32,
              opacity: !isFormValid || isLoading ? 0.4 : 1,
            }}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                Continue
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --testNamePattern="Profile screen" 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/app/(onboarding)/profile.tsx mobile/__tests__/onboarding.test.tsx
git commit -m "feat(onboarding): profile screen removes phone field, navigates to tcpa"
```

---

## Task 7: Update tools.tsx — Google Connect via WebBrowser

**Files:**
- Modify: `mobile/app/(onboarding)/tools.tsx`

Key changes:
1. Remove `expo-auth-session/providers/google`, `expo-crypto`, and nonce generation — we no longer use `signInWithIdToken` (which would replace the phone auth session)
2. Replace with `WebBrowser.openBrowserAsync` that opens the existing `GET /api/auth/google?user_id=<uuid>` backend route
3. The existing backend route redirects to Google, exchanges code for tokens, stores via Celery — no new backend code needed
4. After the browser closes, poll the `integrations` table (Supabase) to detect if Google tokens were stored
5. Update the provider check: instead of `app_metadata.provider === 'google'`, query the `integrations` table for a `google` row on mount

- [ ] **Step 1: Update tools.tsx**

```typescript
import React, { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import * as WebBrowser from 'expo-web-browser'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '@/lib/supabase'
import { api, API_BASE } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import ProgressBar from '@/components/onboarding/ProgressBar'
import CanvasUrlInput from '@/components/onboarding/CanvasUrlInput'

type CanvasStatus = 'idle' | 'validating' | 'valid' | 'error'

/**
 * Onboarding Step 6 — Integration hub.
 *
 * Required section: Gmail + Google Calendar.
 *   All users arrive here via phone auth (no Google session).
 *   "Connect Google" opens the existing /api/auth/google web OAuth flow in a browser.
 *   After the browser closes, we poll the integrations table to confirm Google tokens
 *   were stored by the backend Celery task. Continue is disabled until connected.
 *
 * Optional section:
 *   - Canvas iCal URL: validate via POST /api/sync/canvas.
 *   - Syllabus PDF: file picker → POST /api/upload/syllabus.
 *   - Google Classroom: "Coming soon" badge.
 */
export default function Tools() {
  const router = useRouter()
  const { accent, colors } = useTheme()

  const [googleConnected, setGoogleConnected] = useState(false)
  const [checkingGoogle, setCheckingGoogle] = useState(true)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleError, setGoogleError] = useState<string | null>(null)

  const [canvasUrl, setCanvasUrl] = useState('')
  const [canvasStatus, setCanvasStatus] = useState<CanvasStatus>('idle')
  const [canvasError, setCanvasError] = useState<string | undefined>(undefined)

  const [syllabusUploading, setSyllabusUploading] = useState(false)
  const [syllabusFileName, setSyllabusFileName] = useState<string | null>(null)
  const [syllabusError, setSyllabusError] = useState<string | null>(null)

  /**
   * Check integrations table for a google row for this user.
   * Returns true if found.
   */
  const checkGoogleIntegration = useCallback(async (): Promise<boolean> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user?.id) return false
    const { data } = await supabase
      .from('integrations')
      .select('platform')
      .eq('user_id', session.user.id)
      .eq('platform', 'google')
      .maybeSingle()
    return !!data
  }, [])

  // Check on mount whether Google was already connected in a prior session
  useEffect(() => {
    checkGoogleIntegration().then((connected) => {
      setGoogleConnected(connected)
      setCheckingGoogle(false)
    })
  }, [checkGoogleIntegration])

  /**
   * Poll integrations table for up to 12 seconds (8 × 1.5s) after browser closes.
   * The Celery task encrypts and stores tokens asynchronously — we wait for it.
   */
  const pollForGoogleConnection = async (): Promise<boolean> => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const connected = await checkGoogleIntegration()
      if (connected) return true
    }
    return false
  }

  const handleConnectGoogle = async () => {
    if (googleLoading) return
    setGoogleError(null)
    setGoogleLoading(true)

    const { data: { session } } = await supabase.auth.getSession()
    const userId = session?.user?.id
    if (!userId) {
      setGoogleError('Session expired. Please restart onboarding.')
      setGoogleLoading(false)
      return
    }

    // Open the existing web-based Google OAuth flow in a browser.
    // The backend route handles CSRF, code exchange, and Fernet-encrypted token storage.
    await WebBrowser.openBrowserAsync(`${API_BASE}/api/auth/google?user_id=${userId}`)

    // Browser closed — poll for the Celery task to write tokens to integrations table
    const connected = await pollForGoogleConnection()
    setGoogleConnected(connected)
    if (!connected) {
      setGoogleError("Couldn't confirm Google connection. Please try again.")
    }
    setGoogleLoading(false)
  }

  const handleCanvasValidate = async () => {
    setCanvasError(undefined)
    const CANVAS_URL_REGEX = /^(webcal|https?):\/\/.*/
    if (!CANVAS_URL_REGEX.test(canvasUrl.trim())) {
      setCanvasStatus('error')
      setCanvasError("Doesn't look like a Canvas iCal URL. Should start with webcal:// or https://")
      return
    }
    setCanvasStatus('validating')
    try {
      const result = await api.validateCanvasUrl(canvasUrl.trim())
      if (result?.deadline_count === 0) {
        setCanvasStatus('error')
        setCanvasError('URL connected but no deadlines found. Check your Canvas calendar has events.')
        return
      }
      setCanvasStatus('valid')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      setCanvasStatus('error')
      setCanvasError(
        message.includes('400')
          ? "That doesn't look like a Canvas iCal URL."
          : "Couldn't reach that Canvas feed. Double-check the URL."
      )
    }
  }

  const handleSyllabusPick = async () => {
    setSyllabusError(null)
    setSyllabusUploading(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
      })
      if (result.canceled || !result.assets?.[0]) {
        setSyllabusUploading(false)
        return
      }
      const asset = result.assets[0]
      const courseName = asset.name.replace(/\.pdf$/i, '')
      await api.uploadSyllabus(asset.uri, courseName)
      setSyllabusFileName(asset.name)
    } catch {
      setSyllabusError("Couldn't upload syllabus. Please try again.")
    } finally {
      setSyllabusUploading(false)
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.dominant }}>
      <ProgressBar currentStep={6} />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={{ fontSize: 28, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 }}>
          Connect your tools
        </Text>
        <Text style={{ fontSize: 16, color: colors.textSecondary, lineHeight: 24, marginBottom: 32 }}>
          Aria needs Google to sync your calendar and watch professor emails.
        </Text>

        {/* ── Required section ── */}
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 1, marginBottom: 12 }}>
          REQUIRED
        </Text>

        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 24,
          backgroundColor: colors.secondary,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Ionicons name="logo-google" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                Gmail + Google Calendar
              </Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Deadline alerts and calendar sync
              </Text>
            </View>
          </View>

          {checkingGoogle ? (
            <ActivityIndicator color={accent} />
          ) : googleConnected ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="checkmark-circle" size={20} color="#34C759" />
              <Text style={{ fontSize: 15, color: '#34C759', fontWeight: '600' }}>Connected</Text>
            </View>
          ) : (
            <>
              {googleError ? (
                <Text style={{ color: '#FF3B30', fontSize: 14, marginBottom: 10 }}>{googleError}</Text>
              ) : null}
              <TouchableOpacity
                onPress={handleConnectGoogle}
                disabled={googleLoading}
                style={{
                  backgroundColor: accent,
                  borderRadius: 10,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: googleLoading ? 0.6 : 1,
                }}
              >
                {googleLoading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
                    Connect Google
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* ── Optional section ── */}
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 1, marginBottom: 12 }}>
          OPTIONAL
        </Text>

        {/* Canvas */}
        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 16,
          backgroundColor: colors.secondary,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <Ionicons name="school-outline" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                Canvas
              </Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Import deadlines from your iCal feed
              </Text>
            </View>
          </View>
          <CanvasUrlInput
            value={canvasUrl}
            onChangeText={(text) => {
              setCanvasUrl(text)
              if (canvasStatus !== 'idle') setCanvasStatus('idle')
            }}
            onValidate={handleCanvasValidate}
            status={canvasStatus}
            errorMessage={canvasError}
          />
        </View>

        {/* Syllabus */}
        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 16,
          backgroundColor: colors.secondary,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <Ionicons name="document-text-outline" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                Syllabus
              </Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Upload a PDF so Aria knows your grade weights
              </Text>
            </View>
          </View>

          {syllabusFileName ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="checkmark-circle" size={20} color="#34C759" />
              <Text style={{ fontSize: 14, color: '#34C759', fontWeight: '600', flex: 1 }} numberOfLines={1}>
                {syllabusFileName}
              </Text>
            </View>
          ) : (
            <>
              {syllabusError ? (
                <Text style={{ color: '#FF3B30', fontSize: 14, marginBottom: 8 }}>{syllabusError}</Text>
              ) : null}
              <TouchableOpacity
                onPress={handleSyllabusPick}
                disabled={syllabusUploading}
                style={{
                  borderWidth: 1,
                  borderColor: accent,
                  borderRadius: 10,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: syllabusUploading ? 0.6 : 1,
                }}
              >
                {syllabusUploading ? (
                  <ActivityIndicator color={accent} />
                ) : (
                  <Text style={{ color: accent, fontSize: 15, fontWeight: '600' }}>
                    Choose PDF
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Google Classroom — coming soon */}
        <View style={{
          borderWidth: 1,
          borderColor: colors.cardBorder,
          borderRadius: 16,
          padding: 20,
          marginBottom: 32,
          backgroundColor: colors.secondary,
          opacity: 0.6,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="library-outline" size={22} color={colors.textPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
                  Google Classroom
                </Text>
                <View style={{
                  backgroundColor: `${accent}20`,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: accent }}>COMING SOON</Text>
                </View>
              </View>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
                Assignment sync from Google Classroom
              </Text>
            </View>
          </View>
        </View>

        {/* Continue CTA */}
        <TouchableOpacity
          onPress={() => router.push('/(onboarding)/success')}
          disabled={!googleConnected}
          style={{
            backgroundColor: accent,
            borderRadius: 12,
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: googleConnected ? 1 : 0.4,
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
            Continue
          </Text>
        </TouchableOpacity>

        {!googleConnected ? (
          <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 10 }}>
            Connect Google to continue
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}
```

- [ ] **Step 2: Confirm no leftover expo-crypto or expo-auth-session imports in tools.tsx**

```bash
grep -n "expo-crypto\|expo-auth-session\|signInWithIdToken\|rawNonce\|hashedNonce" mobile/app/(onboarding)/tools.tsx
```

Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add mobile/app/(onboarding)/tools.tsx
git commit -m "feat(onboarding): tools Google connect uses WebBrowser + integrations table poll (not signInWithIdToken)"
```

---

## Task 8: Update _layout.tsx — Reorder Screens

**Files:**
- Modify: `mobile/app/(onboarding)/_layout.tsx`

Swap `profile` and `verify-phone` so the Stack order matches the new flow: auth → verify-phone → profile.

- [ ] **Step 1: Update _layout.tsx**

```typescript
import { Stack } from 'expo-router'

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: false }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="verify-phone" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="tcpa" />
      <Stack.Screen name="tools" />
      <Stack.Screen name="success" />
    </Stack>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/app/(onboarding)/_layout.tsx
git commit -m "feat(onboarding): reorder Stack screens — verify-phone before profile"
```

---

## Task 9: Remove expo-apple-authentication

**Files:**
- Modify: `mobile/package.json`

`expo-apple-authentication` is no longer imported by any file. Remove it.

- [ ] **Step 1: Confirm it's not imported anywhere**

```bash
grep -r "expo-apple-authentication" mobile/
```

Expected: no matches (auth.tsx was already rewritten in Task 4).

- [ ] **Step 2: Uninstall the package**

```bash
cd mobile && npm uninstall expo-apple-authentication
```

- [ ] **Step 3: Verify package.json no longer lists it**

```bash
grep "expo-apple-authentication" mobile/package.json
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add mobile/package.json mobile/package-lock.json
git commit -m "chore(onboarding): remove expo-apple-authentication (Apple Sign-In removed)"
```

---

## Task 10: Run Full Test Suite

- [ ] **Step 1: Run mobile tests**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --verbose 2>&1 | tail -40
```

Expected: all tests PASS. No skipped tests from this file.

- [ ] **Step 2: Run Next.js lint**

```bash
cd /path/to/aria-mvp && npm run lint 2>&1 | tail -20
```

Expected: no errors. Fix any TypeScript or lint errors before proceeding.

- [ ] **Step 3: Confirm deleted routes are not referenced in any TypeScript**

```bash
grep -r "auth/phone/send\|auth/phone/verify" src/ mobile/
```

Expected: no matches.

---

## Self-Review — Spec Coverage Check

| Spec requirement | Covered by |
|---|---|
| Phone is primary auth identity | Task 4 (auth.tsx uses signInWithOtp) |
| Supabase creates session on OTP verify | Task 5 (verify-phone calls verifyOtp) |
| Profile removes phone field | Task 6 (profile.tsx, api.ts Task 3) |
| Backend profile reads phone from session | Task 2 (profile route reads user.phone) |
| Google required in tools | Task 7 (tools.tsx disabled Continue until connected) |
| Google connect doesn't replace phone session | Task 7 (WebBrowser flow, not signInWithIdToken) |
| Google token storage unchanged | No change — `/api/auth/google` callback + Celery unchanged |
| Apple Sign-In removed | Task 4 (auth.tsx), Task 9 (package uninstall) |
| Custom Twilio Verify routes removed | Task 1 (deleted) |
| Screen order correct | Task 8 (_layout.tsx) |
| ProgressBar steps updated | Task 5 (verify-phone: 3), Task 6 (profile: 4) |
| Resend OTP works | Task 5 (calls signInWithOtp) |
| OTP not re-sent on verify-phone mount | Task 5 (no mount API call) |
