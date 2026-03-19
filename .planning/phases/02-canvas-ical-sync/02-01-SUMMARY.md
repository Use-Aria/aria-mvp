---
phase: 02-canvas-ical-sync
plan: 01
subsystem: testing
tags: [python, pytest, icalendar, canvas, tdd, celery]

# Dependency graph
requires:
  - phase: 01-infrastructure-foundation
    provides: celery_worker Docker container foundation, requirements.txt baseline
provides:
  - canvas/fetch.py: fetch_ical() HTTP GET with raise_for_status for rate-limit retry
  - canvas/parse.py: parse_vevents() with UTC normalization for DATE and DATETIME+TZID
  - canvas/diff.py: compute_diff() with due_date-only change sensitivity
  - pytest infrastructure: requirements-dev.txt, pytest.ini, tests/canvas/ package
affects:
  - 02-02-PLAN.md (Celery task wiring — imports canvas.fetch, canvas.parse, canvas.diff)
  - Phase 5 (briefing generation reads deadlines written by these modules)

# Tech tracking
tech-stack:
  added:
    - icalendar==6.3.2 (RFC 5545 iCal parsing with zoneinfo timezone support)
    - requests>=2.32.0 (HTTP fetch for Canvas iCal URL)
    - pytest>=8.0.0 (test framework)
    - pytest-mock>=3.12.0 (mocking support)
    - requests-mock>=1.12.0 (HTTP mock for fetch tests)
  patterns:
    - TDD Red-Green: write all failing tests first, then implement to pass
    - UTC normalization at parse time (never store local datetimes)
    - due_date-only diff sensitivity (title changes silently ignored)
    - raise_for_status() pattern for HTTPError-based Celery retry trigger

key-files:
  created:
    - celery_worker/canvas/__init__.py
    - celery_worker/canvas/fetch.py
    - celery_worker/canvas/parse.py
    - celery_worker/canvas/diff.py
    - celery_worker/requirements-dev.txt
    - celery_worker/pytest.ini
    - celery_worker/tests/__init__.py
    - celery_worker/tests/canvas/__init__.py
    - celery_worker/tests/canvas/test_parse.py
    - celery_worker/tests/canvas/test_diff.py
    - celery_worker/tests/canvas/test_fetch.py
  modified:
    - celery_worker/requirements.txt (added icalendar==6.3.2, requests>=2.32.0)

key-decisions:
  - "icalendar==6.3.2 chosen over 7.0.3 (released 2026-03-03, too new) and ics.py (weaker TZID handling)"
  - "All-day DATE events normalized to 23:59:59Z (end-of-day UTC) not midnight — avoids false overdue status for day-of-deadline events"
  - "diff sensitivity: only due_date changes trigger changed entries; title-only changes silently pass through"

patterns-established:
  - "Pattern: iCal DTSTART isinstance check — dt.date AND NOT dt.datetime guards all-day branch before .astimezone() call"
  - "Pattern: canvas_uid as stable diff key — always scoped with user_id in DB queries (not globally unique)"
  - "Pattern: raise_for_status() immediately after requests.get() — enables Celery autoretry_for=(requests.HTTPError,)"

requirements-completed: [CANV-01, CANV-04, CANV-05]

# Metrics
duration: 7min
completed: 2026-03-19
---

# Phase 02 Plan 01: Canvas iCal Parse, Diff, and Fetch — TDD Summary

**Three pure-Python Canvas iCal modules (fetch/parse/diff) with full pytest coverage: RFC 5545 DTSTART normalization to UTC, due_date-only diff semantics, and raise_for_status() for Celery retry on HTTP 429**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-03-19T03:15:22Z
- **Completed:** 2026-03-19T03:22:09Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 12

## Accomplishments

- Pytest infrastructure established for celery_worker with requirements-dev.txt, pytest.ini, and test package structure
- parse_vevents() correctly handles both Canvas DTSTART formats: `DTSTART;TZID=America/New_York` (converts via astimezone) and `DTSTART;VALUE=DATE` (combines to 23:59:59Z end-of-day UTC)
- compute_diff() implements due_date-only change sensitivity — title-only changes are silently ignored per project decision
- fetch_ical() calls raise_for_status() enabling Celery's autoretry_for=(requests.HTTPError,) to fire on HTTP 429/5xx
- All 14 tests pass (5 parse + 5 diff + 4 fetch)

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — Create test infrastructure and failing tests** - `72670c2` (test)
2. **Task 2: GREEN — Implement fetch.py, parse.py, diff.py** - `6f79558` (feat)

**Plan metadata:** (docs commit below)

_Note: TDD plan — test commit followed by implementation commit_

## Files Created/Modified

- `celery_worker/canvas/fetch.py` - HTTP GET with raise_for_status(); CANV-05 fetch layer
- `celery_worker/canvas/parse.py` - iCal VEVENT parsing; UTC normalization for DATE and DATETIME+TZID; CANV-01
- `celery_worker/canvas/diff.py` - compute_diff() with due_date-only sensitivity; CANV-04
- `celery_worker/canvas/__init__.py` - Package stub
- `celery_worker/requirements.txt` - Added icalendar==6.3.2 and requests>=2.32.0
- `celery_worker/requirements-dev.txt` - pytest, pytest-mock, requests-mock for test environment
- `celery_worker/pytest.ini` - testpaths=tests, python_files=test_*.py
- `celery_worker/tests/__init__.py` - Test package init
- `celery_worker/tests/canvas/__init__.py` - Canvas test sub-package init
- `celery_worker/tests/canvas/test_parse.py` - 5 tests: CANV-01 coverage
- `celery_worker/tests/canvas/test_diff.py` - 5 tests: CANV-04 coverage
- `celery_worker/tests/canvas/test_fetch.py` - 4 tests: CANV-05 coverage

## Decisions Made

- icalendar==6.3.2 chosen (not 7.0.3 released 2026-03-03 — too new for MVP; not ics.py — weaker TZID handling)
- All-day DATE events → 23:59:59Z (not midnight UTC) to avoid false overdue classification on the due date itself
- Due_date-only diff sensitivity: title changes are canvas-side edits that don't affect student deadlines

## Deviations from Plan

None - plan executed exactly as written. Test infrastructure files already existed in the working tree (uncommitted from prior session), were verified correct, and committed in Task 1.

## Issues Encountered

None. The test infrastructure files (requirements-dev.txt, pytest.ini, tests/ directory) were already present as untracked files from a prior context-gathering session. They matched the plan specification exactly so no changes were needed — they were staged and committed as Task 1.

## User Setup Required

None - no external service configuration required. These modules have zero infrastructure dependencies.

## Next Phase Readiness

- canvas/fetch.py, canvas/parse.py, canvas/diff.py are ready for Plan 02-02 Celery task wiring
- Plan 02-02 will import these modules in tasks.canvas_sync_user and wire into Supabase reads/writes
- Supabase migration 002 (soft-delete + unique constraint on canvas_uid,user_id) must run before 02-02 integration tests

---
*Phase: 02-canvas-ical-sync*
*Completed: 2026-03-19*

## Self-Check: PASSED

- All 12 files exist on disk
- Commits 72670c2 (RED) and 6f79558 (GREEN) verified in git log
- All 14 tests pass: `python -m pytest tests/ -v` exits 0
