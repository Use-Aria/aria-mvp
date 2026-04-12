# Aria — Session Progress

> Last updated: 2026-04-12 (session 4)
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### OB-C3 — Simulator Integration Test (IN PROGRESS, 2026-04-12 session 4)

**Fixed `/api/onboarding/complete` 401 bug:**
- Route was using `createClient()` (cookie-based auth) — same bug as profile route from session 3
- Fixed: reads JWT from `Authorization: Bearer` header, uses `adminClient.auth.getUser(jwt)`
- Removed unused `import { createClient } from '@/lib/supabase/server'`
- File: `src/app/api/onboarding/complete/route.ts`

**Simulator loading spinner hang diagnosed:**
- Symptom: App loads (Metro bundles fine), but spinner never resolves
- Root cause: `supabase.auth.getSession()` in `useSession.ts` hangs when a stale/expired session exists in SecureStore — Supabase tries to refresh it via network, which can hang
- Fix: **Device → Erase All Content and Settings** in simulator to wipe SecureStore. Then reinstall (press `i` in Metro). This forces `getSession()` to return `null` immediately with no network call.
- Testing was blocked by a slow Mac — restart pending.

---

### OB-C3 — Simulator Integration Test (IN PROGRESS, 2026-04-12 session 3)

**OB-P0 COMPLETE** — Supabase phone auth fully configured:
- Twilio Messaging Service created (`MGbf33d2d3327638ca21a7f05be5e138ba`)
- Toll-free verification submitted (pending approval, 1–3 business days)
- Supabase phone provider enabled with Twilio Account SID + Auth Token + Messaging Service SID
- Test phone number added with OTP `123456`

**Bugs fixed during simulator testing:**

| Bug | Fix | File |
|-----|-----|------|
| `PhoneInput` corrupted digits (country code `1` leaking into number) | Strip leading `1` in `handleChangeText` | `mobile/components/onboarding/PhoneInput.tsx` |
| `maxLength={15}` cut off full E.164 formatted number | Changed to `maxLength={18}` | `mobile/components/onboarding/PhoneInput.tsx` |
| Send button activated at 9 digits instead of 10 | Changed validation to `>= 11` (formatted value includes country code `1`) | `mobile/app/(onboarding)/auth.tsx` |
| `Network request failed` (Supabase calls failing) | Added `react-native-url-polyfill/auto` as first import in `_layout.tsx` | `mobile/app/_layout.tsx` |
| `Network request failed` (Supabase using `whatwg-fetch` polyfill) | Added `global: { fetch: fetch.bind(globalThis) }` to Supabase client | `mobile/lib/supabase.ts` |
| `EXPO_PUBLIC_DEMO_MODE=true` bypassing auth | Set to `false` | `mobile/.env` |
| After OTP verification → jumped to home, skipped profile/tcpa/tools | `_layout.tsx` redirected to home on any session; now checks `onboarding_completed_at` from DB | `mobile/app/_layout.tsx` |
| App reboot with incomplete onboarding → home screen | Added missing routing case: `session && !onboardingDone && !inOnboarding → tcpa` | `mobile/app/_layout.tsx` |
| `POST /api/onboarding/profile` 401 | Route used cookie-based auth; mobile sends Bearer token. Fixed to read JWT from `Authorization` header | `src/app/api/onboarding/profile/route.ts` |
| `Database error saving new user` | `public.users."Email"` column had NOT NULL constraint not in migrations | `supabase/migrations/009_fix_email_not_null.sql` (pushed) |
| Back navigation threw `GO_BACK` error | Stack cleared by `router.replace`; fixed all back buttons to use explicit `router.replace('/(onboarding)/...')` | all onboarding screens |
| `router.back()` on verify-phone failed | Changed to `router.replace('/(onboarding)/auth')` | `mobile/app/(onboarding)/verify-phone.tsx` |

**Back buttons added to:** `verify-phone` (→ auth), `profile` (→ verify-phone), `tcpa` (→ profile), `tools` (→ tcpa)

---

## Current Status

**OB-C3 IN PROGRESS.** All known API bugs fixed. Simulator test blocked by slow Mac (restart pending).

**Before resuming simulator test:**
1. Run `Device → Erase All Content and Settings` in simulator (clears stale SecureStore session that causes spinner hang)
2. Start Next.js: `cd /Users/daniellee/Code/aria-mvp && npm run dev`
3. Start Metro: `cd mobile && npx expo start --clear` → press `i`
4. Walk through full flow: phone → OTP → profile → TCPA → tools → success → home

**Next test checkpoint:** Tools screen → tap "Connect Google" → OAuth opens in browser → poll completes → tap Continue → success screen → confirm welcome SMS fires → land on home.

---

## OB-P0 — COMPLETE ✅

All Supabase phone auth setup done. Twilio toll-free verification pending (background, doesn't block testing).

---

## Next Steps (in order)

| Step | What | Who |
|------|------|-----|
| **OB-C3 cont.** | Erase simulator (Device → Erase All Content and Settings) to clear stale SecureStore session. Then: `npm run dev` + `npx expo start --clear`. Walk full flow from welcome screen. At tools: tap "Connect Google" → OAuth opens in browser → poll completes → Continue → success screen → welcome SMS fires → home. | Daniel |
| **OB-C3 debug** | `onboarding/complete` route connects to Redis (`redis://localhost:6379/0`) — Redis must be running locally for welcome SMS to enqueue. Run `docker-compose up redis` in `aria-mvp` root if welcome SMS doesn't fire | Daniel |
| **OB-C4** | Code review all changed files, fix findings | Daniel |
| **OB-C5** | Merge `onboarding` → `main` | Daniel |
| **OB-D1** | `mobile/app/(home)/preferences.tsx` — add logout + integration management UI | Daniel |

---

## IMPORTANT: `/api/onboarding/complete` — FIXED ✅

Fixed in session 4. Now reads JWT from `Authorization: Bearer` header (same pattern as profile route). `import { createClient } from '@/lib/supabase/server'` removed.

---

## Critical Jest Fix Applied (session 1)

**Problem:** Expo 55 winter runtime installs lazy getters for `structuredClone`, `__ExpoImportMetaRegistry` etc. on `global`. When these fire during React test rendering, they try to `require()` from Jest's torn-down module scope → "You are trying to import a file outside of the scope of the test code."

**Fix:** `mobile/jest.globals.js` (added to `setupFiles` in `jest.config.js`) pre-defines those globals as **non-configurable** before Expo loads, preventing Expo's `installGlobal()` from overwriting them with lazy getters.

**Also:** `mobile/__mocks__/empty.js` + `moduleNameMapper` entry (belt-and-suspenders — can remove if unneeded).

---

## Test Status

All 11 tests in `mobile/__tests__/onboarding.test.tsx` pass. Run:

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --verbose
```

---

## Key File Locations

| What | Where |
|------|-------|
| Phase C pivot plan (full task list) | `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md` |
| Onboarding spec (screen flow, API contracts) | `docs/onboarding-redesign-spec.md` |
| Onboarding test file | `mobile/__tests__/onboarding.test.tsx` |
| Jest globals fix | `mobile/jest.globals.js` |
| Branch | `onboarding` |

---

## Running the Simulator

```bash
# Terminal 1 — Next.js backend (REQUIRED for profile/complete API routes)
cd /Users/daniellee/Code/aria-mvp && npm run dev

# Terminal 2 — Expo Metro
open -a Simulator   # wait for simulator to boot
cd mobile && npx expo start --clear
# Press i to open in iOS simulator
```

**To force fresh onboarding:** Delete Expo Go from simulator → press `i` in Metro to reinstall.

---

## Architecture Gotchas

> Permanent — these survive across sessions.

| Gotcha | Rule |
|--------|------|
| Course matching | `syllabi.course_name` vs `canonical_events.course_id` — always use ILIKE |
| Windows strftime | `%-I` fails on Windows; use `%I` + `.lstrip("0").lower()` |
| Lazy import patching | Patch at the SOURCE module, never the importing module |
| Token encryption boundary | Next.js callback NEVER writes tokens to Supabase directly |
| GCal/Gmail watch expiry | Watch channels expire every 7 days — `renew-watch-channels` Beat task runs every 6h |
| Google OAuth verification | Gmail readonly is sensitive scope — app verification takes 1–6 weeks |
| PDF bytes | Never persisted — only base64 passes through Redis queue |
| Re-parse guard | `check_existing_syllabus()` skips Claude call if `parsed_json` already exists |
| On-demand scheduling flow | Redis pending state (5-min TTL) bridges two-message confirm flow |
| conftest autouse | `tests/ai/conftest.py` stubs Redis intercepts — new schedule tests must patch `sms.schedule.*` directly |
| Expo winter runtime in Jest | Pre-define `structuredClone` + `__ExpoImportMetaRegistry` as non-configurable in `jest.globals.js` — see fix above |
| PhoneInput test input | `fireEvent.changeText` with RAW DIGITS only (e.g. `'5551234567'`), not formatted string. Formatted string double-counts the `+1` country code. |
| PinInput testID | `PinInput` accepts `testID` prop forwarded to root View with `onComplete` — `fireEvent(el, 'complete', code)` works |
| Phone in profile route | Since pivot: phone is NOT in request body — backend reads `user.phone` from Supabase JWT session |
| getSession() mock in tests | The test mock returns a plain object (not Promise). Use `await supabase.auth.getSession()` pattern, NOT `.then()` — awaiting a non-promise returns the value directly |
| Text.disabled for testing | RN `Text` has a `disabled` prop explicitly for testing. Pass `disabled={condition}` to `<Text>` to make `getByText(...).parent?.props.disabled` work in test renderer. Neither `TouchableOpacity` nor `Pressable` exposes `disabled` on their rendered host element. |
| Supabase phone auth Twilio field | Supabase wants a **Messaging Service SID** (`MG...`), NOT the raw phone number and NOT the Verify Service SID (`VA...`). Create in Twilio Console → Messaging → Services. |
| Mobile API auth | Mobile app sends `Authorization: Bearer <jwt>`. Next.js API routes must read JWT from `Authorization` header using `adminClient.auth.getUser(jwt)` — NOT from cookies (`createClient()` reads cookies, not Bearer tokens). |
| react-native-url-polyfill | Must be imported as FIRST import in `mobile/app/_layout.tsx` — without it, Supabase network requests fail intermittently with `Network request failed` (status 0) |
| EXPO_PUBLIC_DEMO_MODE | Set to `false` in `mobile/.env` for real auth testing. `true` injects fake session and skips all auth/onboarding. |
| Onboarding routing | `_layout.tsx` checks `onboarding_completed_at` from `public.users` to decide routing. Three cases: (1) no session → welcome, (2) session + done → home, (3) session + not done + not in onboarding → tcpa |
| Back navigation in onboarding | `router.replace()` clears stack — `router.back()` throws `GO_BACK not handled`. Use explicit `router.replace('/(onboarding)/[screen]')` for all back buttons. |
| Next.js dev server required | Mobile app calls Next.js API routes at `EXPO_PUBLIC_API_URL`. Must run `npm run dev` in `aria-mvp` root during local testing. In production, set `EXPO_PUBLIC_API_URL` to Vercel URL. |
| /api/onboarding/complete Redis | Route tries to connect to Redis at `redis://localhost:6379/0` to enqueue welcome SMS. Redis must be running (Docker) for this to succeed. If Redis not running, route will hang/error. |
| Simulator spinner hang on launch | If app shows spinner forever with Metro bundled and no requests hitting Next.js: stale/expired Supabase session in SecureStore is causing `getSession()` to attempt a token refresh that hangs. Fix: **Device → Erase All Content and Settings** in simulator, then reinstall via Metro. Do this at the start of every fresh simulator test session. |
