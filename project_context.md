# Aria — Project Context

> **Read this at the start of every Claude session** before reading anything else.
> It's the TL;DR of the entire project state. Reduces context window overhead.

---

## What We're Building

**Aria** — proactive AI academic assistant for Yale students via SMS.
Syncs Canvas deadlines, Gmail, and Google Calendar. Sends a daily 8am briefing + deadline change alerts. Students reply by text. No app needed.

**Team:** Josh Shin (backend, Claude Code) + Seb (frontend, separate Claude Code account)
**Started:** March 18, 2026

---

## Current State

| Artifact | Status | Location |
|----------|--------|----------|
| Project definition | ✅ Done | `.planning/PROJECT.md` |
| GSD config (YOLO mode) | ✅ Done | `.planning/config.json` |
| Domain research | ✅ Done | `.planning/research/` |
| Requirements (52 reqs) | ✅ Done | `.planning/REQUIREMENTS.md` |
| Roadmap (7 phases) | ✅ Done | `.planning/ROADMAP.md` |
| Work coordination | ✅ Done | `WORK.md` |
| Phase 1 context | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-CONTEXT.md` |
| Phase 1 research | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-RESEARCH.md` |
| Phase 1 plans (2) | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-01-PLAN.md`, `01-02-PLAN.md` |
| Phase 1 validation | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-VALIDATION.md` |
| Phase 2 context | ✅ Done | `.planning/phases/02-canvas-ical-sync/02-CONTEXT.md` |
| Phase 2 research | ✅ Done | `.planning/phases/02-canvas-ical-sync/02-RESEARCH.md` |
| Phase 2 plans (2) | ✅ Done | `.planning/phases/02-canvas-ical-sync/02-01-PLAN.md`, `02-02-PLAN.md` |
| Phase 2 validation | ✅ Done | `.planning/phases/02-canvas-ical-sync/02-VALIDATION.md` |
| Phase 2 verification | ✅ Done | `.planning/phases/02-canvas-ical-sync/02-VERIFICATION.md` |
| Phase 3 context | ✅ Done | `.planning/phases/03-twilio-sms-tcpa-compliance/03-CONTEXT.md` |
| Phase 3 research | ✅ Done | `.planning/phases/03-twilio-sms-tcpa-compliance/03-RESEARCH.md` |
| Phase 3 plans (3) | ✅ Done | `.planning/phases/03-twilio-sms-tcpa-compliance/03-01-PLAN.md`, `03-02-PLAN.md`, `03-03-PLAN.md` |
| Phase 3 validation | ✅ Done | `.planning/phases/03-twilio-sms-tcpa-compliance/03-VALIDATION.md` |
| App code | ✅ Phase 3 complete | — |
| Phase 4 research | ✅ Done | `.planning/phases/04-claude-ai-daily-briefing/04-RESEARCH.md` |
| Phase 4 validation | ✅ Done | `.planning/phases/04-claude-ai-daily-briefing/04-VALIDATION.md` |
| Phase 4 plans (2) | ✅ Done | `.planning/phases/04-claude-ai-daily-briefing/04-01-PLAN.md`, `04-02-PLAN.md` |

**Active phase:** Phase 5 — Priority Engine + Canonical Timeline DB
**Next action:** `/gsd:plan-phase 5` — context captured, ready to plan (`/clear` first)

---

## Session Summary — 2026-03-19 (third session)

### What We Accomplished

1. **Executed Phase 4** — ran both plans via `gsd:execute-phase 4`; all 94 tests passing; verification passed 14/14 must-haves
2. **Discussed Phase 5** — captured all Priority Engine + Canonical Timeline DB decisions into `05-CONTEXT.md`

### Files Created

| File | Key Change |
|------|------------|
| `supabase/migrations/004_deadlines_task_management.sql` | **CREATED** — `status`, `snoozed_until`, `priority` columns on `deadlines`; `idx_deadlines_briefing` partial index |
| `celery_worker/ai/__init__.py` | **CREATED** — ai module package init |
| `celery_worker/ai/db.py` | **CREATED** — 4 shared Supabase query functions: `get_deadlines_for_briefing`, `get_conversation_history`, `briefing_sent_today`, `write_outbound_message` |
| `celery_worker/ai/briefing.py` | **CREATED** — `generate_briefing()` via Claude Sonnet; `compute_load_score()` (green/yellow/red); exam touchpoints (T-7,5,3,1,0); Monday 7-day extended mode; 800-char enforcement |
| `celery_worker/ai/replies.py` | **CREATED** — two-step Claude reply handler: intent extraction (JSON) → DB mutation (snooze/complete/priority) → warm reply; `OFF_TOPIC_RESPONSE` constant; conversation history dedup |
| `celery_worker/tests/ai/test_briefing.py` | **CREATED** — 18 unit tests for briefing generator |
| `celery_worker/tests/ai/test_replies.py` | **CREATED** — 11 unit tests for reply handler |
| `celery_worker/tests/test_tasks_ai.py` | **CREATED** — 10 integration tests for Celery AI tasks |
| `.planning/phases/04-claude-ai-daily-briefing/04-VERIFICATION.md` | **CREATED** — 14/14 must-haves verified; all requirement IDs (AI-04 through AI-11, CONV-01, etc.) accounted for |
| `.planning/phases/05-priority-engine-canonical-timeline-db/05-CONTEXT.md` | **CREATED** — Phase 5 implementation decisions (see below) |

### Files Modified

| File | Key Change |
|------|------------|
| `celery_worker/tasks.py` | Added `generate_daily_briefings_all` (fan-out), `generate_daily_briefing_user` (timezone + dedup guard), `welcome_briefing`, real `process_inbound_sms` routing via `handle_reply` |
| `celery_worker/celery_app.py` | Added Beat schedule: `generate_daily_briefings_all` every 15 min during hours 6–12 UTC |
| `celery_worker/requirements.txt` | Added `anthropic>=0.86.0` |
| `.planning/ROADMAP.md` | Phase 4 marked complete; Phase 5 status updated |
| `.planning/STATE.md` | Updated to reflect Phase 4 complete, Phase 5 context gathered |
| `.planning/PROJECT.md` | Claude AI briefings requirement moved from Active → Validated; new key decision row added |

### Decisions Made This Session (Not Captured in Code)

| Decision | Detail |
|----------|--------|
| `canonical_events` is a new table | `deadlines` stays as Canvas source-of-truth; backfill job copies existing rows into `canonical_events` on Phase 5 deploy; `ai/db.py` briefing queries switch to read from `canonical_events` going forward |
| Urgency decay: `min(1.0, e^(-0.15 × days))` | Aggressive decay — 3 days out = 0.64 urgency, 1 day = 0.86, 0 days = 1.0; overdue clamped to 1.0 |
| Score ≥ 80 bypasses quiet hours | Immediate alerts treated as transactional; use `send_sms_direct` (not `send_sms_safe`); opt-out check still applies — STOP always honored |
| Score ≥ 80 exempt from 3/day cap | Priority alerts don't count toward the daily proactive cap |
| Score 50–79 → always next morning | Digest-tier events always queue for tomorrow's 8am briefing; no same-night send regardless of when the event arrives |
| Phase 8 onboarding needs TCPA copy | Bypassing quiet hours for urgent alerts requires explicit opt-in language: "I agree to receive time-sensitive deadline alerts at any hour." Flag for Seb's onboarding UI. |

---

## Session Summary — 2026-03-19 (second session)

### What We Accomplished

1. **Ran `/gsd:plan-phase 4`** — researched, planned, and verified Phase 4 (Claude AI + Daily Briefing)
2. **Fixed briefing window bug before writing any code** — checker caught that `hour == 7` fires during quiet hours (10pm–8am), suppressing all briefings; shifted to `hour == 8`
3. **All plans committed** — 4 commits on `main`

### Planning Files Created or Modified

| File | Key Change |
|------|------------|
| `.planning/phases/04-claude-ai-daily-briefing/04-RESEARCH.md` | **CREATED** — anthropic 0.86.0 SDK patterns, per-user timezone scheduling via Beat + hour-check guard, conversation history dedup for SDK alternating-role requirement, welcome briefing trigger via `synced_at IS NULL` check |
| `.planning/phases/04-claude-ai-daily-briefing/04-VALIDATION.md` | **CREATED** — pytest-based validation strategy; 5 automated test files to create; 3 manual-only verifications (live SMS timing, tone quality, welcome briefing latency) |
| `.planning/phases/04-claude-ai-daily-briefing/04-01-PLAN.md` | **CREATED** — Wave 1: DB migration (`snoozed_until`, `priority` columns on `deadlines`) + `celery_worker/ai/db.py` data layer + `celery_worker/ai/briefing.py` (generate_briefing, compute_load_score, get_exam_touchpoints, Monday extended, 8am window guard) |
| `.planning/phases/04-claude-ai-daily-briefing/04-02-PLAN.md` | **CREATED** — Wave 2: `celery_worker/ai/replies.py` (conversational handler + task management via Claude) + Celery wiring (Beat fan-out, `generate_daily_briefing_user`, welcome briefing trigger, inbound SMS non-command path) |
| `.planning/ROADMAP.md` | **UPDATED** — Phase 4 Plans field updated from TBD to 2 plans |

### Decisions Made This Session (Not Captured in Code)

| Decision | Detail |
|----------|--------|
| Briefing window is `hour == 8`, not `hour == 7` | `send_sms_safe` enforces quiet hours until 8am — generating at 7am and sending immediately would be suppressed. Generation and send both happen at 8am. The Beat crontab `(minute="*/15", hour="6-12")` covers all US 8am windows. |
| Conversation history not included in daily briefing | AI-04 requires "last 5 exchanges" in briefing context, but CONTEXT.md scopes this to conversational replies only (CONV-01). Briefing generator receives only deadline data. Documented as intentional in plan design notes. |
| Welcome briefing detected via `synced_at IS NULL` | No new webhook or API route needed — `canvas_sync_user` detects first-ever sync by checking if `synced_at` was NULL before calling `mark_synced()`. Fires `welcome_briefing.delay(user_id)` on first sync. |
| Exam countdown bundled into daily briefing | Not a separate Celery Beat entry. `generate_briefing()` calls `get_exam_touchpoints()` internally. Single Beat job covers both. |
| `ai/` module pattern | New `celery_worker/ai/` package mirrors `celery_worker/canvas/` and `celery_worker/sms/` — separate `db.py`, `briefing.py`, `replies.py`. Tests in `celery_worker/tests/ai/`. |

---

## Session Summary — 2026-03-19

### What We Accomplished

1. **Ran `/gsd:discuss-phase 4`** — captured all Phase 4 implementation decisions into `04-CONTEXT.md`
2. **Received PRD v1.1 from Seb** — full product vision including iOS app, Priority Engine, expanded integrations
3. **Compared PRD v1.1 against all planning files** — identified 9 strategic discrepancies
4. **Made 9 product/architecture decisions** (see below)
5. **Updated 5 planning files** to align with PRD v1.1 — roadmap expanded 7 → 9 phases, requirements 52 → 68
6. **Pushed all work to GitHub** — 22 commits, branch `main`, remote `origin`
7. **Updated Notion PRD** — synced all changes to "Product Requirements Document — Aria v1" in Seb's workspace

### Planning Files Created or Modified

| File | Key Change |
|------|-----------|
| `.planning/phases/04-claude-ai-daily-briefing/04-CONTEXT.md` | **CREATED** — Phase 4 implementation decisions: conversational prose briefings, smart-friend tone, task management (mark done/snooze/priority), exam countdown (5 touchpoints), welcome briefing on Canvas URL save, last 5 exchanges in Claude context, Monday extended briefing, daily load score |
| `.planning/REQUIREMENTS.md` | **UPDATED** — 52 → 68 reqs; added PRIO-01/02/03 (Priority Engine), CONV-01 (conversation history), AI-08 (Monday briefing), AI-09 (daily load score), AI-10 (study gap), AI-11 (exam day-of), SMS-10/11 (batching), UI-06–09 (iOS app), TASK-01/02 (Todoist); INTEL-01/03 promoted from v2 to v1; GMAI-03 updated (metadata only, not full storage) |
| `.planning/ROADMAP.md` | **UPDATED** — 7 → 9 phases; Phase 5 = Priority Engine + Canonical Timeline DB (new); Phase 6 = GCal/Gmail/Alerts/Conflict Detection; Phase 7 = Syllabus + Study Gap; Phase 8 = iOS App + Onboarding; Phase 9 = Todoist |
| `.planning/PROJECT.md` | **UPDATED** — iOS = equal primary interface; 6-layer intelligence pipeline documented; Priority Engine scoring formula added; Gmail metadata-only policy; target audience expanded beyond Yale |
| `project_context.md` | **UPDATED** — roadmap table updated to 9 phases; this session summary added |

### Decisions Made This Session (Not Captured in Code)

| Decision | Detail |
|----------|--------|
| iOS app = equal primary interface | Phase 8, Seb leads; 4-zone card dashboard, in-app chat, voice input; starts parallel with Phase 6 once Phase 4 APIs are stable |
| Priority Engine is its own phase | Phase 5 — Canonical Timeline DB + scoring formula (`grade×0.35 + urgency×0.45 + source×0.20`). All Phase 6+ integrations write to the Canonical Store, not directly to their own tables |
| Conversation history in Claude context | Last 5 SMS exchanges included in every conversational reply (was: no history). Fetch from `messages` table ordered by `sent_at` descending |
| Exam countdown expanded to 5 touchpoints | T-7 (topics + study windows), T-5 (gap analysis — stub in Phase 4, live in Phase 7), T-3 (midpoint + office hours reminder), T-1 (final review), T-0 (day-of logistics at 7am) |
| Monday extended briefing | Added to Phase 4 scope (partial: 7-day horizon + daily load score); Phase 6 adds GCal conflicts and study windows. Triggered by `datetime.weekday() == 0` check in briefing generator |
| Daily load score | Green/yellow/red computed at briefing time; included in every briefing and feeds iOS app Zone 2 status bar in Phase 8 |
| Conflict detection promoted to v1 | INTEL-03 moved from v2 → Phase 6. Fires when Canvas deadline overlaps existing GCal event |
| Study gap detection promoted to v1 | INTEL-01 moved from v2 → Phase 7. Requires syllabus parsing (Phase 7) — runs gap analysis at T-5 days before exam |
| Todoist promoted to v1 | TASK-01/02 moved from v2 → Phase 9. Depends on Phase 5 Priority Engine for task scoring |
| SMS batching added | SMS-10/11: multiple alerts within 10 minutes batched into one message; no more than 3 texts in any 10-minute window. Added to Phase 6 when alerts are introduced |
| Gmail metadata only | GMAI-03 corrected — flagged emails stored as metadata in `gmail_flags` table (subject, sender, summary); full email content never stored permanently |
| `process_inbound_sms` non-command stub | Currently in `celery_worker/tasks.py` — the `# Phase 4 stub` comment marks the exact line where the Claude reply handler + conversation history goes in Phase 4 |

---

## Phase 1 — Completed ✅

All code executed, all 4 human verification steps passed (2026-03-18).

### Files Created

| File | Key Change |
|------|-----------|
| `src/types/index.ts` | Task, CalendarEvent, Message normalized types |
| `src/lib/supabase/client.ts` | Browser client via `createBrowserClient` |
| `src/lib/supabase/server.ts` | Server client via `createServerClient` + `await cookies()` (Next.js 15 async API) |
| `src/middleware.ts` | Token refresh on every request via `getClaims()` — NOT `getSession()` |
| `src/app/api/health/route.ts` | Returns 200/500 based on presence of 7 required env vars |
| `src/app/api/sms/webhook/route.ts` | Always 200; logs MessageSid only, never From (phone privacy) |
| `supabase/migrations/001_initial_schema.sql` | 8 tables + RLS + `handle_new_user` trigger (auto-creates `public.users` on signup) |
| `.env.example` | All required env var keys with empty values |
| `celery_worker/celery_app.py` | Celery app configured with Redis broker; `include=["tasks"]` (not `celery_worker.tasks`) |
| `celery_worker/tasks.py` | `tasks.ping()` — logs timestamp, no DB write; imports from `celery_app` (not `celery_worker.celery_app`) |
| `celery_worker/requirements.txt` | celery==5.6.2, redis, supabase, python-dotenv |
| `celery_worker/Dockerfile` | `FROM python:3.12-slim`; CMD uses `celery_app` (not `celery_worker.celery_app`) |
| `docker-compose.yml` | Redis + Celery worker; command uses `celery_app` (not `celery_worker.celery_app`) |

### Decisions Not Captured in Code

| Decision | Detail |
|----------|--------|
| Celery module naming inside container | Build context is `./celery_worker` so files land at `/app` root — all references inside the container drop the `celery_worker.` prefix (use `celery_app`, `tasks`, not `celery_worker.celery_app`, `celery_worker.tasks`) |
| AUTH-04 browser verification | Verified structurally (middleware compiles, `getClaims()` fires). Full browser login/refresh test deferred to Phase 7 when the onboarding UI exists |
| Test user created | `test@test.com` / `testpassword123` in Supabase — used to confirm `handle_new_user` trigger. UUID: `c881ebf6-41cd-45a5-9435-36bd2f0b98ad` |

---

## Phase 2 — Completed ✅

Canvas iCal sync fully implemented and verified (2026-03-18). 22/22 tests passing.

### Files Created

| File | Key Change |
|------|-----------|
| `celery_worker/requirements-dev.txt` | `pytest` + `pytest-mock` for test infrastructure |
| `celery_worker/pytest.ini` | pytest config; `testpaths = tests` |
| `celery_worker/tests/__init__.py` | Test package init |
| `celery_worker/tests/canvas/__init__.py` | Canvas test sub-package init |
| `celery_worker/tests/canvas/test_parse.py` | 8 tests: VEVENT parsing, DATE vs DATETIME UTC normalization, course/type extraction |
| `celery_worker/tests/canvas/test_diff.py` | 5 tests: added/changed/removed detection, title-only no-op |
| `celery_worker/tests/canvas/test_fetch.py` | 1 test: HTTP 429 raises `requests.HTTPError` |
| `celery_worker/tests/canvas/test_db.py` | 5 tests: upsert, soft-delete, mark_synced |
| `celery_worker/tests/test_celery_app.py` | 3 tests: beat_schedule entry at 3600s |
| `celery_worker/canvas/__init__.py` | Canvas module package init |
| `celery_worker/canvas/fetch.py` | `fetch_ical(url) -> bytes`; calls `raise_for_status()` so HTTP 429 triggers Celery retry |
| `celery_worker/canvas/parse.py` | `parse_vevents(bytes) -> list[dict]`; handles `DTSTART;TZID=` (UTC convert) and `DTSTART;VALUE=DATE` (→ 23:59:59Z end-of-day) |
| `celery_worker/canvas/diff.py` | `compute_diff(current, fresh) -> {added, changed, removed}`; due_date-only sensitivity (title-only changes ignored) |
| `celery_worker/canvas/db.py` | 4 Supabase functions: `get_all_canvas_integrations`, `load_current_deadlines`, `apply_diff` (upsert + soft-delete), `mark_synced` |
| `celery_worker/tasks.py` | Added `canvas_sync_all` (fan-out) + `canvas_sync_user` (full pipeline); `autoretry_for=(requests.HTTPError,)`, `retry_backoff=2`, `max_retries=5`; `mark_synced` called last |
| `celery_worker/celery_app.py` | Added `beat_schedule`: `canvas-sync-all-users` every 3600s |
| `supabase/migrations/002_deadlines_soft_delete.sql` | Adds `deleted_at TIMESTAMPTZ`, `idx_deadlines_active` partial index, `UNIQUE(canvas_uid, user_id)` constraint |
| `docker-compose.yml` | Added `celery_beat` service; uses `--schedule=/tmp/celerybeat-schedule` to keep binary out of source tree |
| `src/app/api/sync/canvas/route.ts` | Thin POST trigger returning 202; zero DB or iCal logic |
| `.gitignore` | Added `__pycache__/`, `*.pyc`, `.pytest_cache/`, `celerybeat-schedule` |

### Decisions Not Captured in Code

| Decision | Detail |
|----------|--------|
| `icalendar==6.3.2` (not 7.x) | 7.0.3 released 2026-03-03 — too new; 6.3.2 is proven stable with full docs |
| `canvas_uid` is user-scoped | Canvas UIDs are unique per feed, not globally — all DB queries must scope by `user_id`; upsert `on_conflict` is `(canvas_uid, user_id)` composite |
| Beat runs as separate container | `celery -A celery_app worker --beat` is dev-only; production always separates beat from worker to prevent scheduling drift |
| `mark_synced` called last | `integrations.synced_at` only written after `apply_diff` completes — partial sync failures don't advance the timestamp |
| Trigger route defers Redis publish | `/api/sync/canvas` returns 202 immediately; direct Celery task enqueueing via Redis is Phase 7 (requires Redis client in Next.js) |

---

## Phase 3 — Completed ✅

Twilio SMS layer + full TCPA compliance implemented and verified (2026-03-19). 55/55 tests passing.

### Files Created

| File | Key Change |
|------|-----------|
| `supabase/migrations/003_tcpa_columns.sql` | 7 TCPA columns on `users` table: `sms_opted_out`, `sms_opted_out_at`, `sms_paused_until`, `daily_sms_count`, `daily_sms_date`, `quiet_hours_start`, `quiet_hours_end`; 2 partial indexes |
| `celery_worker/sms/__init__.py` | sms package init |
| `celery_worker/sms/send.py` | `send_sms_safe()` with 4 ordered guards: opt-out → pause → quiet hours → daily proactive cap (3/day). `send_sms_direct()` bypass for STOP confirmation only. Midnight-spanning quiet hours use OR logic (`>= start OR < end`). PII-free structured logging (SHA-256 hashed uid). |
| `celery_worker/sms/commands.py` | `dispatch_command(body, user_id, to_phone)` — case-insensitive exact match on STOP/START/PAUSE/HELP. STOP uses `send_sms_direct` (bypasses guard); others use `send_sms_safe`. Returns `bool` indicating whether a command was handled. |
| `celery_worker/tests/sms/__init__.py` | sms test package init |
| `celery_worker/tests/sms/test_send.py` | 14 tests covering all guard paths and PII-free logging |
| `celery_worker/tests/sms/test_commands.py` | 16 tests covering all command paths and edge cases |
| `celery_worker/tests/test_tasks_sms.py` | 3 tests for `process_inbound_sms` task |
| `celery_worker/conftest.py` | `sys.path` setup so `@patch("sms.send.*")` resolves correctly at pytest collection time |

### Files Modified

| File | Key Change |
|------|-----------|
| `src/app/api/sms/webhook/route.ts` | Upgraded from Phase 1 stub: Twilio signature validation via `validateRequest` (returns 403 on spoof, always 200 to Twilio), user lookup, `messages` table write (`direction='in'`), `LPUSH` Redis enqueue for Celery. Uses `TWILIO_WEBHOOK_URL` env var (proxy-safe). Dev bypass via `TWILIO_DEV_BYPASS=true`. |
| `celery_worker/tasks.py` | Added `process_inbound_sms` task: looks up user phone, calls `dispatch_command`, stubs non-command path for Phase 4 |
| `celery_worker/requirements.txt` | Added `twilio==9.10.3` |
| `.env.example` | Added `TWILIO_WEBHOOK_URL`, `TWILIO_DEV_BYPASS`, `REDIS_URL` |
| `.planning/REQUIREMENTS.md` | SMS-03 moved from Phase 3 Complete → Phase 4 Pending (Claude conversational reply is Phase 4 scope) |

### Decisions Not Captured in Code

| Decision | Detail |
|----------|--------|
| SMS-03 scoping | Claude conversational reply (`process_inbound_sms` non-command path) is intentionally stubbed — Phase 4 work. Plan 03-03 incorrectly claimed SMS-03 as complete; corrected in traceability. |
| `send_sms_direct` bypass | STOP confirmation MUST use the direct bypass — using `send_sms_safe` would block the confirmation because the guard checks opt-out status first. Carrier compliance requires the final confirmation to send. |
| Quiet hours OR logic | Midnight-spanning windows (e.g. 22:00–08:00) require `time >= start OR time < end`, NOT a naive range comparison (which always evaluates False for spanning windows). |
| Test env mocking | Tests for send paths that reach Twilio must `@patch.dict(os.environ, TWILIO_ENV)` — `os.environ["TWILIO_ACCOUNT_SID"]` runs before the `Client` mock can intercept. |

---

## Roadmap (9 phases)

| # | Phase | Owner | Key Goal |
|---|-------|-------|----------|
| 1 | Infrastructure Foundation | Josh | ✅ Supabase schema + Redis + Celery + Vercel wired up |
| 2 | Canvas iCal Sync | Josh | ✅ Deadlines fetched, normalized, stored, diffed every 60 min |
| 3 | Twilio SMS + TCPA | Josh | ✅ TCPA guard, keyword dispatch, validated webhook, Celery inbound pipeline |
| 4 | Claude AI + Daily Briefing | Josh | ✅ 8am SMS + Monday extended briefing + conversational replies + task mgmt + exam countdown |
| 5 | Priority Engine + Canonical Timeline DB | Josh | Unified event scoring (grade×0.35 + urgency×0.45 + source×0.20), delivery router |
| 6 | Google OAuth + GCal + Gmail + Alerts | Josh | Deadline alerts ≤15 min, conflict detection, SMS batching, watch channel auto-renewal |
| 7 | Syllabus Parsing + Study Gap Detection | Josh | Claude Opus extracts grade weights; T-5 gap analysis goes live |
| 8 | iOS App + Onboarding | **Seb** | Full 4-zone card dashboard, in-app chat, voice input — starts parallel with Phase 6 |
| 9 | Todoist Integration | Josh | Personal tasks in briefings, priority scoring, task CRUD via SMS |

---

## Key Decisions Made

| Decision | What | Why |
|----------|------|-----|
| Next.js version | **15.2** (not 14) | 14 is outdated; breaking changes in params/cookies now async |
| Vector DB | **pgvector** (Supabase native) | Chroma dropped — unnecessary Railway service for 50 users |
| Auth package | **@supabase/ssr** (not `auth-helpers`) | auth-helpers-nextjs is deprecated; session persistence requires `getClaims()` in middleware |
| SMS for MVP | **Twilio SMS** | No native iMessage API; Sendblue iMessage is v2 |
| Briefing cadence | **Daily** (7am generate, 8am send) | Not weekly — daily is the confirmed MVP spec |
| Gmail scope | **MVP** (not v2) | Cross-referencing professor emails is core to deadline accuracy |
| Background jobs | **FastAPI + Celery + Redis on Railway** | Python needed for Claude AI workloads; Next.js handles webhooks only |
| Claude in webhooks | **Never inline** | Always enqueue to Celery — Vercel 30s timeout would kill it |
| Twilio number type | **10DLC local number** | Cheapest + most carrier-trusted for US college audience; A2P registration required before Phase 3 sends bulk SMS |
| `tasks.ping()` | **Console-only in Phase 1** | `messages.user_id` is NOT NULL — no real user exists yet; DB write deferred to Phase 2 |
| Railway layout | **3 separate entities** | Next.js service + Celery worker service + Redis plugin; shared env group for secrets |
| Supabase users table | **FK to `auth.users.id`** | Supabase Auth owns credentials; `public.users` stores app fields only (phone, preferences) |
| RLS | **On from day one** | User-scoped policies (`WHERE user_id = auth.uid()`) on all 7 tables; never retrofitted |

---

## ⚠️ Critical Gotchas

1. **Google OAuth Gmail scope** — app verification by Google takes 1–6 weeks. Start the Google Cloud Console verification process NOW (Phase 1), before you need it in Phase 5.
2. **GCal + Gmail watch channels expire every 7 days** silently — the Celery renewal cron (runs 48h before expiry) is P0 infrastructure, not optional polish. Goes in Phase 5.
3. **Twilio inbound webhook** — must return HTTP 200 in <1 second. Never call Claude inline. Return 200, enqueue Celery task, reply async.
4. **TCPA compliance** — opt-out check before EVERY outbound SMS regardless of carrier blocking. Ships in Phase 3, not retrofitted later.
5. **Welcome briefing** — trigger synchronously at onboarding completion. Users who wait 18h for first SMS think the product is broken.
6. **Canvas iCal UID stability** — validate against a real Yale Canvas feed before building the diff engine (UID may be unstable on some instances).

---

## Two-Developer Coordination

**Always start with:** `git pull origin main` → read `WORK.md` → claim a task → push claim
**Never touch the other dev's files** (see ownership table in `CLAUDE.md`)
**Slash commands:** `/project:start` (claim task) → `/project:done` (release + handoff note)

Josh owns: `src/lib/`, `src/app/api/`, `supabase/`
Seb owns: `src/app/(pages)/`, `src/components/`
Both must sync before touching: `src/types/index.ts`, `supabase/migrations/`

---

## Tech Stack (confirmed)

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15.2, TypeScript, Tailwind, `@supabase/ssr` |
| Backend | Next.js API routes (webhooks) + FastAPI + Celery + Redis |
| Database | Supabase (PostgreSQL + pgvector) |
| Auth | Supabase Auth + Google OAuth 2.0 |
| SMS | Twilio (MVP) → Sendblue iMessage (v2) |
| AI | Claude API: Opus (syllabus), Sonnet (briefing + replies), Haiku (classification) |
| Jobs | Celery + Redis on Railway |
| Deploy | Vercel (Next.js) + Railway (FastAPI + Celery workers) |

---

## Files to Read for Full Context

- `CLAUDE.md` — architecture decisions, code style, integration patterns, ownership rules
- `WORK.md` — active work state (claimed tasks, queue, handoff notes)
- `.planning/ROADMAP.md` — full phase breakdown with success criteria
- `.planning/REQUIREMENTS.md` — all 52 v1 requirements with traceability
- `.planning/research/SUMMARY.md` — research synthesis (stack, features, architecture, pitfalls)
- `.planning/phases/01-infrastructure-foundation/` — context, research, plans, validation for Phase 1
- `.planning/phases/02-canvas-ical-sync/` — context, research, plans, validation, verification for Phase 2
- `.planning/phases/03-twilio-sms-tcpa-compliance/` — context, research, plans, summaries, verification for Phase 3
