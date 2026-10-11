# Aria — Feature Checklist

> **⚠️ V2 pivot (2026-10-09):** Aria is being rebuilt as **V2** (iMessage-first, no app). This checklist reflects the shipped **V1**; V2 status lives in `docs/plans/2026-10-09-aria-v2-free-testing-plan.md` and `WORK.md` until V2 features start landing.

## Aria V2 — free private test (🔄 In Progress)

> Build status per `docs/plans/2026-10-10-v2-master-plan.md`. Waves 0–5 built 2026-10-10. Next: fix the Wave 5 code-review findings, then the second gate, then credentials + deploy.

| Feature | Status | Notes |
|---------|--------|-------|
| V2 schema (001 baseline, 002 cron/net, 003 build) | ✅ Done | Live on `onrurwsourjlgfmitezh`; RLS deny-all, service-role RPCs |
| Next 16.4 + Jest + Playwright tooling | ✅ Done | V1 TS code removed |
| Landing + signup, magic links, sessions | ✅ Done | Fragment token, form-POST redeem, hashed sessions |
| Web shell (PWA manifest, icons, OG cards, CSP, /privacy, /terms) | ✅ Done | `(app)/` route group |
| Jobs runtime (pg_cron tick → `/api/jobs/dispatch`) | ✅ Done | Tick is a no-op until Vault secrets are set post-deploy |
| Channels (Sendblue + dev providers, guards, STOP/START) | ✅ Done | Sendblue untested until sandbox creds |
| Delivery + inbound ingest + webhooks | ✅ Done | Debounce in jobs row; dev channel works locally |
| LLM layer (routes, caching, cost logging, structured output) | ✅ Done | Cache hit verified live |
| Memory + context + persona | ✅ Done | Static prompt ~22.6K tokens, byte-stable |
| Timeline module | ✅ Done | Urgency at read time |
| Canvas parse/SSRF fetch (pure) | ✅ Done | |
| Reminders + briefing scheduling core | ✅ Done | |
| Google OAuth core + tokens; Gmail sync/push | ✅ Done | Untested until Google creds |
| Python syllabus parser service | ✅ Done | Cloud Run deploy pending |
| Conversation turn pipeline + dev-chat REPL | ✅ Done | Welcome, debounce, reaction-only turns, 8s watchdog, daily turn cap |
| Agent loop + core tools + pending actions | ✅ Done | Real Haiku turns verified live; escalation capped at 10%; confirm is at-most-once |
| Canvas sync/connect + tools | ✅ Done | Fixture feeds only; live Yale feed check pending |
| Syllabus intake (chat PDF + /setup upload) | ✅ Done | Verified with the fake-LLM parser; browser upload untested |
| Google OAuth routes + calendar read/watch | ✅ Done | Fake Google only until creds |
| Daily briefing + Canvas change alerts + nightly reconcile | ✅ Done | Real Haiku briefing verified live; `digest` link; urgent alerts respect quiet hours (D8) |
| Free-slot finding + Aria calendar blocks (find/create/move/delete) | ✅ Done | Fake Google only until creds; writes only to the "Aria" calendar |
| Gmail classify/alerts/triage digest + email search/read/draft | ✅ Done | Send only via a confirmed pending action (web or chat, never same run); fake Gmail until creds |
| Web: /setup (schedule, tone, Canvas, Google), /week, /email/[id], /settings, export, delete | ✅ Done | Clicked through by Playwright (Wave 5.4); a11y fixes (tap targets, contrast, skip link) |
| Evals v0 (`npm run evals`: injection, behaviour, core) | ✅ Done | 35/35 on the local stack, ~$0.10/run; `evals/BASELINE.md` |
| V1 removal (mobile/, celery_worker/, Procfile, stubs) + V2 docs | ✅ Done | CLAUDE.md, README, DEPLOYMENT, PRODUCTION, LOCALDEV rewritten |
| End-to-end dev-channel conversation (`npm run e2e:chat`) | ✅ Done | 12 scripted steps, real Haiku; fixes: run cost includes tool LLM calls, one interim per run, action lock after untrusted reads, chat effort `medium` |
| Agent reliability: claim check + preference supersede | ✅ Done | Re-prompts once when Aria claims an action it didn't take; a changed rule replaces the old one |
| Web Playwright e2e + screenshots + a11y checklist | ✅ Done | 4 device projects, 228 screenshots, `tests/e2e/A11Y.md`; runs with 1 worker under `next dev` |
| Code review (Wave 5.5) | 🔄 In Progress | 13 findings to fix. 4 are send safety (HTTP retry on send, replay after side effects, confirm ordering, confirm timeout); see the orchestrator notes |

---

> Updated after every `git push`. This is the live build status.
> Legend: ✅ Done | 🔄 In Progress | ⬜ Not Started | ⏳ Deferred
>
> **Note:** Feature IDs map to the original build phases (1–12) — see `docs/history/phases/` and `docs/history/ROADMAP.md`.

---

## v1.0 MVP — ✅ SHIPPED 2026-03-21

### Phase 1 — Infrastructure Foundation ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Next.js 15.2 scaffold (App Router, TypeScript strict, Tailwind) | ✅ Done | Turbopack enabled |
| Supabase schema + RLS + Auth + `handle_new_user` trigger | ✅ Done | Migration 001 |
| Celery + Redis + Docker Compose worker | ✅ Done | |
| Shared types: Task, CalendarEvent, Message | ✅ Done | `src/types/index.ts` |
| `.env.local.template` | ✅ Done | |
| ESLint config | ✅ Done | |
| Auth middleware (token refresh every request) | ✅ Done | `src/middleware.ts` |
| `/api/health` endpoint | ✅ Done | |

### Phase 2 — Canvas iCal Sync ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Fetch + parse Canvas iCal feed | ✅ Done | `celery_worker/canvas/` |
| Diff engine (added/changed/removed deadlines) | ✅ Done | |
| Store deadlines in Supabase with `synced_at` | ✅ Done | Migration 002 |
| Background sync job (every 60 min, Celery Beat) | ✅ Done | |
| Rate limit handling + exponential backoff | ✅ Done | |

### Phase 3 — Twilio SMS + TCPA Compliance ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Outbound SMS with 4 TCPA guards | ✅ Done | `celery_worker/sms/send.py` |
| STOP / START / PAUSE / HELP keyword dispatch | ✅ Done | |
| Inbound SMS webhook (Twilio signature validation) | ✅ Done | `src/app/api/sms/webhook/` |
| Redis enqueue for inbound processing | ✅ Done | |
| Migration 003 (7 TCPA columns on users) | ✅ Done | |

### Phase 4 — Claude AI + Daily Briefing ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Daily briefing generator (Claude Sonnet) | ✅ Done | `celery_worker/ai/briefing.py` |
| Briefing Beat job (daily 8am send) | ✅ Done | |
| Monday 7-day extended briefing | ✅ Done | |
| Conversational SMS reply handler (Claude Sonnet) | ✅ Done | `celery_worker/ai/replies.py` |
| Exam countdown touch points in briefing | ✅ Done | |
| Task management via SMS (snooze, complete, list) | ✅ Done | |
| On-demand scheduling via SMS | ✅ Done | `celery_worker/sms/schedule.py`; 29 tests; wired into replies.py |

### Phase 5 — Priority Engine + Canonical Timeline DB ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Priority scoring engine (0–100) | ✅ Done | `celery_worker/priority/engine.py` |
| Event router (immediate/digest/silent) | ✅ Done | |
| `canonical_events` table + RLS | ✅ Done | Migration 005 |
| `ingest_canonical_event()` entry point | ✅ Done | |
| `send_sms_alert()` (bypasses quiet hours + caps) | ✅ Done | |
| Canvas sync wired to canonical events | ✅ Done | |

### Phase 6 — Google OAuth + GCal + Gmail + Alerts ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Google OAuth 2.0 (Calendar + Gmail scopes) | ✅ Done | HMAC CSRF, httpOnly cookie |
| Fernet-encrypted token storage in Supabase | ✅ Done | `celery_worker/google_auth/` |
| GCal sync (7-day window, push notifications) | ✅ Done | `celery_worker/gcal/` |
| Watch channel auto-renewal (Beat every 6h) | ✅ Done | |
| Gmail pipeline (Pub/Sub, Haiku classify, rapidfuzz) | ✅ Done | `celery_worker/gmail/` |
| Conflict detection (Canvas vs GCal) | ✅ Done | |
| Study block write-back to GCal | ✅ Done | |
| SMS batch queue (Redis SETNX, 10-min window, 3-cap) | ✅ Done | `celery_worker/sms/batch.py` |
| Monday briefing enrichment (conflicts + study windows) | ✅ Done | |
| Migration 006 (gmail_flags, conflict_alerts, watch columns) | ✅ Done | |

### Phase 7 — Syllabus Parsing + Study Gap Detection ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Syllabus PDF upload endpoint | ✅ Done | `src/app/api/upload/syllabus/` |
| Claude Opus PDF parser (document block API) | ✅ Done | `celery_worker/ai/syllabus.py` |
| Never-re-parse guard | ✅ Done | |
| `(user_id, course_name)` UNIQUE constraint | ✅ Done | Migration 007 |
| Study gap analysis Beat task (T-5 before exam) | ✅ Done | |
| `get_syllabus_context()` for Monday briefing enrichment | ✅ Done | |

### Phase 8 — iOS App + Onboarding ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Expo React Native app scaffold | ✅ Done | `mobile/` |
| 4-zone home dashboard (deadlines, messages, calendar, chat) | ✅ Done | |
| Full onboarding flow (phone, Canvas URL, Google OAuth) | ✅ Done | |
| In-app chat (ChatSheet + ChatBar) | ✅ Done | |
| Voice input (tap-to-record) | ✅ Done | |
| Theme system (light/dark) | ✅ Done | |

### Phase 9 — Todoist Integration ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Todoist OAuth flow | ✅ Done | `src/app/api/auth/todoist/` |
| Todoist task sync (Celery, every 2h) | ✅ Done | |
| Todoist tasks in daily briefing | ✅ Done | |
| SMS task CRUD (add, complete, list) | ✅ Done | |

---

## v1.1 App Store Launch — 🚧 In Progress

### Phase 10 — iOS Build Configuration 🔄

| Feature | Status | Notes |
|---------|--------|-------|
| `eas.json` profiles (development/preview/production) | ✅ Done | |
| `app.json` privacy permission strings | ✅ Done | |
| App icon + splash screen assets | ✅ Done | |
| Apple Developer credentials configured | ⬜ Not Started | APPLE_ID, ASC_APP_ID, team ID needed |
| `eas build --platform ios --profile preview` succeeds | ⬜ Not Started | |
| App on TestFlight | ⬜ Not Started | |

### Phase 11 — Backend Deployment ⏳

| Feature | Status | Notes |
|---------|--------|-------|
| Next.js deployed to Vercel | ⬜ Not Started | |
| Celery workers deployed to Railway | ⬜ Not Started | |
| Redis plugin on Railway | ⬜ Not Started | |
| All production env vars configured | ⬜ Not Started | |
| `/api/health` returns 200 on production URL | ⬜ Not Started | |
| E2E smoke test (Canvas URL → welcome SMS) | ⬜ Not Started | |

### Phase 12 — Legal, Listing & Submission ⏳

| Feature | Status | Notes |
|---------|--------|-------|
| Privacy Policy published | ⬜ Not Started | |
| Terms of Service published | ⬜ Not Started | |
| TCPA opt-in consent copy | ⬜ Not Started | |
| App Store Connect listing (name, description, keywords) | ⬜ Not Started | |
| Screenshots (all required device sizes) | ⬜ Not Started | |
| Submitted for App Store review | ⬜ Not Started | |

---

## v1.2 — Post App Store Launch (Planned)

| Phase | Feature | Status |
|-------|---------|--------|
| Phase 13 | Conversational Voice Mode (auto-detect end of speech, TTS, live visual feedback) | ⏳ Deferred |

---

## Push Log

*Most recent push at the top.*

### ✅ Push #16 — 2026-03-21
**What:** Phase 10 build config (`eas.json`, `app.json`), PROGRESS.md (now `docs/history/progress-log.md`), docs/plans/ + docs/specs/ spec + plan for on-demand scheduling
**Next up:** Apply 8 scheduling plan fixes → execute → Phase 10 Apple credentials

### ✅ Push #15 — 2026-03-21
**What:** v1.0 milestone shipped — Phase 7 complete (syllabus parsing + study gap detection)

### ✅ Push #14 — 2026-03-20
**What:** Phase 9 complete (Todoist integration)

### ✅ Push #13 — 2026-03-20
**What:** Phase 8 complete (iOS App + Onboarding)

### ✅ Push #12 — 2026-03-20
**What:** Phase 6 complete (Google OAuth + GCal + Gmail + conflict detection + SMS batching)

### ✅ Push #11 — 2026-03-19
**What:** Phase 5 complete (priority engine + canonical events)

### ✅ Push #10 — 2026-03-19
**What:** Phase 4 complete (Claude AI daily briefing + conversational replies)

### ✅ Push #9 — 2026-03-19
**What:** Phase 3 complete (Twilio SMS + TCPA compliance)

### ✅ Push #2 — 2026-03-18
**What:** Phase 1 + Phase 2 infrastructure foundation

### ✅ Push #1 — 2026-03-18
**What:** Repo setup, CLAUDE.md, FEATURES.md, slash commands
