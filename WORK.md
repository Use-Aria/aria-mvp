# Aria — Active Work State

> **This file is the traffic light for the repo.**
> Read it before touching any code. Update it when you start and when you finish (say "wrap up"; see `CLAUDE.md` → Session Protocol).
> Keep it short: live state + the 3 latest handoff notes. History lives in `docs/history/`.
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
- [x] **AUD-21** ✅ 2026-10-09 — Git remote updated → `https://github.com/Use-Aria/aria-mvp.git` (Daniel's machine; Josh + Seb run the command in the handoff note)

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

### 2026-10-09 — Daniel (vanilla Claude Code + new memory workflow)

**What changed:** The repo no longer ships Claude Code tooling (no GSD, no superpowers, no `/project:*` commands). The workflow is now plain Claude Code, `CLAUDE.md`, and this file.
- **Session protocol is in `CLAUDE.md`.** Claude orients itself at session start. Say **"wrap up"** (or "save", "done for today") and it runs checks, updates this file, writes a handoff note, rotates old notes, then **commits and pushes automatically**. It stops and asks if checks fail, if there are changes it didn't make, or if migrations or `src/types/index.ts` changed.
- **`PROGRESS.md` is retired.** Live state lives here. Permanent gotchas moved to `CLAUDE.md` → *Implementation Gotchas*. The old session log is at `docs/history/progress-log.md`.
- **This file keeps only the 3 latest handoff notes.** Older ones are in `docs/history/handoffs.md`.
- **Moved (history kept):** `.planning/` → `docs/history/`; `docs/superpowers/{plans,specs}` → `docs/plans/`, `docs/specs/`.
- **Removed:** GSD hooks, agents, and commands; the `gsd` and `superpowers` plugin entries; the `filesystem` and broken `supabase` MCP servers (GitHub MCP kept). The `.claude/settings.json` deny rules are kept.

**Also fixed:** the docs said to run `npm test`, but there's no root test script. `CLAUDE.md` and `ONBOARDING.md` now list the real commands: `cd celery_worker && pytest` and `cd mobile && npx jest`.

**Verified:** `npm run lint` and `npm run build` pass. This was a docs and tooling change only, with no app code touched, so I didn't re-run the worker or mobile tests.

**Repo moved (AUD-21):** the repo now lives at `Use-Aria/aria-mvp`. Josh and Seb: run `git remote set-url origin https://github.com/Use-Aria/aria-mvp.git` once.

**After you pull:** if you installed GSD locally, delete `.claude/get-shit-done/`, `.claude/agents/`, `.claude/commands/gsd/`, and `.claude/gsd-file-manifest.json`. If Claude Code warns about the filesystem or supabase MCP servers, remove them from `enabledMcpjsonServers` in your `.claude/settings.local.json`.

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

_Older notes: `docs/history/handoffs.md`._

---

## ⚠️ Collision Rules

1. **Never start a task that's already claimed** in the "Currently In Progress" table
2. **Always `git pull origin main` before claiming** — another dev may have finished and pushed
3. **One task at a time per developer** — finish and push before claiming a second
4. **Seb: do not touch `src/lib/`, `src/app/api/`, `celery_worker/`, or `supabase/`** — Josh owns these
5. **Josh: do not touch `mobile/src/app/(pages)/` or `mobile/src/components/`** — Seb owns these
6. **Both: never modify `src/types/index.ts` without telling the other person first**
