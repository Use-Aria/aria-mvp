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

**Active phase:** Phase 4 — Claude AI + Daily Briefing
**Next action:** `/gsd:plan-phase 4` (context already written, research + planning next)

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
| 4 | Claude AI + Daily Briefing | Josh | 8am SMS + Monday extended briefing + conversational replies + task mgmt + exam countdown |
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
