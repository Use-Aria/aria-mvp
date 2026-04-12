# Aria — Active Work State

> **This file is the traffic light for the repo.**
> Read it before touching any code. Update it when you start and when you finish.
> Both developers (Josh + Seb) run separate Claude Code sessions — this file prevents collisions.

---

## 🔒 Currently In Progress

*Nothing claimed. Run `/project:begin` to start a session.*

| Developer | Task | Branch | Claimed At |
|-----------|------|--------|------------|
| — | — | — | — |

---

## 🎯 Up Next (Priority Order)

### Onboarding Redesign (branch: `onboarding`) — PIVOTED 2026-04-11

**Auth pivot:** Apple/Google OAuth replaced with Supabase phone OTP. Plan: `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md`

- [x] **OB-C1** — Fill `mobile/.env`: `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` + `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` ✅ Done 2026-04-11
- ~~**OB-C2**~~ — ~~Apple Sign-In Supabase config~~ **CANCELLED** — Apple auth removed from flow
- [x] **OB-P0** ✅ DONE 2026-04-12 — Supabase phone auth enabled, Twilio Messaging Service `MGbf33d2d3327638ca21a7f05be5e138ba` configured, test phone + OTP `123456` added. Toll-free verification submitted (pending).
- [x] **OB-P1** (ALL 10 TASKS DONE) — All code tasks committed to `onboarding` branch. Commit `7d3d8a5`. → **Daniel**
- [ ] **OB-C3** ⚠️ IN PROGRESS — Reached tools screen. Remaining: Google connect → success → welcome SMS → home. See PROGRESS.md for exact next steps and known bugs. → **Daniel**
- [ ] **OB-C4** — Code review backend + mobile screens, fix findings → **Daniel**
- [ ] **OB-C5** — Merge `onboarding` → `main` → **Daniel**
- [ ] **OB-D1** — `mobile/app/(home)/preferences.tsx` integration management UI → **Daniel** (after merge)

### v1.1 App Store Launch

- [ ] **PH10-02** — Fill Apple Developer credentials (`APPLE_ID`, `ASC_APP_ID`, team ID), run `eas build --platform ios --profile preview`, verify TestFlight install → **Josh**
- [ ] **PH11-01** — Plan + execute Phase 11: Deploy Next.js to Vercel, Celery workers to Railway, configure all production env vars → **Josh**
- [ ] **PH12-01** — Plan + execute Phase 12: Privacy Policy, Terms of Service, App Store Connect listing, screenshots, submit for review → **Josh + Seb**

---

## ✅ Completed

### v1.0 MVP — Shipped 2026-03-21

| Phase | What shipped | Date |
|-------|-------------|------|
| Phase 1 — Infrastructure | Next.js 15.2, Supabase schema+Auth+RLS, Celery+Redis+Docker | 2026-03-18 |
| Phase 2 — Canvas Sync | iCal fetch, diff engine, Celery Beat 60-min sync | 2026-03-18 |
| Phase 3 — Twilio SMS + TCPA | send/receive SMS, TCPA guards, keyword dispatch, Twilio webhook | 2026-03-19 |
| Phase 4 — Claude AI + Daily Briefing | Claude Sonnet briefings, conversational replies, exam countdowns | 2026-03-19 |
| Phase 5 — Priority Engine | canonical_events table, priority scoring (0–100), send_priority_alert | 2026-03-19 |
| Phase 6 — Google OAuth + GCal + Gmail | Fernet-encrypted tokens, GCal sync + push, Gmail pipeline (Haiku classify), conflict detection, study blocks, SMS batch queue | 2026-03-20 |
| Phase 7 — Syllabus + Study Gap | Claude Opus PDF parsing, never-re-parse guard, gap analysis Beat (T-5), briefing enrichment | 2026-03-21 |
| Phase 8 — iOS App + Onboarding | Expo React Native app, 4-zone dashboard, in-app chat, Google OAuth, onboarding flow | 2026-03-20 |
| Phase 9 — Todoist Integration | Todoist OAuth, task sync, SMS CRUD, briefing integration | 2026-03-20 |
| Phase 10-01 — iOS Build Config | `eas.json` + `app.json` fixes written (Apple credentials still needed) | 2026-03-21 |
| SCH-01 — On-Demand Scheduling | `sms/schedule.py` created, `replies.py` updated, 34 new tests, 306 total passing | 2026-03-22 |

---

## 📋 Handoff Notes

### 2026-04-12 — Daniel (OB-C3 in progress — session 4)
**Done:** Fixed `POST /api/onboarding/complete` — was using cookie-based auth (`createClient()`), now reads JWT from `Authorization: Bearer` header using `adminClient.auth.getUser(jwt)`. Removed unused `createClient` import. Diagnosed simulator spinner hang: stale SecureStore session causes `getSession()` to hang on token refresh. Fix: erase simulator before each test session.
**Files changed:** `src/app/api/onboarding/complete/route.ts` (Bearer token auth fix).
**Blocked:** Mac restart needed — simulator test not yet resumed.
**CRITICAL before resuming:** Run `Device → Erase All Content and Settings` in simulator first (clears stale session). Then `npm run dev` + `npx expo start --clear`.
**Next up:** OB-C3 cont. — full flow from welcome screen through tools → success → welcome SMS → home. Then OB-C4 (code review) → OB-C5 (merge).

### 2026-04-12 — Daniel (OB-C3 in progress — session 3)
**Done:** OB-P0 complete. Fixed 10 bugs during simulator integration test. Reached tools screen.
**Files changed:** `mobile/.env` (DEMO_MODE=false), `mobile/app/_layout.tsx` (url polyfill, onboarding routing), `mobile/lib/supabase.ts` (global fetch), `mobile/components/onboarding/PhoneInput.tsx` (digit corruption fix, maxLength), `mobile/app/(onboarding)/auth.tsx` (validation fix, real error logging), `mobile/app/(onboarding)/verify-phone.tsx` (back button), `mobile/app/(onboarding)/profile.tsx` (back button, TouchableOpacity import), `mobile/app/(onboarding)/tcpa.tsx` (back button), `mobile/app/(onboarding)/tools.tsx` (back button), `src/app/api/onboarding/profile/route.ts` (Bearer token auth fix), `supabase/migrations/009_fix_email_not_null.sql` (new, pushed).
**Gotchas discovered:** See new entries at bottom of PROGRESS.md Architecture Gotchas table (5 new entries: mobile API auth, url-polyfill, DEMO_MODE, onboarding routing, back navigation, Next.js dev server, Redis).
**CRITICAL — fix before testing success screen:** `src/app/api/onboarding/complete/route.ts` uses cookie auth → will 401. Fix same as profile route (Bearer token). Also Redis must be running for welcome SMS. See PROGRESS.md "IMPORTANT" section.
**Next up:** OB-C3 cont. — tools screen → Google connect → success → welcome SMS → home. Then OB-C4 (code review) → OB-C5 (merge).

### 2026-04-11 — Daniel (Phase C COMPLETE — session 2)
**Done:** OB-P1 Tasks 6–10 executed and committed to `onboarding` branch (`7d3d8a5`). Phase C code is fully complete.
**Files changed:** `mobile/app/(onboarding)/profile.tsx` (phone removed, Pressable, Text.disabled, navigate to tcpa, ProgressBar step 4). `mobile/app/(onboarding)/tools.tsx` (replaced expo-auth-session nonce/signInWithIdToken with WebBrowser.openBrowserAsync + integrations table poll 8×1.5s). `mobile/app/(onboarding)/_layout.tsx` (verify-phone before profile). `mobile/package.json` + `package-lock.json` (expo-apple-authentication removed). Lint clean, 11/11 tests pass.
**Gotchas discovered:**
1. RN `Text` has a `disabled` prop for testing — `getByText(...).parent?.props.disabled` only works if you pass `disabled={condition}` to the `<Text>` itself. Neither TouchableOpacity nor Pressable exposes `disabled` on their host element.
2. `supabase.auth.getSession()` test mock returns a plain object (not Promise) — use `await`, never `.then()`.
3. Supabase phone auth needs a **Messaging Service SID** (`MG...`), NOT the raw phone number and NOT the Verify Service SID (`VA...`). Create in Twilio Console → Messaging → Services. Plan file Task 0 has been corrected.
**Blocked on:** OB-P0 — Supabase phone auth provider + Twilio Messaging Service must be enabled manually before simulator test. See PROGRESS.md for exact steps.
**Next up:** OB-P0 (manual, ~5 min) → OB-C3 (simulator integration test) → OB-C4 (code review) → OB-C5 (merge to main).

### 2026-04-11 — Daniel (Phase C partial)
**Files changed:** Deleted `src/app/api/auth/phone/send+verify/route.ts`. Updated `src/app/api/onboarding/profile/route.ts` (phone from session). Updated `mobile/lib/api.ts` (removed OTP methods, exported API_BASE). Rewrote `mobile/app/(onboarding)/auth.tsx` (phone + signInWithOtp). Updated `mobile/app/(onboarding)/verify-phone.tsx` (verifyOtp, navigate to profile). Updated `mobile/components/onboarding/PinInput.tsx` (testID + onComplete forwarding). Created `mobile/jest.globals.js` + `mobile/__mocks__/empty.js` (Expo winter runtime Jest fix).
**Gotchas:** PhoneInput test input must use RAW DIGITS (e.g. `'5551234567'`), not formatted string. TouchableOpacity `disabled` becomes `accessibilityState.disabled` in test renderer — use `getByTestId('btn').props.accessibilityState?.disabled`. PinInput fires `fireEvent(el, 'complete', code)` via `testID="pin-input"` + forwarded `onComplete` prop.
**Next up:** Tasks 6–10 of `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md`. Tests for Task 6 (profile screen) are already written in `__tests__/onboarding.test.tsx` and failing — run test first, then implement. See PROGRESS.md for full task list.

### 2026-04-10 — Daniel (session 2)
**Done:** Phases A + B of onboarding redesign fully implemented and committed to `onboarding` branch.
**Phase A (backend):** DB migrations pushed to Supabase. All 5 routes created: `POST /api/onboarding/profile`, `POST /api/auth/phone/send`, `POST /api/auth/phone/verify`, `POST /api/sync/canvas` (real iCal validation), `POST /api/onboarding/complete`.
**Phase B (mobile):** 5 new screens (auth, profile, verify-phone, tools, success). Old screens deleted. `_layout.tsx`, `tcpa.tsx`, `welcome.tsx`, `api.ts` all updated. `expo-apple-authentication` installed.
**Gotchas:** `TWILIO_VERIFY_SERVICE_SID` is in `.env.local` (set this session). `mobile/.env` has `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` EMPTY — must fill before simulator test. Apple Sign-In needs to be enabled in Supabase Auth dashboard.
**Next up:** OB-C1 through OB-C5 — fill env vars → integration test → code review → merge

### 2026-04-10 — Daniel (session 1)
**Done:** Wrote `supabase/migrations/008_onboarding_completion.sql` (adds `phone_verified`, `onboarding_completed_at` to `users`). Removed ultraplan dependency from PROGRESS.md.
**Blocked:** Could not run `npx supabase db push` — Supabase CLI needs `SUPABASE_ACCESS_TOKEN` in non-TTY environments. Get token from supabase.com/dashboard/account/tokens, then: `export SUPABASE_ACCESS_TOKEN=<token> && npx supabase link --project-ref jjnedeyfpgogaizsucxp && npx supabase db push`
**Next up:** Push migration → Backend APIs (`src/app/api/onboarding/profile/route.ts`, `src/app/api/auth/phone/send/route.ts`, `src/app/api/auth/phone/verify/route.ts`, `src/app/api/onboarding/complete/route.ts`)

### 2026-03-22 — Josh
**Done:** SCH-01 — On-demand scheduling shipped
**Files changed:** `celery_worker/sms/schedule.py` (new), `celery_worker/ai/replies.py`, `celery_worker/requirements.txt`, `celery_worker/tests/sms/test_schedule.py` (new), `celery_worker/tests/ai/test_replies.py`, `celery_worker/tests/ai/conftest.py` (new), `.planning/ROADMAP.md`
**Gotchas:** `tests/ai/conftest.py` has an autouse fixture that stubs Redis intercepts — any new `handle_reply` tests for schedule paths must patch `sms.schedule.*` directly. `%-I` strftime fails on Windows; `_format_time()` uses `%I + lstrip("0")` instead.
**Next up:** PH10-02 — Apple Developer credentials (APPLE_ID, ASC_APP_ID, team ID) → `eas build --platform ios --profile preview` → TestFlight

### 2026-03-22 — Josh (earlier)
**Done:** Developer workflow overhaul
**Files changed:** `.claude/commands/begin.md`, `start.md`, `save.md`, `done.md`, `CLAUDE.md`, `PROGRESS.md`
**Gotchas:** All skills now push/pull directly from `main` — no feature branches for now. `/project:begin` replaces `/project:start` for new sessions. Notion MVP Progress Log updated after every `/done`.
**Next up:** SCH-01 — apply 8 plan fixes then execute on-demand scheduling plan

### 2026-03-21 — Josh
**Done:** v1.0 MVP shipped (all 9 phases). Phase 10 build config files written.
**On-demand scheduling designed:** spec + plan in `docs/superpowers/`. Plan has 8 known minor fixes — see `PROGRESS.md` for the full list. Do NOT execute until fixes are applied.
**Gotchas:**
- Apply all 8 plan fixes before `/gsd:execute-phase` or subagent execution
- `mobile/` directory is the React Native app (not `src/`)
- Apple credentials (APPLE_ID, ASC_APP_ID, team ID) must be in `.env.local` before `eas build`
- Google OAuth app verification for Gmail scope may take 1–6 weeks — start if not already done
**Next up:** SCH-01 (scheduling) → PH10-02 (Apple creds + build) → PH11-01 (deploy) → PH12-01 (App Store)

---

## ⚠️ Collision Rules

1. **Never start a task that's already claimed** in the "Currently In Progress" table
2. **Always `git pull origin main` before claiming** — another dev may have finished and pushed
3. **One task at a time per developer** — finish and push before claiming a second
4. **Seb: do not touch `src/lib/`, `src/app/api/`, `celery_worker/`, or `supabase/`** — Josh owns these
5. **Josh: do not touch `mobile/src/app/(pages)/` or `mobile/src/components/`** — Seb owns these
6. **Both: never modify `src/types/index.ts` without telling the other person first**
