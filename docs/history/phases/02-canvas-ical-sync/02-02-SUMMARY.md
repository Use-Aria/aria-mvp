---
phase: 02-canvas-ical-sync
plan: 02
subsystem: database, infra
tags: [celery, celery-beat, supabase, supabase-py, redis, docker-compose, nextjs-api, soft-delete, background-jobs]

# Dependency graph
requires:
  - phase: 02-01
    provides: fetch_ical, parse_vevents, compute_diff — the three canvas pipeline modules this plan wires together

provides:
  - Supabase DB layer (canvas/db.py) for deadline upsert, soft-delete, and synced_at tracking
  - Migration 002 adding deleted_at column, unique constraint (canvas_uid, user_id), and active-deadlines index
  - Celery tasks: canvas_sync_all fan-out orchestrator + canvas_sync_user per-user pipeline with exponential backoff
  - Celery Beat schedule: canvas_sync_all dispatched every 3600s (60 minutes)
  - Docker Compose celery_beat service with ephemeral schedule file
  - Next.js POST /api/sync/canvas manual trigger route (thin, no iCal/DB logic)

affects: [03-gmail-integration, 05-daily-briefing, 07-frontend-ui]

# Tech tracking
tech-stack:
  added: [supabase-py>=2.0.0 (already in requirements), requests (already present)]
  patterns: [Celery fan-out pattern (sync_all dispatches per-user tasks), soft-delete with deleted_at, supabase-py upsert on_conflict, Beat schedule in celery_app.conf.update()]

key-files:
  created:
    - supabase/migrations/002_deadlines_soft_delete.sql
    - celery_worker/canvas/db.py
    - celery_worker/tests/canvas/test_db.py
    - celery_worker/tests/test_celery_app.py
    - src/app/api/sync/canvas/route.ts
  modified:
    - celery_worker/celery_app.py
    - celery_worker/tasks.py
    - docker-compose.yml

key-decisions:
  - "celery_beat uses --schedule=/tmp/celerybeat-schedule to keep schedule file out of source tree (not committed)"
  - "canvas_sync_user defers all DB imports to function body to avoid import-time Supabase env var requirement"
  - "mark_synced is the last call in canvas_sync_user — synced_at only written after apply_diff succeeds"
  - "celery_beat service does NOT need SUPABASE_URL — it only dispatches tasks, workers execute them"
  - "Next.js trigger route is a stub (202 response) — full Redis publish wired in Phase 7 when UI needs on-demand sync"

patterns-established:
  - "Fan-out pattern: sync_all queries all users, dispatches per-user tasks via .delay() for independent failure isolation"
  - "Soft-delete over hard-delete: deleted_at=NULL means active, non-NULL means removed from Canvas feed"
  - "upsert with on_conflict='canvas_uid,user_id' is the canonical write pattern for Canvas deadlines"
  - "Service role key (SUPABASE_SERVICE_ROLE_KEY) used in Celery worker to bypass RLS on server-side writes"

requirements-completed: [CANV-02, CANV-03]

# Metrics
duration: 6min
completed: 2026-03-19
---

# Phase 02 Plan 02: Canvas Sync Pipeline Wiring Summary

**Celery Beat dispatching canvas_sync_all every 60 min, wiring fetch/parse/diff modules into Supabase via upsert + soft-delete, with Docker Compose beat service and thin Next.js manual trigger**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-19T03:30:27Z
- **Completed:** 2026-03-19T03:36:27Z
- **Tasks:** 2 of 2
- **Files modified:** 8

## Accomplishments

- Supabase DB layer (canvas/db.py) with 4 functions: get_all_canvas_integrations, load_current_deadlines, apply_diff (upsert + soft-delete), mark_synced — all using SUPABASE_SERVICE_ROLE_KEY to bypass RLS
- Complete Canvas sync pipeline: canvas_sync_user calls fetch_ical → parse_vevents → compute_diff → apply_diff → mark_synced, with autoretry on HTTPError (backoff=2, max_retries=5)
- Celery Beat schedule in celery_app.py dispatching canvas_sync_all every 3600s, Docker Compose celery_beat service added
- Migration 002 adds deleted_at column, idx_deadlines_active partial index, and UNIQUE(canvas_uid, user_id) constraint needed for upsert
- 22 Python tests passing (5 new DB tests + 3 beat schedule tests + 14 from Plan 01)

## Task Commits

Each task was committed atomically:

1. **Task 1: soft-delete migration, db.py, and DB/beat tests** - `578ac04` (feat)
2. **Task 2: Celery tasks, Beat schedule, docker-compose beat service, trigger route** - `fb10679` (feat)

**Plan metadata:** (pending — docs commit)

## Files Created/Modified

- `supabase/migrations/002_deadlines_soft_delete.sql` - Adds deleted_at, idx_deadlines_active, UNIQUE(canvas_uid, user_id)
- `celery_worker/canvas/db.py` - Supabase CRUD: get_all_canvas_integrations, load_current_deadlines, apply_diff, mark_synced
- `celery_worker/tests/canvas/test_db.py` - 5 unit tests mocking _get_supabase, verifying all DB operations
- `celery_worker/tests/test_celery_app.py` - 3 tests verifying beat_schedule exists, 3600s interval, correct task name
- `celery_worker/celery_app.py` - Added beat_schedule block with canvas-sync-all-users entry
- `celery_worker/tasks.py` - Added canvas_sync_all (fan-out) and canvas_sync_user (pipeline with retry)
- `docker-compose.yml` - Added celery_beat service with --schedule=/tmp/celerybeat-schedule
- `src/app/api/sync/canvas/route.ts` - Thin POST trigger returning 202, zero DB/iCal logic

## Decisions Made

- Beat schedule file written to `/tmp/celerybeat-schedule` — keeps generated binary out of source tree and avoids volume permission issues
- celery_beat service has no SUPABASE_URL — Beat only dispatches, workers execute; cleaner separation of concerns
- Next.js route is a stub for now — full Redis publish deferred to Phase 7 when on-demand sync is needed from the UI

## Deviations from Plan

None — plan executed exactly as written. The `.gitignore` already contained all required entries (`__pycache__/`, `*.pyc`, `celerybeat-schedule`, `celerybeat.pid`) from Phase 01, so the append step was a no-op.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. Supabase migration (002_deadlines_soft_delete.sql) must be applied before the worker runs live, but this is part of the standard deployment flow.

## Next Phase Readiness

- Canvas sync pipeline is end-to-end complete: iCal fetch → parse → diff → DB write → synced_at, running every 60 minutes via Beat
- Phase 03 (Gmail integration) can begin — auth pattern (OAuth tokens in integrations table) is established
- To test with a real Canvas iCal URL: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + REDIS_URL, run `docker compose up`, insert a row into integrations with platform='canvas' and a valid ical_url

---
*Phase: 02-canvas-ical-sync*
*Completed: 2026-03-19*
