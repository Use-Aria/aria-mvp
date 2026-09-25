# Aria — Active Work State

> **This file is the traffic light for the repo.**
> Read it before touching any code. Update it when you start and when you finish.
> Both developers (Josh + Seb) run separate Claude Code sessions — this file prevents collisions.

---

## 🔒 Currently In Progress

_Nothing claimed. Onboarding fully merged to main (session 8). Next: OB-D1._

| Developer | Task | Branch | Claimed At |
| --------- | ---- | ------ | ---------- |
| —         | —    | —      | —          |

---

## 🎯 Up Next (Priority Order)

### Onboarding — COMPLETE ✅ (merged to `main` 2026-04-14)

- [x] **OB-C1** ✅ 2026-04-11
- ~~**OB-C2**~~ **CANCELLED** — Apple auth removed
- [x] **OB-P0** ✅ 2026-04-12 — Supabase phone auth + Twilio Messaging Service configured
- [x] **OB-P1** ✅ 2026-04-12 — All 10 code tasks committed
- [x] **OB-C3** ✅ 2026-04-12 — Full redesign: 51-university system, school-agnostic UI, Canvas guide, 23/23 tests
- [x] **OB-C4** ✅ 2026-04-14 — Code review complete, all critical + important findings fixed
- [x] **OB-C5** ✅ 2026-04-14 — Merged `onboarding` → `main`, pushed, branch deleted
- [ ] **OB-D1** — `mobile/app/(home)/preferences.tsx` — logout + integration management UI → **Daniel**

### Audit Follow-ups (logged 2026-09-24 — session 9 audit, see Handoff Notes)

**Must fix before launch**

- [ ] **AUD-01** 🔴 Gmail webhook fan-out — `src/app/api/gmail/webhook/route.ts` dispatches every notification to every Google user with another mailbox's `historyId` (corrupts their cursor), and has no Pub/Sub auth. Fix: store `google_email` on `integrations` at OAuth time (**migration — sync with Josh**), match on `emailAddress`; verify Pub/Sub OIDC JWT or a shared secret in the push URL
- [ ] **AUD-02** 🔴 Unsigned user IDs in OAuth/webhooks — `/api/auth/google?user_id=` (tools.tsx), Todoist `state=user.id` (preferences.tsx → `auth/todoist/callback`), and GCal `x-goog-channel-token` (`gcal/webhook`) all trust a raw UUID → anyone with a UUID can link their Google/Todoist account to a victim or trigger unlimited syncs. Fix: short-lived HMAC-signed state issued from the JWT; GCal: look up by `channel_id` and compare token
- [ ] **AUD-03** Todoist `access_token` stored plaintext (`auth/todoist/callback`) — route through the Fernet encrypt task like Google (use `enqueueCeleryTask`)
- [ ] **AUD-04** Gmail watch lapses after 7 days — Gmail + GCal share `integrations.watch_expires_at`; GCal renewal runs first and hides Gmail rows. Fix: `gmail_watch_expires_at` column (**migration — sync with Josh**)
- [ ] **AUD-05** End-to-end test with real Redis + Celery worker + Twilio SMS (fixes were verified against Celery's in-memory broker only)
- [ ] **AUD-06** Add env vars now required by `/api/health` to Vercel: `TWILIO_WEBHOOK_URL`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- [ ] **AUD-07** Confirm Supabase `auth.users.phone` format (digits-only expected) — `users.phone` now normalized to `+E.164`

**Product / design needed**

- [ ] **AUD-08** Priority engine rarely surfaces deadlines — `canvas_sync_user` never re-scores as due dates approach; digest rows marked `sent` before SMS even if suppressed; ≥80 tier unreachable (no `grade_weight`); deletes/"done" not mirrored to `canonical_events`
- [ ] **AUD-09** Home dashboard always empty — `/api/deadlines`, `/api/chat`, `/api/briefing/preview` don't exist (`mobile/lib/api.ts`, `hooks/useCards.ts`); Home never renders `error` → decide owner (Seb/Josh)
- [ ] **AUD-10** Hidden cards can't be restored — `useCards` stores in AsyncStorage, Preferences reads `preferences_json.hidden_cards` → unify on one store

**Mobile robustness**

- [ ] **AUD-11** Android Google connect — `WebBrowser.openBrowserAsync` resolves immediately so the 12s poll expires mid-consent; use `openAuthSessionAsync` or re-check on AppState `active` (`tools.tsx`)
- [ ] **AUD-12** Root `_layout.tsx` unmounts `<Stack>` (spinner) right after OTP verify while `verify-phone` navigates — render Stack always, spinner as overlay
- [ ] **AUD-13** `success.tsx` — on `completeOnboarding()` failure show Retry instead of proceeding
- [ ] **AUD-14** `ChatBar.handleVoiceResult` discards transcribed text; Canvas empty feed (422) shows "Couldn't reach" instead of 0 deadlines
- [ ] **AUD-15** Set up mobile ESLint (`npx expo lint` scaffolds config; `eslint` not in mobile deps)
- [ ] **AUD-16** Verify on device: iOS SMS OTP autofill (enabled in `PinInput`), Android Google OAuth

**Worker leftovers (low)**

- [ ] **AUD-17** `welcome_briefing` check-then-write race on concurrent calls; welcome SMS never retried if blocked by quiet hours
- [ ] **AUD-18** `gcal/writeback.schedule_study_block` uses UTC-day bounds (same bug fixed in `sms/schedule.py`)
- [ ] **AUD-19** Gmail at-least-once: a failed run can re-insert `gmail_flags` and re-alert on next notification
- [ ] **AUD-20** GCal/Gmail `Credentials` built without `expiry` → proactive refresh never runs; refreshed token never persisted
- [ ] **AUD-21** Update git remote → `https://github.com/Use-Aria/aria-mvp.git` (repo moved)

### v1.1 App Store Launch

- [ ] **PH10-02** — Fill Apple Developer credentials (`APPLE_ID`, `ASC_APP_ID`, team ID), run `eas build --platform ios --profile preview`, verify TestFlight install → **Josh**
- [ ] **PH11-01** — Plan + execute Phase 11: Deploy Next.js to Vercel, Celery workers to Railway, configure all production env vars → **Josh**
- [ ] **PH12-01** — Plan + execute Phase 12: Privacy Policy, Terms of Service, App Store Connect listing, screenshots, submit for review → **Josh + Seb**

---

## ✅ Completed

### v1.0 MVP — Shipped 2026-03-21

| Phase                                 | What shipped                                                                                                                  | Date       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Phase 1 — Infrastructure              | Next.js 15.2, Supabase schema+Auth+RLS, Celery+Redis+Docker                                                                   | 2026-03-18 |
| Phase 2 — Canvas Sync                 | iCal fetch, diff engine, Celery Beat 60-min sync                                                                              | 2026-03-18 |
| Phase 3 — Twilio SMS + TCPA           | send/receive SMS, TCPA guards, keyword dispatch, Twilio webhook                                                               | 2026-03-19 |
| Phase 4 — Claude AI + Daily Briefing  | Claude Sonnet briefings, conversational replies, exam countdowns                                                              | 2026-03-19 |
| Phase 5 — Priority Engine             | canonical_events table, priority scoring (0–100), send_priority_alert                                                         | 2026-03-19 |
| Phase 6 — Google OAuth + GCal + Gmail | Fernet-encrypted tokens, GCal sync + push, Gmail pipeline (Haiku classify), conflict detection, study blocks, SMS batch queue | 2026-03-20 |
| Phase 7 — Syllabus + Study Gap        | Claude Opus PDF parsing, never-re-parse guard, gap analysis Beat (T-5), briefing enrichment                                   | 2026-03-21 |
| Phase 8 — iOS App + Onboarding        | Expo React Native app, 4-zone dashboard, in-app chat, Google OAuth, onboarding flow                                           | 2026-03-20 |
| Phase 9 — Todoist Integration         | Todoist OAuth, task sync, SMS CRUD, briefing integration                                                                      | 2026-03-20 |
| Phase 10-01 — iOS Build Config        | `eas.json` + `app.json` fixes written (Apple credentials still needed)                                                        | 2026-03-21 |
| SCH-01 — On-Demand Scheduling         | `sms/schedule.py` created, `replies.py` updated, 34 new tests, 306 total passing                                              | 2026-03-22 |

---

## 📋 Handoff Notes

### 2026-09-24 — Daniel (codebase audit + fixes — session 9)

**Josh + Seb: please read — this touches both of your areas.** Three commits on `main`: `0c80edb` (api), `74e7f2e` (worker), `317bafc` (mobile).

**Most important:** no Celery task enqueued from Next.js had ever executed. The hand-built envelopes declared `body_encoding: 'utf-8'` on a base64 body, so kombu dropped them. All 6 routes now use `src/lib/celery/enqueue.ts` (verified against a real Celery worker). **Do not hand-build Celery messages again — use `enqueueCeleryTask()`.** Now that tasks actually run, previously dormant paths (welcome SMS, inbound SMS replies, Gmail/GCal webhooks) will fire for the first time — test end-to-end before launch.

**Behavior changes to know:**
- `/api/upload/syllabus` now requires Bearer JWT; `user_id` form field removed
- `users.phone` now stored as `+E.164`; SMS webhook matches both forms
- `send_sms_safe(is_proactive=False)` (replies/command confirmations) skips pause + quiet hours; opt-out still enforced
- Daily briefing beat now runs hourly (per-user 8am window + local-day dedupe)
- `welcome_briefing` only fires from `/api/onboarding/complete` and is idempotent
- Root `tsconfig.json`/`eslint.config.mjs` exclude `mobile/` + `celery_worker/` — `npm run build` was failing

**Open (not fixed — need decisions / migrations):**
- 🔴 Gmail webhook fans out every notification to every Google user with the wrong historyId, no Pub/Sub auth — must fix before launch (needs `google_email` column)
- 🔴 `/api/auth/google?user_id=`, Todoist `state=user_id`, GCal channel token all trust raw UUIDs — need signed state
- Todoist token stored plaintext; Gmail+GCal share `watch_expires_at` (Gmail watch lapses after 7d)
- `/api/deadlines`, `/api/chat` don't exist → home always empty (Seb)
- `mobile/` has no ESLint config

**Tests:** worker 327 passing, mobile 23 passing, `next build` passing.

### 2026-04-14 — Daniel (OB-C4 + OB-C5 COMPLETE — session 8)

**Done:** Onboarding fully shipped. Code review complete, all findings fixed, merged to `main`, pushed to GitHub. `onboarding` branch deleted.

**Key fixes applied (OB-C4):**
- `src/app/api/sync/canvas/route.ts` — `webcal://` normalised to `https://` before `new URL()` to prevent 400 crash
- `mobile/app/(onboarding)/profile.tsx` — back button reads `session.user.phone` on mount, passes it as explicit param to `router.replace({ pathname: '/(onboarding)/verify-phone', params: { phone: sessionPhone } })`
- `src/app/api/onboarding/profile/route.ts` — `graduation_year` lower bound corrected `2020` → `2024`
- `mobile/components/onboarding/CanvasUrlInput.tsx` — dead comment block + duplicate `onValidate()` + unused `CANVAS_URL_REGEX` removed
- `mobile/app/_layout.tsx` — (1) incomplete onboarding resume now routes to `profile` not `tcpa`; (2) spinner suppressed when `segments[0] === '(home)'` to prevent Stack unmount/remount flash on success→home transition

**Other changes this session:**
- `mobile/app/(onboarding)/tcpa.tsx` — TCPA Option 2: consent optional, warning shown when OFF, Continue always enabled, heading broadened to cover briefings + alerts
- `LOCALDEV.md` — reset procedure simplified to single 3-step flow (erase simulator → delete Supabase rows → revoke Google OAuth)
- `celery_worker/*.py` + `docker-compose.yml` — `SUPABASE_URL` fallback to `NEXT_PUBLIC_SUPABASE_URL`; docker-compose uses `env_file: .env.local`

**Test status:** 23/23 passing (5 new TCPA tests added). Lint clean. Working tree clean on `main`.

**Known deferred issues (non-blocking):**
- `/api/auth/google` accepts `user_id` query param with no auth check — WebBrowser limitation, track for OB-D1
- Success screen silently proceeds on API failure — low priority hardening

**Next up:** OB-D1 — `mobile/app/(home)/preferences.tsx` (logout + Google reconnect + Canvas URL edit). Start a new branch off `main`.

---

### 2026-04-12 — Daniel (OB-C3 COMPLETE + Full Redesign — session 7)

**Done:** Full onboarding redesign shipped. 51-university Canvas domain system with school-agnostic UI. UniversityPicker component, syllabus removed, coming-soon integrations added.
**Files created:**

- `mobile/lib/universities.ts` — 51 Canvas universities with domain mappings, `canvasDomainForUniversity()` helper, export `UNIVERSITIES` array
- `mobile/components/onboarding/UniversityPicker.tsx` — searchable modal picker replacing TextInput, consistent with Canvas domain lookup

**Files changed:**

- `mobile/app/(onboarding)/welcome.tsx` — headline "Your academic life, under control" (was "Your Yale life, under control"), removed "90 seconds" text, button "Get started" (was "Get started — 90 seconds"), reordered integrations (Gmail+Google Calendar #1, Canvas #2)
- `mobile/app/(onboarding)/profile.tsx` — import UniversityPicker, replaced university TextInput with picker component
- `mobile/app/(onboarding)/tools.tsx` — domain resolution priority logic (extract from URL first, then university lookup, then null), updated Canvas guide steps to match actual Canvas navigation, removed syllabus upload entirely (DocumentPicker, state, handler deleted), added 3 coming-soon cards (Todoist, iOS Reminders, Google Classroom) with 50% opacity
- `mobile/__tests__/onboarding.test.tsx` — UniversityPicker mock, updated profile tests for picker, added 4 new tools tests for domain resolution, 18/18 passing
- `docs/onboarding-redesign-spec.md` — updated Tools Screen section
- `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md` — added Task 7 amendment block with all post-plan changes
- `docs/superpowers/plans/2026-04-12-canvas-ical-guide.md` — updated self-review with post-plan amendments (domain resolution, guide steps, university picker, syllabus removal)

**Key technical decisions:**

1. **Domain resolution priority:** (1) extract origin from typed Canvas iCal URL if present, (2) lookup via `canvasDomainForUniversity(university)` if university in profile, (3) null → button disabled with hint. Prevents hardcoding to Yale.
2. **University picker model:** Constrained to known list prevents free-text entry errors that would break Canvas domain lookup.
3. **Canvas URL change:** From `/profile/settings#feed_holder` (Settings page) to `/calendar` (direct calendar page) — matches actual Canvas iCal location UI.
4. **Syllabus removal:** Not ready for onboarding MVP. Removed entirely from tools screen; can re-add in preferences/settings post-onboarding in future (OB-D1).
5. **Coming-soon cards:** Todoist, iOS Reminders, Google Classroom are frontend-only scaffolding. No backend yet. 50% opacity + badge signal they're planned.

**Test coverage:** All 18 tests passing. New tests cover: (1) picker renders correctly, (2) domain resolves from URL, (3) domain resolves from university, (4) button disabled + hint when domain null, (5) guide visible when Canvas not connected.

**Test command:** `cd mobile && npx jest __tests__/onboarding.test.tsx --verbose`

**Linting:** `npm run lint` passes clean.

**Blocked on:** Nothing. Ready for code review (OB-C4) and merge (OB-C5).

**Next up:** OB-C4 (code review) → OB-C5 (merge to main) → OB-D1 (preferences with logout + integration management).

### 2026-04-12 — Daniel (OB-C3 complete + Canvas guide — session 6)

**Done:** OB-C3 confirmed complete. Canvas iCal guide shipped (Option A+B): 3-step inline guide + "Open Canvas" button in tools.tsx Canvas card. Visible only when `canvasStatus !== 'valid'`. 4 new tests, 15/15 passing.
**Files changed:** `mobile/app/(onboarding)/tools.tsx` (guide + button + useEffect cleanup), `mobile/jest.setup.js` (asyncUtilTimeout), `mobile/__tests__/onboarding.test.tsx` (4 new tests).
**Plan:** `docs/superpowers/plans/2026-04-12-canvas-ical-guide.md`
**Next up:** OB-C4 (code review all onboarding branch changes) → OB-C5 (merge to main).

### 2026-04-12 — Daniel (OB-C3 nearly complete — session 5)

**Done:** Full onboarding flow confirmed working end-to-end (phone → OTP → profile → TCPA → tools → Google connect → success → dashboard).
**Files changed:**

- `mobile/app/(onboarding)/profile.tsx` — hydrate name/university/grad_year from DB on mount
- `mobile/app/(onboarding)/tcpa.tsx` — hydrate has_alert_consent from DB on mount
- `mobile/app/(onboarding)/tools.tsx` — hydrate Canvas URL from integrations on mount
- `mobile/app/_layout.tsx` — fixed routing race condition (segments[0] dependency + null reset)
- `src/app/api/auth/google/callback/route.ts` — NODE_ENV branch: dev writes directly to Supabase, production uses Redis+Celery
- `supabase/migrations/010_integrations_unique_constraint.sql` — new, pushed
- `PRODUCTION.md` — new file (all production blockers)
- `LOCALDEV.md` — new file (local dev guide, 3-terminal setup, reset SQL)
  **Gotchas discovered:**
- Google OAuth: if Redis is running but Celery isn't, tokens get enqueued but never written → poll fails. Fixed by NODE_ENV branch.
- `integrations` table had no unique constraint on (user_id, platform) — upsert silently failed. Fixed by migration 010 + select-then-insert/update.
- `_layout.tsx` routing race: stale `onboardingDone=false` redirected user back to tcpa after tapping "Enter Aria". Fixed by re-fetching on segment change.
- Onboarding reset requires BOTH simulator erase AND SQL reset — phone number maps back to same Supabase user.
  **Still in progress:** OB-C3 re-test after reset (Canvas iCal validation failing — non-blocker).
  **Next up:** OB-C3 final confirm → OB-C4 (code review) → OB-C5 (merge to main).

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
