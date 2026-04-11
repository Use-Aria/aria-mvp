# Onboarding Redesign — Spec

> Created: 2026-04-10
> Status: Phases A (backend) + B (mobile) complete. Next: Phase C integration test + code review + merge.
> Branch: `onboarding`
> Full plan: `./.claude/plans/quiet-wandering-ullman.md`

---

## Overview

The original onboarding flow used phone number as the primary auth method (OTP via Twilio Messaging). This is being replaced with a standard OAuth-first flow (Apple Sign-In or Google) while retaining phone verification as a separate step using Twilio Verify.

Gmail and Google Calendar are promoted to **required** integrations. Canvas is **optional**. Canvas validation is no longer a stub — it returns real deadline counts.

Welcome SMS is decoupled from Canvas sync and triggered explicitly at onboarding completion.

---

## Screen Flow

```
welcome → auth → profile → verify-phone → tcpa → tools → success → home
```

| Screen         | File                                                 | Purpose                                                                            |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `welcome`      | `welcome.tsx`                                        | Splash / value prop (existing, keep as-is)                                         |
| `auth`         | `auth.tsx` (new)                                     | Apple Sign-In or Google OAuth — replaces old phone entry screen                    |
| `profile`      | `profile.tsx` (new)                                  | Collect name (pre-filled), phone, university, graduation year                      |
| `verify-phone` | `verify-phone.tsx` (new, repurposes `verify.tsx` UI) | 6-digit OTP verification via Twilio Verify                                         |
| `tcpa`         | `tcpa.tsx` (existing)                                | SMS consent checkbox — required before any SMS is sent                             |
| `tools`        | `tools.tsx` (new)                                    | Connect Gmail + GCal (required), Canvas URL (optional), syllabus upload (optional) |
| `success`      | `success.tsx` (new)                                  | Confirmation — triggers welcome SMS, navigates to home                             |
| `home`         | `index.tsx` (existing)                               | Main dashboard                                                                     |

---

## Screen Design Details

### Auth Screen (`auth.tsx`)

- Two buttons: "Sign in with Apple" + "Sign in with Google"
- Apple uses `expo-apple-authentication`
- Google uses `expo-auth-session` with nonce-based OIDC (same as current `google.tsx`)
- Google path: requests `calendar` + `gmail.readonly` scopes together
- Apple path: grants no Google scopes at auth time — user must connect Google in tools screen
- On success: navigate to `profile`

### Profile Screen (`profile.tsx`)

- Form fields: name (pre-filled from `session.user.user_metadata.full_name`), phone, university, graduation year
- Phone number format: any digits, validated client-side
- On submit: call `POST /api/onboarding/profile`, pass phone to `verify-phone` route param
- On success: navigate to `verify-phone`

### Verify Phone Screen (`verify-phone.tsx`)

- Repurpose existing `verify.tsx` PinInput component (6 digits, auto-focus, auto-submit)
- On mount: call `POST /api/auth/phone/send` with phone from route params
- On 6-digit entry: call `POST /api/auth/phone/verify` with phone + code
- Error handling: 410 → "Code expired, tap Resend", 422 → "Wrong code, try again"
- Resend button: visible after 30s cooldown
- On success: navigate to `tcpa`

### TCPA Screen (`tcpa.tsx`)

- Keep existing implementation unchanged
- Writes `has_alert_consent` to `preferences_json`
- Defaults OFF — user must explicitly toggle ON

### Tools Screen (`tools.tsx`)

- **Required section:** Gmail + Google Calendar
  - Check: `session.user.app_metadata.provider === 'google'`?
  - If yes: show "Connected ✓" badge, no action needed
  - If no (Apple auth): show "Connect Google" button, re-trigger Google OAuth flow
  - Continue button disabled until `googleConnected = true`
- **Optional section:**
  - Canvas iCal URL: input field + validate button (calls `POST /api/sync/canvas`)
  - Syllabus PDF: file picker per course (calls `POST /api/upload/syllabus`)
  - Google Classroom: "Coming soon" badge (no functionality)
- User can skip optional integrations

### Success Screen (`success.tsx`)

- On mount: call `POST /api/onboarding/complete`
- Show "Aria is setting up your account" loading state
- "Enter Aria" CTA → `router.replace('/(home)')`
- Welcome SMS sent from Twilio number within seconds

---

## API Contracts

### `POST /api/onboarding/profile`

```typescript
Request:  { name: string; phone: string; university: string; graduation_year: number }
Response: { ok: true }
Errors:   400 (invalid input), 401 (auth required)
```

### `POST /api/auth/phone/send`

```typescript
Request:  { phone: string }  // E.164 format: +12025551234
Response: { ok: true }
Errors:   400 (invalid format), 401 (auth required)
```

### `POST /api/auth/phone/verify`

```typescript
Request:  { phone: string; code: string }  // 6-digit code
Response: { ok: true }
Errors:   410 (expired), 422 (wrong code), 401 (auth required)
Side effect: Sets `phone_verified = true` in users table
```

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

**Phase A (Backend):**

1. Push DB migration (requires `SUPABASE_ACCESS_TOKEN`)
2. Implement `POST /api/onboarding/profile`
3. Implement `POST /api/auth/phone/send` and `POST /api/auth/phone/verify`
4. Fix `POST /api/sync/canvas` stub
5. Implement `POST /api/onboarding/complete`
6. Verify Apple is enabled in Supabase Auth

**Phase B (Mobile, after API contracts locked):**

1. Install `expo-apple-authentication`
2. Create `auth.tsx` (Apple + Google OAuth)
3. Create `profile.tsx`
4. Create `verify-phone.tsx`
5. Create `tools.tsx`
6. Create `success.tsx`
7. Update `_layout.tsx` and `mobile/lib/api.ts`
8. Delete old screens

**Phase C (Post-Flow):**

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
