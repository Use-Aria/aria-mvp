---
phase: 09-todoist-integration
plan: 01
subsystem: api
tags: [todoist, celery, celery-beat, supabase, priority-engine, tdd]

# Dependency graph
requires:
  - phase: 05-priority-engine-canonical-timeline-db
    provides: ingest_canonical_event() entry point for canonical_events writes
  - phase: 02-canvas-ical-sync
    provides: canvas fan-out task pattern (canvas_sync_all/canvas_sync_user) mirrored for Todoist

provides:
  - Todoist REST API v2 fetch layer (get_active_tasks, create, close, update, delete)
  - Task normalization with due datetime/date-only handling and priority inversion
  - Supabase helpers for Todoist integration management (get token, mark synced, mark revoked)
  - Sync orchestrator wiring fetch->parse->ingest with 403 revocation guard
  - Celery fan-out tasks: todoist_sync_all and todoist_sync_user
  - Celery Beat schedule entry running todoist_sync_all every 2 hours
  - 20 tests across 4 test files covering all modules

affects:
  - 09-02 (Todoist webhook routes — uses fetch.py write functions)
  - 09-03 (Todoist onboarding UI — depends on sync running)
  - briefing generation (canonical_events now includes Todoist tasks automatically)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Todoist priority inversion: API value 4=urgent, 1=normal (opposite of intuitive ordering)"
    - "Token security: access_token fetched inside task body from Supabase, never passed through Redis as Celery arg"
    - "403 revocation: caught in sync orchestrator, returns gracefully (no raise), so Celery autoretry_for=(Exception,) does not re-queue permanently revoked tokens"
    - "Date-only normalization: due.date without datetime key appended with T23:59:59Z to match Canvas all-day event convention"
    - "Module-level _get_supabase wrapper in todoist/db.py delegates to ai.db._get_supabase via lazy import, enabling test patching at todoist.db._get_supabase"

key-files:
  created:
    - celery_worker/todoist/__init__.py
    - celery_worker/todoist/fetch.py
    - celery_worker/todoist/parse.py
    - celery_worker/todoist/db.py
    - celery_worker/todoist/sync.py
    - celery_worker/tests/todoist/__init__.py
    - celery_worker/tests/todoist/test_fetch.py
    - celery_worker/tests/todoist/test_parse.py
    - celery_worker/tests/todoist/test_db.py
    - celery_worker/tests/todoist/test_sync.py
  modified:
    - celery_worker/tasks.py
    - celery_worker/celery_app.py

key-decisions:
  - "todoist/db.py wraps ai.db._get_supabase via local proxy function (not top-level import) — avoids module-level supabase import failure in test environments without supabase package installed"
  - "test_sync.py injects a stub priority.ingest module into sys.modules — priority/ingest.py uses str | None syntax (Python 3.10+) which fails at import time on the system Python 3.9 test runner"
  - "todoist_sync_user uses autoretry_for=(Exception,) (broad) rather than (requests.HTTPError,) like canvas — 403 is caught and handled in sync_todoist_user(), so the broad retry only triggers on genuine transient failures"

patterns-established:
  - "Fan-out pattern: todoist_sync_all dispatches todoist_sync_user.delay(user_id) per integration row — mirrors canvas_sync_all/canvas_sync_user exactly"
  - "Security pattern: Celery tasks never receive access_token as argument — token fetched inside task body from Supabase"

requirements-completed:
  - TASK-01
  - TASK-02

# Metrics
duration: 12min
completed: 2026-03-20
---

# Phase 9 Plan 1: Todoist Integration Backend Summary

**Todoist 4-module backend (fetch/parse/db/sync) with Celery fan-out tasks and Beat schedule ingesting tasks into canonical_events every 2 hours**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-20T14:18:09Z
- **Completed:** 2026-03-20T14:30:21Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments

- Built complete Todoist REST API v2 client with 5 functions (get_active_tasks, create, close, update, delete)
- Implemented task normalization with due datetime/date-only handling (date-only normalizes to T23:59:59Z) and priority inversion map
- Created Supabase helpers for Todoist integration lifecycle including 403 token revocation
- Wired sync orchestrator calling fetch->parse->ingest_canonical_event (source='todoist', grade_weight=0.0)
- Added todoist_sync_all/todoist_sync_user Celery tasks with fan-out pattern; Beat schedule at 7200s
- 20 passing tests across all 4 modules

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Todoist modules (fetch/parse/db) with tests first** - `37745e3` (feat)
2. **Task 2: Create sync orchestrator + Celery tasks + Beat schedule with tests** - `d977177` (feat)

_Note: TDD tasks had both test and implementation in single commits per task._

## Files Created/Modified

- `celery_worker/todoist/fetch.py` - Todoist REST API v2 calls; TODOIST_BASE constant + 5 API functions
- `celery_worker/todoist/parse.py` - Normalize raw tasks; due datetime/date-only handling, priority inversion map
- `celery_worker/todoist/db.py` - Supabase helpers: get_all_todoist_integrations, get_todoist_token, mark_synced, mark_integration_revoked
- `celery_worker/todoist/sync.py` - Sync orchestrator wiring all modules; 403 revocation without Celery retry
- `celery_worker/tasks.py` - Added todoist_sync_all and todoist_sync_user Celery tasks
- `celery_worker/celery_app.py` - Added todoist-sync-all-users Beat entry at 7200s
- `celery_worker/tests/todoist/test_fetch.py` - 7 tests for fetch module
- `celery_worker/tests/todoist/test_parse.py` - 5 tests for parse module
- `celery_worker/tests/todoist/test_db.py` - 4 tests for db module
- `celery_worker/tests/todoist/test_sync.py` - 4 tests for sync orchestrator

## Decisions Made

- `todoist/db.py` wraps `ai.db._get_supabase` via local proxy function rather than top-level import — avoids module-level supabase import failure in test environments where the supabase package is not installed in the system Python 3.9 environment
- `test_sync.py` injects a stub `priority.ingest` module into `sys.modules` rather than patching via `patch()` — `priority/ingest.py` uses `str | None` syntax (Python 3.10+) which fails at import time on the system Python 3.9 test runner used in CI
- `todoist_sync_user` uses `autoretry_for=(Exception,)` (broad) rather than the narrower `(requests.HTTPError,)` used by `canvas_sync_user` — 403 is caught and handled gracefully inside `sync_todoist_user()`, so the broad retry only triggers on genuine transient failures

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Python 3.9 compatibility for type annotations**
- **Found during:** Task 1 (todoist/db.py) and Task 2 (test_sync.py)
- **Issue:** `str | None` union type syntax requires Python 3.10+; system test runner uses Python 3.9; would cause TypeError at module import time
- **Fix:** Added `from __future__ import annotations` + `Optional[str]` in db.py; stubbed `priority.ingest` module in sys.modules in test_sync.py to bypass priority/ingest.py (which also uses `str | None`)
- **Files modified:** celery_worker/todoist/db.py, celery_worker/tests/todoist/test_sync.py
- **Verification:** All 20 tests pass under Python 3.9
- **Committed in:** 37745e3, d977177

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug, Python version compatibility)
**Impact on plan:** Required fix for test environment compatibility. Production runs Python 3.12 (Dockerfile), so no production impact.

## Issues Encountered

- `canvas/db.py` uses top-level `from supabase import create_client` which fails under system Python 3.9 (supabase package not installed). Pre-existing failure — 5 canvas/test_db.py tests have always failed in this environment. Not caused by this plan's changes.

## Next Phase Readiness

- Todoist data pipeline complete: tasks flow into canonical_events automatically every 2 hours
- Plan 09-02 (webhook routes) can use fetch.py create/close/update/delete functions directly
- Plan 09-03 (onboarding UI) can connect Todoist OAuth and have the Beat schedule pick up the integration automatically
- Briefing generation immediately picks up Todoist tasks via canonical_events with zero changes to briefing code

---
*Phase: 09-todoist-integration*
*Completed: 2026-03-20*
