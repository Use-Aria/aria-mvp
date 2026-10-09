---
phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection
plan: "05"
subsystem: gcal-intelligence
tags: [conflict-detection, study-blocks, gcal-writeback, monday-briefing, ai-enrichment]
dependency_graph:
  requires: ["06-02", "06-03"]
  provides: ["conflict-detection", "study-block-writeback", "monday-briefing-enrichment"]
  affects: ["briefing-generation", "sms-alerts", "canvas-sync"]
tech_stack:
  added: ["gcal.conflicts", "gcal.slots", "gcal.writeback", "ai.briefing.get_briefing_gcal_context"]
  patterns:
    - "TDD red-green for all new modules"
    - "Lazy imports inside functions to avoid circular dependencies (tasks.py <-> gcal.conflicts)"
    - "Deduplication via DB UNIQUE constraint + Python set check"
    - "Cross-platform strftime: .lstrip('0').lower() instead of %-I"
key_files:
  created:
    - celery_worker/gcal/conflicts.py
    - celery_worker/gcal/slots.py
    - celery_worker/gcal/writeback.py
    - celery_worker/tests/gcal/test_conflicts.py
    - celery_worker/tests/gcal/test_slots.py
    - celery_worker/tests/gcal/test_writeback.py
    - celery_worker/tests/ai/test_briefing_gcal.py
  modified:
    - celery_worker/ai/briefing.py
    - celery_worker/tasks.py
    - celery_worker/tests/test_tasks_ai.py
decisions:
  - "Patch ai.db._get_supabase (not gcal.conflicts._get_supabase) in conflict tests — lazy import means the attribute only exists on the source module"
  - "Patch sms.batch.enqueue_alert (not gcal.conflicts.enqueue_alert) — same lazy import pattern"
  - "March 2026 dates use EDT (-04:00) not EST (-05:00) — DST active; test helper updated to use -04:00 offset"
  - "gcal_context enrichment gated by is_monday in generate_briefing — avoids cluttering daily briefings"
  - "canvas_sync_user tests patched tasks.detect_conflicts_user to prevent Redis connection attempt in test env"
metrics:
  duration_minutes: 10
  completed_date: "2026-03-20"
  tasks_completed: 2
  files_modified: 10
---

# Phase 06 Plan 05: Conflict Detection + Study Block Writeback + Monday Briefing Enrichment Summary

**One-liner:** Conflict detection fires deduped SMS alerts when Canvas deadlines overlap GCal busy events; study blocks written to GCal via events().insert(); Monday briefings enriched with conflict warnings and top-3 study windows from deterministic calendar analysis.

## What Was Built

### Task 1: Conflict Detection + Free Slot Finder

**`celery_worker/gcal/conflicts.py`** — `detect_conflicts_user(user_id)`:
- Fetches active Canvas deadlines and GCal events from Supabase
- Matches by calendar day (`due_date[:10] == start_time[:10]`)
- Deduplicates via `conflict_alerts` table: key is `(deadline_id, gcal_event_id, deadline_due_at)` — re-fires when deadline date changes
- Builds actionable SMS: "Heads up: {title} is due {day}, and you have {event} ({duration}) that day. Want me to add a study block the day before?"
- Routes through batch queue (`enqueue_alert` + `flush_sms_batch.apply_async`, priority_score=75)

**`celery_worker/gcal/slots.py`** — `find_free_slots(events, date, min_duration_hours, study_preference, user_tz)`:
- Clips events to waking hours (7am-10pm) in user's timezone
- Computes gaps via cursor-based sweep
- Excludes gaps shorter than `min_duration_hours`
- Sorts results by `PREFERENCE_ORDER[study_preference]` — morning/afternoon/evening windows

**`celery_worker/tasks.py`** changes:
- `detect_conflicts_user` stub replaced with real implementation (calls `gcal.conflicts.detect_conflicts_user`)
- `canvas_sync_user` now calls `detect_conflicts_user.delay(user_id)` after the ingest loop

### Task 2: Study Block Write-Back + Monday Briefing Enrichment

**`celery_worker/gcal/writeback.py`**:
- `create_study_block(user_id, title, start_dt, end_dt) -> str` — creates event via `events().insert()`, returns event ID
- `delete_study_block(user_id, event_id) -> bool` — deletes via `events().delete()`, returns True/False
- `schedule_study_block(user_id, title, duration_hours, target_date, study_preference, user_tz) -> dict | None` — orchestrates `get_calendar_events` + `find_free_slots` + `create_study_block`

**`celery_worker/ai/briefing.py`** additions:
- `get_briefing_gcal_context(user_id) -> dict` — checks Google integration, fetches active conflict_alerts for week, fetches calendar_events, runs `find_free_slots` across 7 days, returns `{conflicts: list[str], study_windows: list[str][:3]}`
- `generate_briefing` accepts new `gcal_context: dict | None = None` parameter — when provided and `is_monday=True`, appends "SCHEDULING CONFLICTS THIS WEEK:" and "BEST AVAILABLE STUDY WINDOWS:" sections to Claude prompt

**`celery_worker/tasks.py`** changes:
- `generate_daily_briefing_user` on Mondays: calls `get_briefing_gcal_context(user_id)`, passes `gcal_context` to `generate_briefing`

## Test Coverage

| File | Tests | What's covered |
|------|-------|----------------|
| test_conflicts.py | 8 | Same-day fire, different-day skip, dedup, re-fire on date change, SMS body format, no-op cases |
| test_slots.py | 8 | No events (full day), partial events (gaps), fully booked, min_duration filter, morning/evening preference ordering |
| test_writeback.py | 7 | events().insert(), events().delete(), schedule returns dict, schedule returns None, study_preference pass-through |
| test_briefing_gcal.py | 6 | No integration returns empty, conflict strings, study window cap at 3, SCHEDULING CONFLICTS in prompt, BEST STUDY WINDOWS in prompt, non-Monday skips gcal_context |

**Total: 220 tests pass** (up from 213)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Lazy import patching in conflict tests**
- **Found during:** Task 1 RED phase
- **Issue:** Plan specified `@patch("gcal.conflicts._get_supabase")` and `@patch("gcal.conflicts.enqueue_alert")` but both are imported lazily inside the function body, so the attribute doesn't exist at module level
- **Fix:** Changed patches to `@patch("ai.db._get_supabase")` and `@patch("sms.batch.enqueue_alert")` — patch the source modules
- **Files modified:** `tests/gcal/test_conflicts.py`

**2. [Rule 1 - Bug] Wrong UTC offset in test helpers**
- **Found during:** Task 1 GREEN phase (test_min_duration_filters_short_gaps failed)
- **Issue:** Test helper used `-05:00` (EST) for March 2026 events, but March 23, 2026 is in EDT (-04:00, DST active)
- **Fix:** Updated `_make_event` helper to use `-04:00` offset
- **Files modified:** `tests/gcal/test_slots.py`

**3. [Rule 1 - Bug] canvas_sync_user tests failing due to new detect_conflicts_user.delay call**
- **Found during:** Task 2 full suite run
- **Issue:** Adding `detect_conflicts_user.delay(user_id)` to `canvas_sync_user` caused two existing tests to attempt a real Redis connection (no Redis in test env), causing `RuntimeError: Retry limit exceeded`
- **Fix:** Added `patch("tasks.detect_conflicts_user")` to both `canvas_sync_user` tests
- **Files modified:** `tests/test_tasks_ai.py`
- **Commit:** f2d8f86

**4. [Rule 2 - Cross-platform] strftime("%-I") not supported on Windows**
- **Found during:** Task 2 implementation review (plan note)
- **Issue:** Plan noted `%-I` doesn't work on Windows. Used `%I%p").lstrip("0").lower()` instead
- **Fix:** Used cross-platform approach in `get_briefing_gcal_context`
- **Files modified:** `celery_worker/ai/briefing.py`

## Self-Check: PASSED

All required files exist:
- FOUND: celery_worker/gcal/conflicts.py
- FOUND: celery_worker/gcal/slots.py
- FOUND: celery_worker/gcal/writeback.py
- FOUND: celery_worker/ai/briefing.py (updated)
- FOUND: celery_worker/tasks.py (updated)

Commits verified:
- 0b4fc6d: feat(06-05): conflict detection + free slot finder
- f2d8f86: feat(06-05): study block writeback + Monday briefing enrichment

220 tests pass (full suite).
