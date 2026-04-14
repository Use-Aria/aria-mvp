# Aria — Session Progress

> Last updated: 2026-04-14 (session 8)
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### OB-C4 + OB-C5 ✅ COMPLETE — Onboarding fully merged to main (2026-04-14 session 8)

**Features + fixes shipped:**

1. **LOCALDEV.md reset procedure** — removed Option A (partial reset), kept only full reset as a single 3-step procedure: (1) erase simulator, (2) delete from `public.users` + `auth.users`, (3) revoke Google OAuth at myaccount.google.com/permissions

2. **TCPA screen — Option 2 (optional consent)**
   - Heading/subtext updated to cover briefings + alerts (was narrow "quiet hours" framing)
   - Toggle defaults OFF, Continue button always enabled (was blocked)
   - Warning block shown when toggle is OFF: "Without this, Aria won't send morning briefings or deadline alerts. You'll need to text Aria to get updates."
   - Warning hidden when toggle is ON
   - Button renamed "Confirm" → "Continue"
   - 5 new TCPA tests added; 23/23 tests passing

3. **Success → home transition fix (`_layout.tsx`)**
   - Root cause: segment change triggered `onboardingDone` reset to `null` → full-screen ActivityIndicator unmounted the Stack → home remounted → twitching/lag
   - Fix: don't show spinner when `segments[0] === '(home)'` — Stack stays mounted, transition is smooth

4. **OB-C4 code review findings fixed (all critical + important):**
   - `src/app/api/sync/canvas/route.ts` — normalise `webcal://` → `https://` before `new URL()` (was crashing with 400)
   - `mobile/app/(onboarding)/profile.tsx` — back button now reads phone from `supabase.auth.getSession()` and passes it as explicit param to verify-phone via `router.replace({ pathname, params: { phone } })`
   - `src/app/api/onboarding/profile/route.ts` — graduation year lower bound corrected: `2020` → `2024`
   - `mobile/components/onboarding/CanvasUrlInput.tsx` — removed dead 10-line comment block + duplicate `onValidate()` calls in `handleValidate`, removed unused `CANVAS_URL_REGEX`
   - `mobile/app/_layout.tsx` — incomplete onboarding resume target changed from `tcpa` → `profile` (was skipping name/university/year collection)

5. **OB-C5 — Merged `onboarding` → `main`, pushed to GitHub**
   - `onboarding` branch deleted (local + remote)
   - Celery/Docker env var fixes also committed: `SUPABASE_URL` fallback to `NEXT_PUBLIC_SUPABASE_URL` in all worker `_get_supabase()` helpers; `docker-compose.yml` switched to `env_file: .env.local`

**Test status:** 23/23 passing. Lint clean on all changed files. Working tree clean on `main`.

**Deferred (known, not blocking):**
- Google OAuth `/api/auth/google` route accepts `user_id` query param with no auth check — architectural limitation of `WebBrowser.openBrowserAsync` (can't send headers). Track for OB-D1.
- Success screen silently proceeds on API failure — user re-enters onboarding on next launch. Low priority hardening.

---

### OB-C3 ✅ COMPLETE + Full Onboarding Redesign (2026-04-12 session 7)

**Major features shipped:**

1. **Canvas iCal URL domain extraction (school-agnostic)**
   - Created `mobile/lib/universities.ts` — 51 confirmed Canvas universities with their domains (Yale, Harvard, MIT, Stanford, Columbia, Princeton, Brown, Dartmouth, Cornell, Penn, Duke, Northwestern, Johns Hopkins, Georgetown, NYU, USC, UC schools, UMich, UTAustin, Georgia Tech, CMU, Vanderbilt, Emory, Notre Dame, Tufts, Rice, Wake Forest, Tulane, Case Western, Boston College, Florida schools, Ohio State, Penn State, UVA, UWash, Illinois, Wisconsin, Purdue, Indiana, Minnesota, Maryland, Colorado, Arizona, Oregon schools, Utah)
   - `canvasDomainForUniversity(name)` helper returns full HTTPS URL
   - "Open Canvas" button domain resolution priority: (1) extract from typed iCal URL, (2) university lookup from DB, (3) null (button disabled + hint text)
   - URL now opens `/calendar` (direct calendar page) instead of hardcoded Yale settings page

2. **University Picker component**
   - `mobile/components/onboarding/UniversityPicker.tsx` — searchable modal with live filter
   - Replaced TextInput in `profile.tsx` — ensures university values are always from confirmed list
   - Test mock updated; all 18 tests passing

3. **Welcome screen copy + integration reordering**
   - Headline: "Your Yale life, under control" → "Your academic life, under control" (school-agnostic)
   - Removed "Setup takes 90 seconds" from subtext
   - Button: "Get started — 90 seconds" → "Get started"
   - Reordered integrations: Gmail+Google Calendar is #1, Canvas is #2

4. **Tools screen major refactor**
   - **Removed:** Syllabus PDF upload entirely (DocumentPicker, handleSyllabusPick, all syllabus state)
   - **Added:** Todoist, iOS Reminders, Google Classroom as "COMING SOON" optional cards (grayed out, 50% opacity)
   - All three are frontend-only (no backend yet) — will be implemented in future phases
   - Canvas guide + Open Canvas button still functional with university lookup

**Files changed:**

- `mobile/lib/universities.ts` (new) — universities data + lookup helper
- `mobile/components/onboarding/UniversityPicker.tsx` (new) — searchable picker component
- `mobile/app/(onboarding)/welcome.tsx` — headline, button text, integration order
- `mobile/app/(onboarding)/profile.tsx` — import + use UniversityPicker
- `mobile/app/(onboarding)/tools.tsx` — domain extraction, syllabus removal, coming-soon cards
- `mobile/__tests__/onboarding.test.tsx` — new UniversityPicker mock, updated profile + tools tests

**Test status:** 18/18 passing (no regressions)

**Plan documents updated:**

- `docs/onboarding-redesign-spec.md` §Tools Screen — tools section now reflects current state
- `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md` — Task 7 has amendment block documenting syllabus removal, university picker, coming-soon items
- `docs/superpowers/plans/2026-04-12-canvas-ical-guide.md` — self-review updated with post-plan amendments

### Canvas iCal Guide — COMPLETE ✅ (2026-04-12 session 6)

**Option A + B implemented:** 3-step inline guide + "Open Canvas" button added to `tools.tsx` Canvas card.

- Guide and button visible only when `canvasStatus !== 'valid'` (hidden once connected)
- "Open Canvas" → `WebBrowser.openBrowserAsync('https://yale.instructure.com/profile/settings#feed_holder')`
- 4 new tests added; 15/15 tests passing
- Commits: `cc227be` (failing tests) → `e7fa823` (test fixes) → `1217e35` (implementation)
- Plan: `docs/superpowers/plans/2026-04-12-canvas-ical-guide.md`
- No backend changes required

**OB-C3 STATUS: COMPLETE ✅** — Full flow confirmed + Canvas guide shipped. Canvas iCal validation non-blocker resolved.

---

### OB-C3 — Simulator Integration Test (NEARLY COMPLETE, 2026-04-12 session 5)

**Full onboarding flow working end-to-end.** Phone → OTP → profile → TCPA → tools → Google connect → success → dashboard. All bugs from this session fixed below.

**Onboarding screen data persistence (new):**

- All screens now hydrate from Supabase on mount so data is restored after app reload
- `profile.tsx`: fetches `name`, `university`, `graduation_year` from `users` table
- `tcpa.tsx`: fetches `has_alert_consent` from `users.preferences_json`
- `tools.tsx`: fetches Canvas `ical_url` from `integrations` table on mount; Google status already worked
- `auth.tsx` / `verify-phone.tsx`: intentionally NOT persisted (no session yet / OTP single-use)

**Google OAuth callback fixes:**

- Root cause 1: Redis was running (Docker started) → callback enqueued Celery task → Celery not running locally → tokens never written → poll timed out
- Fix: route now branches on `NODE_ENV`. Dev writes tokens directly to Supabase (unencrypted). Production uses Redis → Celery → Fernet encryption. Vercel sets `NODE_ENV=production` automatically.
- Root cause 2: `integrations` table had no unique constraint on `(user_id, platform)` → upsert silently failed
- Fix: added migration `010_integrations_unique_constraint.sql` + changed fallback to select-then-insert/update
- File: `src/app/api/auth/google/callback/route.ts`

**Routing race condition fix (`_layout.tsx`):**

- Bug: tapping "Enter Aria" on success screen → `router.replace('/(home)')` → routing effect fired with stale `onboardingDone=false` → redirected back to `tcpa`
- Fix: added `segments[0]` to fetch effect dependency + reset `onboardingDone` to `null` before re-fetching. The routing guard (`onboardingDone === null → return`) blocks redirect until fresh DB value arrives.
- File: `mobile/app/_layout.tsx`

**New files created:**

- `PRODUCTION.md` — all production blockers, launch order, local vs production gaps
- `LOCALDEV.md` — full local dev guide: 3-terminal setup, env vars, onboarding reset SQL, gotchas

**Migration pushed:**

- `supabase/migrations/010_integrations_unique_constraint.sql` — unique index on `(user_id, platform)`

**Google OAuth test users:**

- Added `daniel.lee.dyl27@yale.edu` as a test user in Google Cloud Console → can now click through "Google hasn't verified this app" warning

**Known issues NOT fixed (not blockers for OB-C3):**

- Canvas iCal URL validation failing — will fix separately
- Modal `formSheet` + `transparent` warning in home screen — Seb's code, not onboarding
- 404s on `/api/deadlines` and `/api/chat` — Seb's mock dashboard routes, not built yet

**Onboarding reset procedure (documented in LOCALDEV.md):**

1. Simulator → Device → Erase All Content and Settings
2. SQL: `update public.users set onboarding_completed_at = null where phone = '+1XXXXXXXXXX'`
3. SQL: `delete from public.integrations where user_id = (select id from public.users where phone = '+1XXXXXXXXXX') and platform = 'google'`
   Both steps required — erasing simulator alone isn't enough (Supabase remembers phone → same user → `onboarding_completed_at` still set.

---

## Current Status

**ONBOARDING COMPLETE ✅ — Merged to `main` and pushed to GitHub (2026-04-14).** 23/23 tests passing. Working tree clean. `onboarding` branch deleted.

---

## Next Steps (in order)

| Step | What | Who |
| ---- | ---- | --- |
| **OB-D1** | `mobile/app/(home)/preferences.tsx` — logout button + integration management UI (Google reconnect, Canvas URL edit, coming-soon placeholders). Read `docs/onboarding-redesign-spec.md` §Post-Onboarding for spec. | Daniel |
| **PH10-02** | Fill Apple Developer credentials (`APPLE_ID`, `ASC_APP_ID`, team ID) in `.env.local`, run `eas build --platform ios --profile preview`, verify TestFlight install | Josh |
| **PH11-01** | Deploy Next.js to Vercel, Celery workers to Railway, configure all production env vars (see `PRODUCTION.md`) | Josh |
| **PH12-01** | Privacy Policy, Terms of Service, App Store Connect listing, screenshots, submit for review | Josh + Seb |

---

## IMPORTANT: Google OAuth Callback — Dev vs Production

`src/app/api/auth/google/callback/route.ts` branches on `NODE_ENV`:

- **Development** (`NODE_ENV !== 'production'`): writes tokens directly to Supabase (unencrypted). Redis/Celery not needed.
- **Production** (Vercel sets this automatically): enqueues `encrypt_and_store_tokens` Celery task via Redis. Fernet-encrypted before Supabase write.
- Documented in `PRODUCTION.md` §4b.

---

## IMPORTANT: `/api/onboarding/complete` — FIXED ✅

Fixed in session 4. Now reads JWT from `Authorization: Bearer` header using `adminClient.auth.getUser(jwt)`.

---

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

| Bug                                                                  | Fix                                                                                                             | File                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `PhoneInput` corrupted digits (country code `1` leaking into number) | Strip leading `1` in `handleChangeText`                                                                         | `mobile/components/onboarding/PhoneInput.tsx`             |
| `maxLength={15}` cut off full E.164 formatted number                 | Changed to `maxLength={18}`                                                                                     | `mobile/components/onboarding/PhoneInput.tsx`             |
| Send button activated at 9 digits instead of 10                      | Changed validation to `>= 11` (formatted value includes country code `1`)                                       | `mobile/app/(onboarding)/auth.tsx`                        |
| `Network request failed` (Supabase calls failing)                    | Added `react-native-url-polyfill/auto` as first import in `_layout.tsx`                                         | `mobile/app/_layout.tsx`                                  |
| `Network request failed` (Supabase using `whatwg-fetch` polyfill)    | Added `global: { fetch: fetch.bind(globalThis) }` to Supabase client                                            | `mobile/lib/supabase.ts`                                  |
| `EXPO_PUBLIC_DEMO_MODE=true` bypassing auth                          | Set to `false`                                                                                                  | `mobile/.env`                                             |
| After OTP verification → jumped to home, skipped profile/tcpa/tools  | `_layout.tsx` redirected to home on any session; now checks `onboarding_completed_at` from DB                   | `mobile/app/_layout.tsx`                                  |
| App reboot with incomplete onboarding → home screen                  | Added missing routing case: `session && !onboardingDone && !inOnboarding → tcpa`                                | `mobile/app/_layout.tsx`                                  |
| `POST /api/onboarding/profile` 401                                   | Route used cookie-based auth; mobile sends Bearer token. Fixed to read JWT from `Authorization` header          | `src/app/api/onboarding/profile/route.ts`                 |
| `Database error saving new user`                                     | `public.users."Email"` column had NOT NULL constraint not in migrations                                         | `supabase/migrations/009_fix_email_not_null.sql` (pushed) |
| Back navigation threw `GO_BACK` error                                | Stack cleared by `router.replace`; fixed all back buttons to use explicit `router.replace('/(onboarding)/...')` | all onboarding screens                                    |
| `router.back()` on verify-phone failed                               | Changed to `router.replace('/(onboarding)/auth')`                                                               | `mobile/app/(onboarding)/verify-phone.tsx`                |

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

| Step            | What                                                                                                                                                                                                                                                                                                               | Who    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **OB-C3 cont.** | Erase simulator (Device → Erase All Content and Settings) to clear stale SecureStore session. Then: `npm run dev` + `npx expo start --clear`. Walk full flow from welcome screen. At tools: tap "Connect Google" → OAuth opens in browser → poll completes → Continue → success screen → welcome SMS fires → home. | Daniel |
| **OB-C3 debug** | `onboarding/complete` route connects to Redis (`redis://localhost:6379/0`) — Redis must be running locally for welcome SMS to enqueue. Run `docker-compose up redis` in `aria-mvp` root if welcome SMS doesn't fire                                                                                                | Daniel |
| **OB-C4**       | Code review all changed files, fix findings                                                                                                                                                                                                                                                                        | Daniel |
| **OB-C5**       | Merge `onboarding` → `main`                                                                                                                                                                                                                                                                                        | Daniel |
| **OB-D1**       | `mobile/app/(home)/preferences.tsx` — add logout + integration management UI                                                                                                                                                                                                                                       | Daniel |

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

| What                                         | Where                                                              |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Phase C pivot plan (full task list)          | `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md` |
| Onboarding spec (screen flow, API contracts) | `docs/onboarding-redesign-spec.md`                                 |
| Onboarding test file                         | `mobile/__tests__/onboarding.test.tsx`                             |
| Jest globals fix                             | `mobile/jest.globals.js`                                           |
| Branch                                       | `onboarding`                                                       |

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

| Gotcha                           | Rule                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Course matching                  | `syllabi.course_name` vs `canonical_events.course_id` — always use ILIKE                                                                                                                                                                                                                                                                             |
| Windows strftime                 | `%-I` fails on Windows; use `%I` + `.lstrip("0").lower()`                                                                                                                                                                                                                                                                                            |
| Lazy import patching             | Patch at the SOURCE module, never the importing module                                                                                                                                                                                                                                                                                               |
| Token encryption boundary        | Next.js callback NEVER writes tokens to Supabase directly                                                                                                                                                                                                                                                                                            |
| GCal/Gmail watch expiry          | Watch channels expire every 7 days — `renew-watch-channels` Beat task runs every 6h                                                                                                                                                                                                                                                                  |
| Google OAuth verification        | Gmail readonly is sensitive scope — app verification takes 1–6 weeks                                                                                                                                                                                                                                                                                 |
| PDF bytes                        | Never persisted — only base64 passes through Redis queue                                                                                                                                                                                                                                                                                             |
| Re-parse guard                   | `check_existing_syllabus()` skips Claude call if `parsed_json` already exists                                                                                                                                                                                                                                                                        |
| On-demand scheduling flow        | Redis pending state (5-min TTL) bridges two-message confirm flow                                                                                                                                                                                                                                                                                     |
| conftest autouse                 | `tests/ai/conftest.py` stubs Redis intercepts — new schedule tests must patch `sms.schedule.*` directly                                                                                                                                                                                                                                              |
| Expo winter runtime in Jest      | Pre-define `structuredClone` + `__ExpoImportMetaRegistry` as non-configurable in `jest.globals.js` — see fix above                                                                                                                                                                                                                                   |
| PhoneInput test input            | `fireEvent.changeText` with RAW DIGITS only (e.g. `'5551234567'`), not formatted string. Formatted string double-counts the `+1` country code.                                                                                                                                                                                                       |
| PinInput testID                  | `PinInput` accepts `testID` prop forwarded to root View with `onComplete` — `fireEvent(el, 'complete', code)` works                                                                                                                                                                                                                                  |
| Phone in profile route           | Since pivot: phone is NOT in request body — backend reads `user.phone` from Supabase JWT session                                                                                                                                                                                                                                                     |
| getSession() mock in tests       | The test mock returns a plain object (not Promise). Use `await supabase.auth.getSession()` pattern, NOT `.then()` — awaiting a non-promise returns the value directly                                                                                                                                                                                |
| Text.disabled for testing        | RN `Text` has a `disabled` prop explicitly for testing. Pass `disabled={condition}` to `<Text>` to make `getByText(...).parent?.props.disabled` work in test renderer. Neither `TouchableOpacity` nor `Pressable` exposes `disabled` on their rendered host element.                                                                                 |
| Supabase phone auth Twilio field | Supabase wants a **Messaging Service SID** (`MG...`), NOT the raw phone number and NOT the Verify Service SID (`VA...`). Create in Twilio Console → Messaging → Services.                                                                                                                                                                            |
| Mobile API auth                  | Mobile app sends `Authorization: Bearer <jwt>`. Next.js API routes must read JWT from `Authorization` header using `adminClient.auth.getUser(jwt)` — NOT from cookies (`createClient()` reads cookies, not Bearer tokens).                                                                                                                           |
| react-native-url-polyfill        | Must be imported as FIRST import in `mobile/app/_layout.tsx` — without it, Supabase network requests fail intermittently with `Network request failed` (status 0)                                                                                                                                                                                    |
| EXPO_PUBLIC_DEMO_MODE            | Set to `false` in `mobile/.env` for real auth testing. `true` injects fake session and skips all auth/onboarding.                                                                                                                                                                                                                                    |
| Onboarding routing               | `_layout.tsx` checks `onboarding_completed_at` from `public.users` to decide routing. Three cases: (1) no session → welcome, (2) session + done → home, (3) session + not done + not in onboarding → tcpa                                                                                                                                            |
| Back navigation in onboarding    | `router.replace()` clears stack — `router.back()` throws `GO_BACK not handled`. Use explicit `router.replace('/(onboarding)/[screen]')` for all back buttons.                                                                                                                                                                                        |
| Next.js dev server required      | Mobile app calls Next.js API routes at `EXPO_PUBLIC_API_URL`. Must run `npm run dev` in `aria-mvp` root during local testing. In production, set `EXPO_PUBLIC_API_URL` to Vercel URL.                                                                                                                                                                |
| /api/onboarding/complete Redis   | Route tries to connect to Redis at `redis://localhost:6379/0` to enqueue welcome SMS. Redis must be running (Docker) for this to succeed. If Redis not running, route will hang/error.                                                                                                                                                               |
| Simulator spinner hang on launch | If app shows spinner forever with Metro bundled and no requests hitting Next.js: stale/expired Supabase session in SecureStore is causing `getSession()` to attempt a token refresh that hangs. Fix: **Device → Erase All Content and Settings** in simulator, then reinstall via Metro. Do this at the start of every fresh simulator test session. |
