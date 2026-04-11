# Onboarding Redesign — Spec

> Created: 2026-04-10
> Last updated: 2026-04-11 (session 2)
> Status: **Phase C COMPLETE (all 10 code tasks done, commit `7d3d8a5`). Blocked on OB-P0 (manual Supabase phone auth setup) before simulator test.**
> Branch: `onboarding`
> Pivot plan: `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md`

---

## Overview

**⚠️ Auth method changed 2026-04-11.** The original Phase A/B design used Apple Sign-In or Google OAuth as the primary auth method. This has been replaced with **Supabase phone OTP** (phone number → 6-digit SMS code → Supabase session). Apple Sign-In has been removed from the MVP entirely.

**Reason for pivot:** Apple Sign-In requires org-level Apple Developer account approval (blocked). Phone OTP works immediately, fits the product (Aria communicates via SMS), and avoids the dependency on Seb's Apple credentials.

Gmail and Google Calendar remain **required** integrations, connected in the tools screen via the existing web-based `/api/auth/google` OAuth flow. Canvas is **optional**. Canvas validation returns real deadline counts.

Welcome SMS is decoupled from Canvas sync and triggered explicitly at onboarding completion.

---

## Screen Flow

```
welcome → auth → verify-phone → profile → tcpa → tools → success → home
```

> ⚠️ Order changed in pivot: verify-phone now comes before profile (phone is auth, not profile data).

| Screen         | File                                                 | Purpose                                                                            |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `welcome`      | `welcome.tsx`                                        | Splash / value prop (existing, keep as-is)                                         |
| `auth`         | `auth.tsx` (rewritten)                               | Phone number entry — calls Supabase signInWithOtp                                  |
| `verify-phone` | `verify-phone.tsx` (updated)                         | 6-digit OTP — calls Supabase verifyOtp, creates session                            |
| `profile`      | `profile.tsx` (updated)                              | Collect name, university, graduation year (phone removed — already in session)     |
| `tcpa`         | `tcpa.tsx` (existing)                                | SMS consent checkbox — required before any SMS is sent                             |
| `tools`        | `tools.tsx` (updated)                                | Connect Gmail + GCal (required), Canvas URL (optional), syllabus upload (optional) |
| `success`      | `success.tsx` (existing)                             | Confirmation — triggers welcome SMS, navigates to home                             |
| `home`         | `index.tsx` (existing)                               | Main dashboard                                                                     |

---

## Screen Design Details

### Auth Screen (`auth.tsx`) — REWRITTEN

- Single phone number input using existing `PhoneInput` component (US formatting, 10-digit validation)
- "Send code" button disabled until 10 digits entered
- On submit: convert to E.164 (`+1XXXXXXXXXX`), call `supabase.auth.signInWithOtp({ phone })`
- On success: navigate to `verify-phone` with E.164 phone as route param
- On error: show inline error below the phone input

> Apple Sign-In and Google OAuth removed. `expo-apple-authentication` uninstalled.

### Verify Phone Screen (`verify-phone.tsx`) — UPDATED

- Repurpose existing `PinInput` component (6 digits, auto-focus, auto-submit)
- On mount: start 30s resend cooldown (OTP already sent by auth screen — no API call on mount)
- On 6-digit entry: call `supabase.auth.verifyOtp({ phone, token: code, type: 'sms' })` — this creates the session
- Error handling: Supabase "expired" message → "Code expired, tap Resend"; other errors → "That code didn't match"
- Resend: call `supabase.auth.signInWithOtp({ phone })`, restart cooldown
- On success: navigate to `profile`

### Profile Screen (`profile.tsx`) — UPDATED

- Form fields: name, university, graduation year (**phone removed** — already captured and verified)
- On submit: call `POST /api/onboarding/profile` with `{ name, university, graduation_year }` only
- Backend reads phone from `user.phone` in the Supabase session
- On success: navigate to `tcpa`

### TCPA Screen (`tcpa.tsx`)

- Keep existing implementation unchanged
- Writes `has_alert_consent` to `preferences_json`
- Defaults OFF — user must explicitly toggle ON

### Tools Screen (`tools.tsx`) — UPDATED

- **Required section:** Gmail + Google Calendar
  - On mount: query `integrations` table for a `google` row (`platform = 'google'`) for this user
  - If found: show "Connected ✓" badge
  - If not found (all phone-auth users arrive unconnected): show "Connect Google" button
  - "Connect Google": opens `GET /api/auth/google?user_id=<uuid>` in `WebBrowser.openBrowserAsync`
    - Backend handles CSRF, Google OAuth redirect, code exchange, Fernet-encrypted token storage via Celery
  - After browser closes: poll `integrations` table every 1.5s (up to 12s) to confirm tokens stored
  - Continue button disabled until `googleConnected = true`
- **Optional section:** unchanged
  - Canvas iCal URL: input field + validate button (calls `POST /api/sync/canvas`)
  - Syllabus PDF: file picker per course (calls `POST /api/upload/syllabus`)
  - Google Classroom: "Coming soon" badge
- `expo-auth-session`, `expo-crypto`, and nonce logic removed from this screen

### Success Screen (`success.tsx`)

- On mount: call `POST /api/onboarding/complete`
- Show "Aria is setting up your account" loading state
- "Enter Aria" CTA → `router.replace('/(home)')`
- Welcome SMS sent from Twilio number within seconds

---

## API Contracts

### `POST /api/onboarding/profile` — UPDATED

```typescript
Request:  { name: string; university: string; graduation_year: number }
// phone field REMOVED — backend reads from user.phone in Supabase session
Response: { ok: true }
Errors:   400 (invalid input), 401 (auth required)
```

### ~~`POST /api/auth/phone/send`~~ — DELETED

Replaced by `supabase.auth.signInWithOtp({ phone })` called client-side from `auth.tsx`.
Route file deleted: `src/app/api/auth/phone/send/route.ts`

### ~~`POST /api/auth/phone/verify`~~ — DELETED

Replaced by `supabase.auth.verifyOtp({ phone, token, type: 'sms' })` called client-side from `verify-phone.tsx`.
Route file deleted: `src/app/api/auth/phone/verify/route.ts`

### `GET /api/auth/google` — UNCHANGED (used by tools screen)

Opens in browser via `WebBrowser.openBrowserAsync`. No changes to this route.

### `POST /api/sync/canvas` (fixed)

```typescript
Request:  { ical_url: string }
Response: { deadline_count: number; sample_courses: string[] }
Errors:   400 (bad format), 408 (timeout), 422 (empty feed)
```

### `POST /api/onboarding/complete`

```typescript
Request:  {} (user_id from JWT)
Response: { ok: true }
Side effects:
  - Sets `onboarding_completed_at = now()` in users table
  - Enqueues `tasks.welcome_briefing` Celery task
```

---

## Backend Implementation

### Database (`supabase/migrations/008_onboarding_completion.sql`)

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
```

### New Routes

| Route                           | File                                       | Purpose                                           |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `POST /api/onboarding/profile`  | `src/app/api/onboarding/profile/route.ts`  | Save user profile (name, phone, university, year) |
| `POST /api/auth/phone/send`     | `src/app/api/auth/phone/send/route.ts`     | Initiate Twilio Verify OTP send                   |
| `POST /api/auth/phone/verify`   | `src/app/api/auth/phone/verify/route.ts`   | Verify OTP, mark phone verified                   |
| `POST /api/onboarding/complete` | `src/app/api/onboarding/complete/route.ts` | Trigger welcome SMS, set completion timestamp     |

### Modified Routes

- `src/app/api/sync/canvas/route.ts` — Replace stub with real validation:
  - Parse iCal URL format
  - Fetch iCal bytes (10s timeout)
  - Count VEVENT entries
  - Extract course names from event titles
  - Return `{ deadline_count, sample_courses }` or error

### Environment Variables

```bash
TWILIO_VERIFY_SERVICE_SID=   # Create new Verify Service in Twilio Console (separate from TWILIO_ACCOUNT_SID)
```

---

## Mobile Implementation

### New Screens (Create)

- `mobile/app/(onboarding)/auth.tsx` — Apple Sign-In + Google OAuth entry point
- `mobile/app/(onboarding)/profile.tsx` — User profile collection
- `mobile/app/(onboarding)/verify-phone.tsx` — 6-digit OTP screen (repurpose `verify.tsx` UI)
- `mobile/app/(onboarding)/tools.tsx` — Integration connection hub
- `mobile/app/(onboarding)/success.tsx` — Onboarding completion screen

### Screens to Delete

- `mobile/app/(onboarding)/phone.tsx` — Replaced by `profile.tsx`
- `mobile/app/(onboarding)/verify.tsx` — Repurposed as `verify-phone.tsx`
- `mobile/app/(onboarding)/canvas.tsx` — Functionality moved to `tools.tsx`
- `mobile/app/(onboarding)/google.tsx` — Functionality moved to `auth.tsx`
- `mobile/app/(onboarding)/preview.tsx` — Replaced by `success.tsx`

### Navigation Update

- `mobile/app/(onboarding)/_layout.tsx`
  - Update screen order: `welcome` → `auth` → `profile` → `verify-phone` → `tcpa` → `tools` → `success`
  - Remove deleted screens from route configuration

### API Client Update

- `mobile/lib/api.ts` — Add methods:
  ```typescript
  saveProfile(data: { name, phone, university, graduation_year }): Promise<void>
  sendPhoneOtp(phone: string): Promise<void>
  verifyPhoneOtp(phone: string, code: string): Promise<void>
  completeOnboarding(): Promise<void>
  uploadSyllabus(file: File, courseName: string): Promise<void>
  // validateCanvasUrl() already exists
  ```

### Dependencies

- `npx expo install expo-apple-authentication` — Required for Apple Sign-In
- `mobile/app.json` — Add `NSFaceIDUsageDescription` for App Store compliance

### Post-Onboarding (Phase D)

- `mobile/app/(home)/preferences.tsx` — Surface integration management:
  - Google: show connected/disconnected status, reconnect button
  - Canvas: edit iCal URL, re-validate, disconnect
  - Syllabi: list uploaded syllabi, add/remove per course
  - Google Classroom: "Coming soon" card

---

## Key Architectural Changes

1. **Welcome SMS Decoupled** — `tasks.welcome_briefing` no longer fires on first Canvas sync. It fires only when `POST /api/onboarding/complete` is called. Do NOT re-couple these.

2. **Phone Verification Two-Step** — Phone OTP is separate from auth OTP:
   - Auth OTP (old): `TWILIO_ACCOUNT_SID` + `TWILIO_PHONE_NUMBER` (Twilio Messaging)
   - Phone OTP (new): `TWILIO_VERIFY_SERVICE_SID` (Twilio Verify — different service, must be created separately)

3. **Google Scopes at Auth Time** — Google OAuth now requests `calendar` + `gmail.readonly` at the auth screen, not at the tools screen. This simplifies the tools screen logic for Google-authenticated users.

4. **Apple Requires Separate Google Connect** — Apple Sign-In doesn't grant Google scopes. The tools screen must detect this and prompt for Google connection before allowing Continue.

---

## Testing Strategy (Summary)

### Backend Tests

- **`tests/api/test_onboarding_profile.py`** — Profile save, auth required, missing fields
- **`tests/api/test_phone_otp.py`** — Send OTP (mock Twilio Verify), verify correct/wrong/expired codes
- **`tests/api/test_canvas_validation.py`** — Valid/bad/timeout/empty iCal URLs
- **`tests/api/test_onboarding_complete.py`** — Triggers welcome_briefing task, idempotent

### Mobile Tests

- Expand existing stub tests in `__tests__/onboarding.test.tsx` and `__tests__/auth.test.tsx`
- Mock `expo-apple-authentication`, `expo-auth-session`
- Verify screen navigation, form validation, API call routing

### Integration Tests

1. Dev server: `npm run dev` + Docker Compose (Celery+Redis)
2. Simulator test (Google path):
   - Sign in with Google → Supabase session created
   - Fill profile → OTP SMS arrives
   - Enter OTP → `phone_verified = true`
   - TCPA toggle → consent recorded
   - Skip optional tools → Continue enabled
   - Complete → welcome SMS received
3. Device test (Apple path) — requires TestFlight build

---

## Implementation Sequence

**Phase A (Backend) — ✅ COMPLETE**
**Phase B (Mobile) — ✅ COMPLETE (original OAuth design)**

**Phase C — Auth Pivot (in progress):**

> Full task breakdown in `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md`

0. **Manual:** Enable Supabase phone auth provider + configure Twilio in Supabase dashboard
1. Delete `src/app/api/auth/phone/send/route.ts` and `verify/route.ts`
2. Update `src/app/api/onboarding/profile/route.ts` — read phone from session
3. Update `mobile/lib/api.ts` — remove OTP methods, update saveProfile, export API_BASE
4. Rewrite `mobile/app/(onboarding)/auth.tsx` — phone entry + signInWithOtp
5. Update `mobile/app/(onboarding)/verify-phone.tsx` — verifyOtp, navigate to profile
6. Update `mobile/app/(onboarding)/profile.tsx` — remove phone field, navigate to tcpa
7. Update `mobile/app/(onboarding)/tools.tsx` — WebBrowser Google connect + integrations poll
8. Update `mobile/app/(onboarding)/_layout.tsx` — reorder verify-phone before profile
9. `npm uninstall expo-apple-authentication`

**Phase C — Integration Test:**
- Phone OTP path on simulator: enter phone → OTP → profile → TCPA → Google connect → complete → welcome SMS

**Phase D (Post-Flow):**
- Update `mobile/app/(home)/preferences.tsx` for disconnect/reconnect

---

## Files to Create / Modify

### New Files (Create)
- `src/app/api/onboarding/profile/route.ts` — Save user profile (name, phone, university, year)
- `src/app/api/auth/phone/send/route.ts` — Send OTP via Twilio Verify
- `src/app/api/auth/phone/verify/route.ts` — Verify OTP, mark phone verified
- `src/app/api/onboarding/complete/route.ts` — Trigger welcome SMS, set completion timestamp
- `supabase/migrations/008_onboarding_completion.sql` — Add `phone_verified` and `onboarding_completed_at` columns
- `mobile/app/(onboarding)/auth.tsx` — Apple Sign-In + Google OAuth entry point
- `mobile/app/(onboarding)/profile.tsx` — User profile collection (name, phone, university, year)
- `mobile/app/(onboarding)/verify-phone.tsx` — 6-digit OTP verification screen
- `mobile/app/(onboarding)/tools.tsx` — Integration connection hub (Gmail/GCal required, Canvas/Syllabus optional)
- `mobile/app/(onboarding)/success.tsx` — Onboarding completion screen, triggers welcome SMS

### Modified Files (Existing, Update)
- `src/app/api/sync/canvas/route.ts` — Replace stub with real validation (return `deadline_count`, `sample_courses`)
- `mobile/app/(onboarding)/_layout.tsx` — Update screen order: `welcome` → `auth` → `profile` → `verify-phone` → `tcpa` → `tools` → `success`
- `mobile/lib/api.ts` — Add new methods: `saveProfile()`, `sendPhoneOtp()`, `verifyPhoneOtp()`, `completeOnboarding()`, `uploadSyllabus()`
- `mobile/app/(home)/preferences.tsx` — Add integration management (connect/disconnect Google, Canvas, Syllabi)
- `mobile/package.json` — Add `expo-apple-authentication` dependency

### Deleted Files (Remove)
- `mobile/app/(onboarding)/phone.tsx` — Replaced by `profile.tsx`
- `mobile/app/(onboarding)/verify.tsx` — Repurposed as `verify-phone.tsx`
- `mobile/app/(onboarding)/canvas.tsx` — Functionality moved to `tools.tsx`
- `mobile/app/(onboarding)/google.tsx` — Functionality moved to `auth.tsx`
- `mobile/app/(onboarding)/preview.tsx` — Replaced by `success.tsx`

---

## Execution Strategy

### Recommended Approach

Use parallel execution for independent backend + mobile tracks to maximize velocity:

1. **Lock API contracts first** — implement all backend routes and document contracts before mobile work begins
2. **Parallel backend & mobile** — two developers work on separate worktrees (backend and mobile) simultaneously
3. **Integration test** — after both tracks complete, test end-to-end on simulator (Google path) and device (Apple path)
4. **Code review** — review backend and mobile changes against this spec

### Skills and Agents to Use

| Task | Skill/Agent | Reasoning |
|------|-------------|-----------|
| **Parallel execution** | `superpowers:dispatching-parallel-agents` | Backend (Josh) and mobile (Seb) are independent; run in parallel |
| **Backend implementation** | `superpowers:executing-plans` (or `gsd-executor`) | Follow Phase A of plan exactly, atomic commits per route |
| **Mobile implementation** | `superpowers:executing-plans` (or `gsd-executor`) | Follow Phase B of plan exactly, atomic commits per screen |
| **TDD for all code** | `superpowers:test-driven-development` | Write tests first for all routes and screens |
| **Final code review** | `superpowers:requesting-code-review` or `gsd:code-review` | Verify implementation matches plan and spec before merge |
| **Verification** | `superpowers:verification-before-completion` | Cross-check against spec before claiming work done |
| **DB migration** | `gsd:fast` (or manual) | Single-file migration, low risk, can execute independently |

### Worktree Isolation (Optional but Recommended)

Use git worktrees to isolate concurrent work:

```bash
# Backend developer (Josh)
git worktree add -b onboarding-backend ../aria-backend onboarding
cd ../aria-backend
# Work on src/app/api/*, supabase/migrations/

# Mobile developer (Seb)
git worktree add -b onboarding-mobile ../aria-mobile onboarding
cd ../aria-mobile
# Work on mobile/app/(onboarding)/, mobile/lib/api.ts
```

After each developer finishes, merge their branch to `onboarding`, then merge `onboarding` to `main`.

---

## Execution Order (Sequence)

```
Phase A (Backend) — Josh
├─ 1. DB migration (A7)                   ~15 min
├─ 2. POST /api/onboarding/profile (A1)   ~1 hr
├─ 3. POST /api/auth/phone/send (A4)      ~45 min
├─ 4. POST /api/auth/phone/verify (A5)    ~45 min
├─ 5. Fix POST /api/sync/canvas (A2)      ~1.5 hrs
├─ 6. POST /api/onboarding/complete (A3)  ~30 min
└─ 7. Verify Apple in Supabase (A6)       ~15 min (manual)
    Total: ~5–5.5 hrs

Phase B (Mobile) — Seb — START AFTER Phase A API contracts locked
├─ 1. Install expo-apple-authentication   ~2 min
├─ 2. Create auth.tsx                     ~1 hr
├─ 3. Create profile.tsx                  ~1 hr
├─ 4. Create verify-phone.tsx             ~45 min
├─ 5. Create tools.tsx                    ~2 hrs
├─ 6. Create success.tsx                  ~30 min
├─ 7. Update _layout.tsx + api.ts         ~30 min
└─ 8. Delete old screens                  ~10 min
    Total: ~7–7.5 hrs

Phase C (Integration) — Both
├─ 1. Integration test (simulator)        ~1 hr
├─ 2. Code review (backend)               ~30 min
├─ 3. Code review (mobile)                ~30 min
└─ 4. Fix review findings & merge         ~30 min
    Total: ~2.5 hrs

Phase D (Post-Flow) — Seb — After core flow ships
└─ Update preferences.tsx                 ~2 hrs
```

**Total estimate: ~15–17 hrs (A+B in parallel: ~13–14 hrs + C integration: ~2.5 hrs)**

---

## Key Gotchas

- **Twilio Verify is separate** — `TWILIO_VERIFY_SERVICE_SID` ≠ `TWILIO_ACCOUNT_SID`. Create independently in Twilio Console.
- **Apple path requires Google prompt** — Don't skip the "Connect Google" button in tools screen for Apple auth users.
- **NSFaceIDUsageDescription required** — Must be in `mobile/app.json` for App Store review.
- **Canvas validation is not a stub** — Return real `deadline_count` and `sample_courses`, not placeholder data.
- **Welcome SMS triggered explicitly** — Not by Canvas sync. Call `POST /api/onboarding/complete` to send it.
