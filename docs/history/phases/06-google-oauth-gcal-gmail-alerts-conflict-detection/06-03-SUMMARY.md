---
phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection
plan: 03
subsystem: api
tags: [gcal, google-calendar, celery, redis, push-notifications, webhook, oauth, python]

# Dependency graph
requires:
  - phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection
    plan: 01
    provides: "Google OAuth token storage (store_google_tokens, load_google_tokens), encryption, integrations table watch channel columns"
  - phase: 05-priority-engine-canonical-timeline-db
    plan: 02
    provides: "ingest_canonical_event() for canonical_events ingestion, _get_supabase()"

provides:
  - "gcal/auth.py: build_gcal_service() with 5-minute auto-refresh"
  - "gcal/fetch.py: fetch_gcal_events() — 7-day window, filtered, normalized"
  - "gcal/db.py: store_calendar_events(), get_calendar_events(), store_watch_channel(), get_watch_channel()"
  - "gcal/watch.py: establish_watch(), stop_watch(), renew_watch()"
  - "tasks.gcal_sync_user: full sync pipeline (fetch → store → ingest canonical → detect conflicts)"
  - "tasks.gcal_sync_all: fan-out to all Google-connected users"
  - "tasks.renew_watch_channels: auto-renew expiring channels via Beat"
  - "tasks.detect_conflicts_user: stub task (Plan 05 to implement)"
  - "POST /api/gcal/webhook: push notification receiver → enqueues gcal_sync_user via Redis"
  - "Beat schedule: renew-watch-channels runs every 6 hours"

affects:
  - "06-04 (Gmail sync) — same auth pattern via build_gcal_service"
  - "06-05 (conflict detection) — will implement detect_conflicts_user stub"
  - "05-xx (priority engine) — GCal events now flow into canonical_events"

# Tech tracking
tech-stack:
  added:
    - "google-api-python-client (already in requirements.txt)"
    - "google-auth (already in requirements.txt)"
  patterns:
    - "Lazy imports inside function body for circular-dependency avoidance (same as priority.ingest)"
    - "Patch at source module (gcal.auth.build_gcal_service, ai.db._get_supabase) when function does lazy import"
    - "Redis LPUSH Celery task format with base64-encoded body (same as SMS webhook)"
    - "X-Goog-Channel-Token = user_id for stateless push routing (no DB lookup on each push)"

key-files:
  created:
    - "celery_worker/gcal/__init__.py"
    - "celery_worker/gcal/auth.py"
    - "celery_worker/gcal/fetch.py"
    - "celery_worker/gcal/db.py"
    - "celery_worker/gcal/watch.py"
    - "celery_worker/tests/gcal/__init__.py"
    - "celery_worker/tests/gcal/test_fetch.py"
    - "celery_worker/tests/gcal/test_db.py"
    - "celery_worker/tests/gcal/test_watch.py"
    - "src/app/api/gcal/webhook/route.ts"
  modified:
    - "celery_worker/tasks.py — added gcal_sync_all, gcal_sync_user, detect_conflicts_user, renew_watch_channels"
    - "celery_worker/celery_app.py — added renew-watch-channels Beat entry"
    - "supabase/migrations/006_google_integrations.sql — added UNIQUE(user_id, google_event_id) to calendar_events"

key-decisions:
  - "Patch at gcal.auth.build_gcal_service (source module) not gcal.fetch.build_gcal_service — required because fetch.py uses lazy import inside function body"
  - "X-Goog-Channel-Token set to user_id during watch setup — enables stateless push notification routing without DB lookup"
  - "detect_conflicts_user added as stub task — allows gcal_sync_user to chain it immediately; Plan 05 replaces stub with real implementation"
  - "UNIQUE(user_id, google_event_id) added to migration 006 — required for store_calendar_events ON CONFLICT upsert, missing from 001"
  - "watch channel 7-day TTL with 6h Beat renewal checking 48h window — 2x safety margin ensures no gaps between Beat runs"

patterns-established:
  - "GCal event type inference: title keyword matching (exam/midterm/final/quiz/test → exam, lecture/class/section/seminar/lab → class, study/review/homework/pset → study, else → personal)"
  - "GCal filtering: skip transparency=transparent AND any attendee with self=True + responseStatus=declined"
  - "Push webhook always returns 200 — GCal retries on non-200, so error path must also return 200"

requirements-completed: [GCAL-01, GCAL-02, GCAL-03, GCAL-04, SYNC-03, SYNC-04]

# Metrics
duration: 8min
completed: 2026-03-20
---

# Phase 6 Plan 03: Google Calendar Sync Summary

**GCal sync pipeline: token-refresh auth, 7-day event fetch with declined/transparent filtering, push webhook enqueuing Celery via Redis, and auto-renewing watch channels every 6 hours via Beat**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-20T02:57:46Z
- **Completed:** 2026-03-20T03:06:19Z
- **Tasks:** 2 (both TDD + auto)
- **Files modified:** 13

## Accomplishments

- Complete GCal module (`gcal/auth`, `gcal/fetch`, `gcal/db`, `gcal/watch`) with 31 tests across 3 test files
- `gcal_sync_user` Celery task chains fetch → store → ingest_canonical_event → detect_conflicts stub — full pipeline live
- Push webhook at `/api/gcal/webhook` returns 200 immediately and enqueues sync via Redis LPUSH (same pattern as SMS webhook)
- Watch channel auto-renews: Beat runs every 6 hours, renews any channel expiring within 48 hours
- UNIQUE constraint added to `calendar_events(user_id, google_event_id)` — required for idempotent upsert

## Task Commits

Each task was committed atomically:

1. **Task 1: GCal Auth + Fetch + DB Modules** - `46ba6e3` (feat + TDD)
2. **Task 2: GCal Watch + Webhook Route + Celery Tasks + Beat Renewal** - `61cb09b` (feat)

**Plan metadata:** (docs commit below)

_Note: Task 1 used TDD — tests written first, implementation made them pass._

## Files Created/Modified

- `celery_worker/gcal/auth.py` — build_gcal_service() with 5-minute auto-refresh using google.oauth2.credentials.Credentials
- `celery_worker/gcal/fetch.py` — fetch_gcal_events() for 7-day window, filters declined/transparent, infers type from title
- `celery_worker/gcal/db.py` — calendar_events CRUD (store/get) + watch channel state (store/get) in integrations
- `celery_worker/gcal/watch.py` — establish_watch(), stop_watch(), renew_watch() lifecycle management
- `celery_worker/tests/gcal/test_fetch.py` — 9 tests: normalization, filtering, type inference
- `celery_worker/tests/gcal/test_db.py` — 8 tests: upsert, range query, watch channel read/write
- `celery_worker/tests/gcal/test_watch.py` — 7 tests: establish, stop, renew (including stop failure grace)
- `celery_worker/tasks.py` — gcal_sync_all, gcal_sync_user, detect_conflicts_user (stub), renew_watch_channels
- `celery_worker/celery_app.py` — renew-watch-channels Beat entry (crontab hour="*/6")
- `src/app/api/gcal/webhook/route.ts` — POST handler for GCal push notifications, enqueues via Redis
- `supabase/migrations/006_google_integrations.sql` — UNIQUE(user_id, google_event_id) on calendar_events

## Decisions Made

- **Patch at source module for lazy imports:** `gcal.fetch.build_gcal_service` doesn't exist as an attribute because it's imported inside the function body. Must patch `gcal.auth.build_gcal_service`. Same applies to `ai.db._get_supabase` — patch there, not at `gcal.db._get_supabase`.
- **X-Goog-Channel-Token = user_id:** During `establish_watch()`, the body.token is set to user_id. GCal echoes this back in `X-Goog-Channel-Token` on every push. This enables stateless push routing (webhook knows which user to sync) without a channel_id → user_id DB lookup.
- **detect_conflicts_user as stub:** `gcal_sync_user` chains to `detect_conflicts_user` immediately. Rather than conditional chaining, a stub task is registered now so the call always works. Plan 05 replaces the stub.
- **48h renewal window with 6h Beat interval:** Beat checks every 6 hours, renews anything expiring within 48 hours. 48h / 6h = 8 chances to renew before expiry — robust against transient failures.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added UNIQUE constraint on calendar_events**
- **Found during:** Task 1 (store_calendar_events DB module)
- **Issue:** `store_calendar_events` uses `ON CONFLICT(user_id, google_event_id)` for idempotent upsert, but `001_initial_schema.sql` has no unique constraint on `calendar_events(user_id, google_event_id)` — upsert would fail at runtime
- **Fix:** Added `ALTER TABLE public.calendar_events ADD CONSTRAINT IF NOT EXISTS calendar_events_user_event_unique UNIQUE (user_id, google_event_id);` to migration 006
- **Files modified:** `supabase/migrations/006_google_integrations.sql`
- **Verification:** Constraint present in migration file; db.py test suite passes
- **Committed in:** `46ba6e3` (Task 1 commit)

**2. [Rule 3 - Blocking] Installed google-api-python-client for test environment**
- **Found during:** Task 1 TDD RED/GREEN verification
- **Issue:** `google.oauth2.credentials` not importable — google libraries not installed in the test Python environment (Windows dev machine)
- **Fix:** `pip install google-api-python-client google-auth google-auth-httplib2` (libraries already in `requirements.txt`, just not installed locally)
- **Files modified:** None (library was already in requirements.txt)
- **Verification:** Tests pass after install; requirements.txt already correct
- **Committed in:** N/A (environment install, no code change)

---

**Total deviations:** 2 auto-fixed (1 missing critical schema, 1 blocking environment)
**Impact on plan:** Both necessary for correctness. Unique constraint is required for the upsert to work at all in production. No scope creep.

## Issues Encountered

- Mock patch target for lazy imports required switching from `gcal.fetch.build_gcal_service` to `gcal.auth.build_gcal_service` — Python's `@patch` decorator resolves the attribute at decoration time, but lazy imports inside function bodies mean the attribute only exists on the source module (`gcal.auth`), not on the caller (`gcal.fetch`). Fixed by pre-importing modules and patching at the source.

## User Setup Required

None — no external service configuration required for this plan. Watch channels require `APP_BASE_URL` environment variable to be set (pointing to the deployed Next.js app URL) before `establish_watch()` is called in production.

## Next Phase Readiness

- GCal sync pipeline is complete and tested: push → webhook → Redis → Celery → DB → canonical_events
- Plan 04 (Gmail sync) can use `gcal.auth.build_gcal_service` as the pattern for `gmail.auth`
- Plan 05 (conflict detection) will implement `detect_conflicts_user` to replace the stub
- `APP_BASE_URL` env var must be added to Railway Railway worker environment for `establish_watch()` to construct the correct webhook address

---
*Phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection*
*Completed: 2026-03-20*
