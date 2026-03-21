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
| Requirements (68 reqs) | ✅ Done | `.planning/REQUIREMENTS.md` |
| Roadmap (9 phases) | ✅ Done | `.planning/ROADMAP.md` |
| Work coordination | ✅ Done | `WORK.md` |
| Phase 1–5 artifacts | ✅ Done | `.planning/phases/01–05/` |
| Phase 6 context | ✅ Done | `.planning/phases/06-google-oauth-gcal-gmail-alerts-conflict-detection/06-CONTEXT.md` |
| Phase 6 research | ✅ Done | `.planning/phases/06-.../06-RESEARCH.md` |
| Phase 6 plans (5) | ✅ Done | `06-01-PLAN.md` through `06-05-PLAN.md` |
| Phase 6 summaries (5) | ✅ Done | `06-01-SUMMARY.md` through `06-05-SUMMARY.md` |
| Phase 6 validation | ✅ Done | `06-VALIDATION.md` |
| Phase 6 verification | ✅ Done | `06-VERIFICATION.md` — 19/19 must-haves passed |
| Phase 7 context | ✅ Done | `.planning/phases/07-syllabus-parsing-study-gap-detection/07-CONTEXT.md` |
| Phase 7 research | ✅ Done | `.planning/phases/07-.../07-RESEARCH.md` |
| Phase 7 validation | ✅ Done | `.planning/phases/07-.../07-VALIDATION.md` |
| Phase 7 plans (2) | ✅ Done | `07-01-PLAN.md`, `07-02-PLAN.md` |

**Active phase:** None — Phase 6 complete, Phase 7 planned but NOT YET EXECUTED
**Next action:** `/gsd:execute-phase 7` (`/clear` first)

---

## Session Summary — 2026-03-20 (seventh session)

### What We Accomplished

1. **Planned Phase 7** — ran `/gsd:plan-phase 7`; research, validation, and 2 plans created across 2 waves

### Files Created

| File | Key Change |
|------|------------|
| `.planning/phases/07-syllabus-parsing-study-gap-detection/07-CONTEXT.md` | **CREATED** — upload pathway decisions, parsed JSON schema, gap analysis delivery (T-5), briefing enrichment scope |
| `.planning/phases/07-syllabus-parsing-study-gap-detection/07-RESEARCH.md` | **CREATED** — Claude Opus document block API, pdfplumber fallback, ILIKE matching strategy |
| `.planning/phases/07-syllabus-parsing-study-gap-detection/07-VALIDATION.md` | **CREATED** — pytest validation strategy; manual-only tests for live PDF upload and gap SMS |
| `.planning/phases/07-syllabus-parsing-study-gap-detection/07-01-PLAN.md` | **CREATED** — Wave 1: migration 007 (UNIQUE constraint on syllabi), `ai/syllabus.py` (parse_syllabus_pdf, check_existing_syllabus, upsert_syllabus), `parse_syllabus_task`, upload route |
| `.planning/phases/07-syllabus-parsing-study-gap-detection/07-02-PLAN.md` | **CREATED** — Wave 2: gap analysis functions (get_gap_topics, build_gap_alert_body, get_syllabus_context), Celery fan-out tasks, Beat schedule at 03:00 UTC, briefing enrichment with syllabus_context param |

### Decisions Made This Session (Not Captured in Code)

| Decision | Detail |
|----------|--------|
| PDF never stored permanently | PDF bytes pass through Next.js → base64 in Redis task queue → Celery decodes → parses → discards. Only `parsed_json` persists in Supabase. |
| Never re-parse guard | `check_existing_syllabus()` called first; if `parsed_json` already exists for `(user_id, course_name)`, skips Claude call entirely. |
| `(user_id, course_name)` UNIQUE constraint | Migration 007 adds this to the existing `syllabi` table from Phase 1. Enables idempotent upsert. |
| ILIKE for course matching | `syllabi.course_name` (user-provided) vs `canonical_events.course_id` (Canvas-derived) may differ in case or formatting. ILIKE substring match handles "BIOL 201" vs "biol201 lab". |
| T-5 gap analysis via time-elapsed proxy | "Covered material" = topics from exams scheduled more than 5 days ago. Upcoming exam topics are gap candidates. No manual tracking required from student. |
| Beat at 03:00 UTC | `gap_analysis_all_users` fires daily at 03:00 UTC — avoids the 06:00–12:00 briefing window. |
| `syllabus_context` follows `gcal_context` pattern | Added as optional param to `generate_briefing()`; daily = exam topic hints for exams within 7 days; Monday = full coverage summaries for exams within 14 days. Gated by `is_monday` same as `gcal_context`. |

---

## Session Summary — 2026-03-20 (sixth session)

### What We Accomplished

1. **Executed Phase 6** — ran all 5 plans via `/gsd:execute-phase 6`; 220 tests passing; verification passed 19/19 must-haves
2. **Google OAuth complete** — Fernet-encrypted token storage, HMAC CSRF, Calendar + Gmail scopes, confirmation SMS + study pref flow
3. **SMS batching complete** — Redis SETNX batch queue, 10-min window, 3-text cap (SMS-10/SMS-11)
4. **GCal sync complete** — 7-day rolling window, declined/transparent filter, push webhook, watch channel auto-renewal
5. **Gmail pipeline complete** — Pub/Sub watch, `.edu` filter, Claude Haiku classification, rapidfuzz cross-reference, contradiction alerts
6. **Conflict detection complete** — same-day Canvas vs GCal matching, deduped by `(deadline_id, gcal_event_id, deadline_due_at)`, study block offer
7. **GCal write-back complete** — `create_study_block` via `events().insert()`, free slot finder with preference ordering, undo support
8. **Monday briefing enriched** — `get_briefing_gcal_context` adds conflict warnings + top-3 study windows to Claude prompt on Mondays

### Files Created

| File | Key Change |
|------|------------|
| `supabase/migrations/006_google_integrations.sql` | **CREATED** — `gmail_flags`, `conflict_alerts` tables; 4 watch columns on `integrations` (channel_id, resource_id, watch_expires_at, history_id) |
| `celery_worker/google_auth/encryption.py` | **CREATED** — `encrypt_token()`/`decrypt_token()` via Fernet + `TOKEN_ENCRYPTION_KEY` |
| `celery_worker/google_auth/tokens.py` | **CREATED** — `store_google_tokens()` (encrypts before upsert), `load_google_tokens()` (decrypts on return) |
| `celery_worker/sms/batch.py` | **CREATED** — `enqueue_alert()` (SETNX lock), `flush_batch()` (sorted by priority, capped at 3); `BATCH_TTL=600`, `MAX_TEXTS_PER_WINDOW=3` |
| `celery_worker/gcal/auth.py` | **CREATED** — `build_gcal_service()` with 5-min pre-expiry refresh + re-store |
| `celery_worker/gcal/fetch.py` | **CREATED** — `fetch_gcal_events()`: 7-day window, filters declined + transparent, infers type |
| `celery_worker/gcal/db.py` | **CREATED** — `store_calendar_events()`, `get_calendar_events()`, `store_watch_channel()`, `get_watch_channel()` |
| `celery_worker/gcal/watch.py` | **CREATED** — `establish_watch()`, `stop_watch()`, `renew_watch()` with graceful stop-failure |
| `celery_worker/gcal/conflicts.py` | **CREATED** — `detect_conflicts_user()`: same-day match, dedup via DB UNIQUE + Python set, routes through batch queue |
| `celery_worker/gcal/slots.py` | **CREATED** — `find_free_slots()`: cursor-based gap sweep, waking hours 7am-10pm, `PREFERENCE_ORDER` sort |
| `celery_worker/gcal/writeback.py` | **CREATED** — `create_study_block()`, `delete_study_block()`, `schedule_study_block()` |
| `celery_worker/gmail/auth.py` | **CREATED** — `build_gmail_service()` mirrors gcal/auth.py |
| `celery_worker/gmail/fetch.py` | **CREATED** — `fetch_new_messages()` (`.edu` filter, `format=metadata`), `decode_pubsub_message()`, historyId cursor |
| `celery_worker/gmail/classify.py` | **CREATED** — `classify_email()` via Claude Haiku; `find_matching_deadline()` via `rapidfuzz.fuzz.token_set_ratio >= 70` |
| `celery_worker/gmail/watch.py` | **CREATED** — `establish_gmail_watch()` + `renew_gmail_watch()` via `GMAIL_PUBSUB_TOPIC` |
| `src/app/api/auth/google/route.ts` | **CREATED** — OAuth initiation: HMAC state, httpOnly cookie, Calendar + Gmail scopes, `access_type=offline`, `prompt=consent` |
| `src/app/api/auth/google/callback/route.ts` | **CREATED** — CSRF validation, token exchange, dispatches `encrypt_and_store_tokens` via Redis (no plaintext DB write) |
| `src/app/api/gcal/webhook/route.ts` | **CREATED** — Returns 200 for sync handshake; enqueues `gcal_sync_user` via Redis LPUSH |
| `src/app/api/gmail/webhook/route.ts` | **CREATED** — Decodes base64url Pub/Sub message; dispatches `gmail_process_notification` |
| All Phase 6 test files | **CREATED** — 97 new tests; 220 total suite |

### Files Modified

| File | Key Change |
|------|------------|
| `celery_worker/tasks.py` | Added: `encrypt_and_store_tokens`, `gcal_sync_user`, `gcal_sync_all`, `renew_watch_channels`, `detect_conflicts_user`, `gmail_process_notification`, `flush_sms_batch`; wired `canvas_sync_user` → `detect_conflicts_user.delay`; Monday briefing passes `gcal_context` |
| `celery_worker/ai/briefing.py` | Added `get_briefing_gcal_context()` + `gcal_context` param in `generate_briefing()`; SCHEDULING CONFLICTS + BEST AVAILABLE STUDY WINDOWS sections on Mondays |
| `celery_worker/ai/replies.py` | Added `_handle_study_preference_reply()` + interception before Claude for morning/afternoon/evening answers |
| `celery_worker/celery_app.py` | Added `renew-watch-channels` Beat entry (every 6 hours) |
| `celery_worker/requirements.txt` | Added `cryptography>=42.0.0`, `google-api-python-client>=2.120.0`, `google-auth>=2.29.0`, `google-auth-oauthlib>=1.2.0`, `google-cloud-pubsub>=2.21.0`, `rapidfuzz>=3.9.0` |
| `celery_worker/requirements-dev.txt` | Added `fakeredis>=2.23.0` |
| `.planning/ROADMAP.md` | Phase 6 marked complete |

### Decisions Made This Session (Not Captured in Code)

| Decision | Detail |
|----------|--------|
| Tokens NEVER plaintext in Supabase | Next.js callback dispatches `encrypt_and_store_tokens` Celery task — tokens are plaintext only in process memory + transient Redis queue; Fernet-encrypted before DB write |
| `prompt=consent` forced in OAuth URL | Ensures Google always returns `refresh_token` on re-auth, not just first connect |
| HMAC state in httpOnly cookie | Stateless CSRF protection — no DB round-trip needed; 10-min TTL |
| SETNX for batch lock | Atomic first-enqueuer detection — prevents duplicate `flush_sms_batch` scheduling when two alerts arrive simultaneously |
| Event marked `sent` on enqueue | Not at flush time — prevents priority router from re-dispatching while alert sits in batch window |
| Lazy import patching in conflict tests | `detect_conflicts_user` lazy-imports `enqueue_alert` — tests must patch `sms.batch.enqueue_alert`, not `gcal.conflicts.enqueue_alert` |
| March 2026 = EDT (-04:00) | DST active in March; test helpers use `-04:00` offset not `-05:00` |
| Cross-platform strftime | `%-I` doesn't work on Windows; use `%I%p").lstrip("0").lower()` in `get_briefing_gcal_context` |
| `google_email` column TODO | Gmail webhook dispatches to all Google-connected users (MVP). historyId cursor prevents duplicate processing. Precise per-user matching deferred. |

---

## Session Summary — 2026-03-20 (fifth session)

### What We Accomplished

1. **Executed Phase 5** — ran both plans via `/gsd:execute-phase 5`; 123 tests passing; verification passed 9/9 must-haves
2. **Priority Engine complete** — `score_event()`, `compute_urgency()`, `route_event()` built TDD with 21 tests
3. **Canonical Timeline DB complete** — `canonical_events` table, ingest entry point, `send_sms_alert()`, canvas_sync wired, backfill tasks, briefing switchover

### Files Created

| File | Key Change |
|------|------------|
| `celery_worker/priority/__init__.py` | **CREATED** — package init |
| `celery_worker/priority/engine.py` | **CREATED** — `compute_urgency(days)` (exp decay, clamp ≤0 → 1.0), `score_event(grade_weight, days, source)` → int 0-100, `SOURCE_AUTHORITY` dict |
| `celery_worker/priority/router.py` | **CREATED** — `route_event(score)` → `'immediate'` (≥80), `'digest'` (50-79), `'silent'` (<50) |
| `celery_worker/tests/priority/__init__.py` | **CREATED** — package init |
| `celery_worker/tests/priority/test_engine.py` | **CREATED** — 13 tests: urgency spot checks, score formula, NULL grade_weight, unknown source fallback |
| `celery_worker/tests/priority/test_router.py` | **CREATED** — 8 tests: all boundary values (0, 49, 50, 65, 79, 80, 95, 100) |
| `supabase/migrations/005_canonical_events.sql` | **CREATED** — `canonical_events` table; `UNIQUE(user_id, source, title, due_at)`; `delivery_status CHECK('immediate','digest','silent','sent')`; RLS; two partial indexes |
| `celery_worker/priority/ingest.py` | **CREATED** — `ingest_canonical_event()`: UTC coerce, grade_weight normalize (% → fraction), score, route, upsert, lazy-import alert dispatch; `skip_routing=True` backfill safety |
| `celery_worker/tests/priority/test_ingest.py` | **CREATED** — 5 tests: happy path, skip_routing forces silent, None grade_weight, score≥80 dispatches alert, % normalization |

### Files Modified

| File | Key Change |
|------|------------|
| `celery_worker/sms/send.py` | Added `send_sms_alert()` — bypasses quiet hours, pause, daily cap; checks opt-out only; logs hashed UID |
| `celery_worker/tasks.py` | Added `send_priority_alert`, `backfill_canonical_events`, `backfill_canonical_events_user` (skip_routing=True); wired `canvas_sync_user` to call `ingest_canonical_event` after `apply_diff`; switched briefing to `get_events_for_briefing` |
| `celery_worker/ai/db.py` | Added `get_events_for_briefing()` (reads canonical_events, filters snoozed in Python, marks digest→sent, adds `due_date`/`course` shim keys); deprecated `get_deadlines_for_briefing` |
| `celery_worker/tests/sms/test_send.py` | Added 3 tests for `send_sms_alert`: active user, opted-out, bypasses guards |
| `celery_worker/tests/test_tasks_ai.py` | Updated 3 existing tests to patch `get_events_for_briefing` |

### Decisions Made This Session (Not Captured in Code)

| Decision | Detail |
|----------|--------|
| `ingest_canonical_event` uses lazy import for `send_priority_alert` | `tasks.py` imports from `priority/` — importing back creates circular. Lazy import inside `if delivery_status == 'immediate'` block avoids this. |
| `get_events_for_briefing` adds field mapping shim | `generate_briefing()` expects `due_date` and `course` keys; canonical_events uses `due_at` and `course_id`. Shim added until Phase 7 confirms full coverage. |
| Test patches target source module | `ingest.py` imports `score_event` inside function body — tests must patch `priority.engine.score_event`, not `priority.ingest.score_event`. |

---

## Phase 1 — Completed ✅

All code executed, all 4 human verification steps passed (2026-03-18).

### Files Created

| File | Key Change |
|------|-----------|
| `src/types/index.ts` | Task, CalendarEvent, Message normalized types |
| `src/lib/supabase/client.ts` | Browser client via `createBrowserClient` |
| `src/lib/supabase/server.ts` | Server client via `createServerClient` + `await cookies()` |
| `src/middleware.ts` | Token refresh on every request via `getClaims()` |
| `src/app/api/health/route.ts` | Returns 200/500 based on presence of 7 required env vars |
| `src/app/api/sms/webhook/route.ts` | Always 200; logs MessageSid only, never From |
| `supabase/migrations/001_initial_schema.sql` | 8 tables + RLS + `handle_new_user` trigger |
| `.env.example` | All required env var keys |
| `celery_worker/celery_app.py` | Celery app configured with Redis broker |
| `celery_worker/tasks.py` | `tasks.ping()` |
| `celery_worker/requirements.txt` | celery==5.6.2, redis, supabase, python-dotenv |
| `celery_worker/Dockerfile` | `FROM python:3.12-slim` |
| `docker-compose.yml` | Redis + Celery worker |

---

## Phase 2 — Completed ✅

Canvas iCal sync fully implemented and verified (2026-03-18). 22/22 tests passing.

### Files Created

| File | Key Change |
|------|-----------|
| `celery_worker/canvas/fetch.py` | `fetch_ical(url) -> bytes`; raises HTTPError on 429 |
| `celery_worker/canvas/parse.py` | `parse_vevents(bytes) -> list[dict]`; handles TZID + VALUE=DATE |
| `celery_worker/canvas/diff.py` | `compute_diff(current, fresh) -> {added, changed, removed}` |
| `celery_worker/canvas/db.py` | 4 Supabase functions: get_all, load_current, apply_diff, mark_synced |
| `supabase/migrations/002_deadlines_soft_delete.sql` | Adds `deleted_at`, partial index, UNIQUE(canvas_uid, user_id) |

---

## Phase 3 — Completed ✅

Twilio SMS layer + full TCPA compliance implemented and verified (2026-03-19). 55/55 tests passing.

### Files Created

| File | Key Change |
|------|-----------|
| `supabase/migrations/003_tcpa_columns.sql` | 7 TCPA columns on `users`; 2 partial indexes |
| `celery_worker/sms/send.py` | `send_sms_safe()` (4 guards: opt-out → pause → quiet hours → daily cap); `send_sms_direct()` bypass |
| `celery_worker/sms/commands.py` | `dispatch_command()` — STOP/START/PAUSE/HELP |
| `src/app/api/sms/webhook/route.ts` | Twilio signature validation, user lookup, Redis enqueue |

---

## Phase 4 — Completed ✅

Claude AI daily briefing + conversational SMS replies + task management (2026-03-19). 94/94 tests passing.

### Files Created

| File | Key Change |
|------|-----------|
| `supabase/migrations/004_deadlines_task_management.sql` | `status`, `snoozed_until`, `priority` columns on `deadlines` |
| `celery_worker/ai/db.py` | 4 shared Supabase query functions |
| `celery_worker/ai/briefing.py` | `generate_briefing()` via Claude Sonnet; `compute_load_score()`; exam touchpoints; Monday 7-day mode; 800-char enforcement |
| `celery_worker/ai/replies.py` | Two-step Claude reply handler: intent extraction (JSON) → DB mutation → warm reply |

---

## Roadmap (9 phases)

| # | Phase | Owner | Key Goal |
|---|-------|-------|----------|
| 1 | Infrastructure Foundation | Josh | ✅ Supabase schema + Redis + Celery + Vercel wired up |
| 2 | Canvas iCal Sync | Josh | ✅ Deadlines fetched, normalized, stored, diffed every 60 min |
| 3 | Twilio SMS + TCPA | Josh | ✅ TCPA guard, keyword dispatch, validated webhook, Celery inbound pipeline |
| 4 | Claude AI + Daily Briefing | Josh | ✅ 8am SMS + Monday extended briefing + conversational replies + task mgmt + exam countdown |
| 5 | Priority Engine + Canonical Timeline DB | Josh | ✅ Unified event scoring, canonical_events table, ingest entry point, send_sms_alert, canvas_sync wired |
| 6 | Google OAuth + GCal + Gmail + Alerts | Josh | ✅ Deadline alerts ≤15 min, conflict detection, SMS batching, watch channel auto-renewal, study blocks, Monday briefing enriched |
| 7 | Syllabus Parsing + Study Gap Detection | Josh | 📋 PLANNED — Claude Opus extracts grade weights; T-5 gap analysis; briefing enrichment; 2 plans ready |
| 8 | iOS App + Onboarding | **Seb** | Full 4-zone card dashboard, in-app chat, voice input — starts parallel with Phase 6 |
| 9 | Todoist Integration | Josh | Personal tasks in briefings, priority scoring, task CRUD via SMS |

---

## Key Decisions Made

| Decision | What | Why |
|----------|------|-----|
| Next.js version | **15.2** (not 14) | 14 is outdated; breaking changes in params/cookies now async |
| Vector DB | **pgvector** (Supabase native) | Chroma dropped — unnecessary Railway service for 50 users |
| Auth package | **@supabase/ssr** (not `auth-helpers`) | auth-helpers-nextjs is deprecated |
| SMS for MVP | **Twilio SMS** | No native iMessage API; Sendblue iMessage is v2 |
| Briefing cadence | **Daily** (8am generate + send) | Not weekly — daily is the confirmed MVP spec |
| Gmail scope | **MVP** (not v2) | Cross-referencing professor emails is core to deadline accuracy |
| Background jobs | **FastAPI + Celery + Redis on Railway** | Python needed for Claude AI workloads |
| Claude in webhooks | **Never inline** | Always enqueue to Celery — Vercel 30s timeout |
| Twilio number type | **10DLC local number** | Cheapest + most carrier-trusted for US college audience |
| Railway layout | **3 separate entities** | Next.js service + Celery worker service + Redis plugin |
| Supabase users table | **FK to `auth.users.id`** | Supabase Auth owns credentials |
| RLS | **On from day one** | User-scoped policies on all tables; never retrofitted |
| Token encryption | **Fernet symmetric** (`cryptography` library) | AES-256 at rest; `TOKEN_ENCRYPTION_KEY` env var |
| Gmail alert threshold | **confidence >= 0.8** | Claude Haiku JSON; only high-confidence deadline changes fire alert |
| Fuzzy match | **rapidfuzz token_set_ratio >= 70** | Gmail subject vs Canvas deadline title cross-reference |
| Study preference | **Captured on first Google connect** | SMS question: morning/afternoon/evening; stored in `preferences_json.study_preference` |

---

## ⚠️ Critical Gotchas

1. **Google OAuth Gmail scope** — app verification by Google takes 1–6 weeks. Start Google Cloud Console verification process early.
2. **GCal + Gmail watch channels expire every 7 days** silently — `renew-watch-channels` Beat job runs every 6 hours, renews at 48h before expiry. P0 infrastructure.
3. **Twilio inbound webhook** — must return HTTP 200 in <1 second. Never call Claude inline.
4. **TCPA compliance** — opt-out check before EVERY outbound SMS. Ships in Phase 3, not retrofitted.
5. **Welcome briefing** — trigger synchronously at onboarding completion.
6. **Canvas iCal UID stability** — validate against a real Yale Canvas feed before building the diff engine.
7. **Token encryption boundary** — Next.js callback NEVER writes tokens to Supabase directly. Always via `encrypt_and_store_tokens` Celery task. Tokens are plaintext only in process memory + transient Redis queue.
8. **Lazy import patching** — any module that lazy-imports inside a function body (e.g. `gcal/conflicts.py` imports `enqueue_alert` lazily) must be patched at the SOURCE module, not the importing module.
9. **Cross-platform strftime** — `%-I` doesn't work on Windows. Use `%I%p").lstrip("0").lower()` pattern.
10. **Phase 7 course matching** — `syllabi.course_name` (user-provided) vs `canonical_events.course_id` (Canvas-derived) may differ. Always use ILIKE for matching.

---

## Two-Developer Coordination

**Always start with:** `git pull origin main` → read `WORK.md` → claim a task → push claim
**Never touch the other dev's files** (see ownership table in `CLAUDE.md`)

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
| Deploy | Vercel (Next.js) + Railway (Celery workers) |
| Encryption | `cryptography` (Fernet) for Google OAuth tokens at rest |
| Fuzzy match | `rapidfuzz` for Gmail → Canvas title cross-reference |

---

## Files to Read for Full Context

- `CLAUDE.md` — architecture decisions, code style, integration patterns, ownership rules
- `WORK.md` — active work state (claimed tasks, queue, handoff notes)
- `.planning/ROADMAP.md` — full phase breakdown with success criteria
- `.planning/REQUIREMENTS.md` — all 68 v1 requirements with traceability
- `.planning/phases/06-google-oauth-gcal-gmail-alerts-conflict-detection/` — context, research, plans, summaries, verification for Phase 6
- `.planning/phases/07-syllabus-parsing-study-gap-detection/` — context, research, validation, plans for Phase 7 (ready to execute)
