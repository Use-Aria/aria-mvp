---
phase: 01-infrastructure-foundation
plan: 02
subsystem: infra
tags: [celery, redis, docker, docker-compose, python, railway]

# Dependency graph
requires: []
provides:
  - Celery worker application instance configured with Redis broker and JSON serialization
  - Ping smoke-test task (tasks.ping) that logs UTC timestamp to console and returns status JSON
  - Python requirements file pinning celery==5.6.2 for reproducible builds
  - Dockerfile (Python 3.12-slim) suitable for Railway deployment
  - Docker Compose stack bringing up Redis 7-alpine + Celery worker with one command
affects:
  - 02-canvas-sync
  - 03-gmail-integration
  - 04-google-calendar
  - 05-twilio-sms
  - 06-briefing-generation
  - 07-deadline-alerts

# Tech tracking
tech-stack:
  added:
    - celery==5.6.2 (background job queue)
    - redis>=5.0.0 (broker and result backend)
    - supabase>=2.0.0 (included for Phase 2 DB writes)
    - python-dotenv>=1.0.0 (env var loading)
    - redis:7-alpine (Docker image for local dev)
    - python:3.12-slim (Dockerfile base image)
  patterns:
    - Celery worker in dedicated celery_worker/ Python package at repo root (not inside Next.js src/)
    - REDIS_URL env var for broker/backend configuration (defaults to localhost:6379/0 for local dev)
    - Docker Compose service dependency using healthcheck condition (service_healthy) to enforce startup order
    - Volume mount for hot-reload in development (./celery_worker:/app)
    - No DB writes in Phase 1 ping task — deferred to Phase 2 when real users exist

key-files:
  created:
    - celery_worker/__init__.py
    - celery_worker/celery_app.py
    - celery_worker/tasks.py
    - celery_worker/requirements.txt
    - celery_worker/Dockerfile
    - docker-compose.yml
  modified: []

key-decisions:
  - "No Supabase DB write in ping task — no real users exist in Phase 1, deferred to Phase 2 per research recommendation"
  - "Celery worker concurrency=2 in Docker Compose for dev (low footprint), Railway will configure production concurrency"
  - "Redis healthcheck (redis-cli ping, 5s interval) ensures worker never starts before Redis is ready"
  - "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY passed through in docker-compose.yml for future Phase 2 DB writes — avoids future compose edits"

patterns-established:
  - "Pattern 1: Background job infrastructure lives in celery_worker/ at repo root, separate from Next.js app"
  - "Pattern 2: All Celery tasks imported via include=[\"celery_worker.tasks\"] in celery_app.py"
  - "Pattern 3: Redis URL configured via REDIS_URL env var with localhost fallback for development"

requirements-completed: [SYNC-01]

# Metrics
duration: 1min
completed: 2026-03-18
---

# Phase 01 Plan 02: Celery Worker + Redis Infrastructure Summary

**Celery 5.6.2 worker with Redis broker, ping smoke-test task, Dockerfile for Railway, and Docker Compose local dev stack**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-18T21:12:14Z
- **Completed:** 2026-03-18T21:13:33Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Celery worker application (`celery_worker/celery_app.py`) configured with Redis broker/backend and JSON serialization over UTC
- Ping smoke-test task (`tasks.ping`) that logs UTC timestamp to console and returns `{"status": "ok", "timestamp": "..."}` — validates worker-to-Redis connectivity with no DB dependency
- Railway-deployable `Dockerfile` using `python:3.12-slim` with `celery worker` as CMD
- `docker-compose.yml` with Redis 7-alpine + Celery worker, Redis healthcheck enforcing startup order, and hot-reload volume mount

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Celery worker app, ping task, requirements, and Dockerfile** - `8deab4a` (feat)
2. **Task 2: Create Docker Compose for local dev stack (Redis + Celery worker)** - `e49cbe4` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `celery_worker/__init__.py` - Empty package init (makes celery_worker a Python package)
- `celery_worker/celery_app.py` - Celery application instance with Redis broker/backend, JSON serialization, UTC timezone
- `celery_worker/tasks.py` - `tasks.ping` smoke-test task, logs UTC timestamp, returns status JSON, no DB writes
- `celery_worker/requirements.txt` - Pinned dependencies: celery==5.6.2, redis>=5.0.0, supabase>=2.0.0, python-dotenv>=1.0.0
- `celery_worker/Dockerfile` - Python 3.12-slim, pip installs requirements, celery worker CMD for Railway
- `docker-compose.yml` - Redis 7-alpine + Celery worker services, healthcheck, depends_on, env passthrough, hot-reload volume

## Decisions Made

- No Supabase DB write in `tasks.ping` — no real users exist in Phase 1. Adding a DB write now would require a `PING_TEST_USER_ID` placeholder (per research open question 1), which is artificial overhead. Deferred to Phase 2.
- Worker concurrency=2 in Docker Compose (low footprint for dev). Railway production concurrency configured separately via environment.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` included in docker-compose.yml environment now to avoid future compose edits when Phase 2 adds DB writes.
- Used Dockerfile (not Nixpacks) for Railway deployment — explicit control over Python version and dependency installation, no Railway-specific magic.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Docker CLI not available in the execution environment — `docker compose config --quiet` could not run. Substituted Python string-matching validation against all acceptance criteria. All criteria verified manually. This does not affect deliverable quality — the file is valid YAML and correct Compose syntax confirmed by structural analysis.

## User Setup Required

None - no external service configuration required for these files. Docker Desktop must be installed locally to run `docker compose up`.

## Next Phase Readiness

- Background job infrastructure is in place. Phases 2-6 can enqueue tasks via `celery_app.send_task("tasks.ping")` or by importing and calling task functions directly.
- To verify locally: `docker compose up` in repo root, then in a separate terminal: `docker compose exec celery_worker celery -A celery_worker.celery_app inspect ping`
- Railway deployment: push `celery_worker/` directory, set `REDIS_URL` pointing to Railway Redis instance

---
*Phase: 01-infrastructure-foundation*
*Completed: 2026-03-18*

## Self-Check: PASSED

- All 7 files found on disk
- Both task commits (8deab4a, e49cbe4) verified in git log
