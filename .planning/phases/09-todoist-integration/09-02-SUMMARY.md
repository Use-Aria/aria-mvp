---
phase: 09-todoist-integration
plan: 02
subsystem: ai-sms
tags: [todoist, sms, intent-classification, briefing, overload-detection, tdd]
dependency_graph:
  requires: ["09-01"]
  provides: ["todoist-sms-crud", "overload-detection"]
  affects: ["celery_worker/ai/replies.py", "celery_worker/ai/briefing.py"]
tech_stack:
  added: []
  patterns: ["intent-classifier extension", "lazy-import-for-testability", "from __future__ import annotations for Python 3.9 compat"]
key_files:
  created: []
  modified:
    - celery_worker/ai/replies.py
    - celery_worker/tests/ai/test_replies.py
    - celery_worker/ai/briefing.py
    - celery_worker/tests/ai/test_briefing.py
decisions:
  - "Lazy imports for todoist.db/fetch inside _apply_todoist_mutation — module-level imports prevent test mocking at todoist.* patch paths"
  - "from __future__ import annotations added to replies.py and briefing.py — system Python 3.9 test runner cannot parse str|None union syntax at runtime"
  - "Existing generate_briefing tests updated to mock _count_items_due_today returning (0, []) — new overload detection would fail on missing SUPABASE_URL env var"
metrics:
  duration: 18m
  completed_date: "2026-03-20"
  tasks_completed: 2
  files_modified: 4
---

# Phase 9 Plan 2: Todoist SMS CRUD + Overload Detection Summary

Extended the SMS reply handler with 4 Todoist CRUD actions via Claude intent classification, and added 24h task overload detection that prepends a "Heavy day" warning to morning briefings.

## Tasks Completed

### Task 1: Extend handle_reply() with Todoist CRUD intent + actions
**Commit:** 286ec23

Extended `INTENT_SYSTEM_PROMPT` with 4 new action variants and a `due_string` field. Added `_apply_todoist_mutation()` that resolves Todoist task IDs by matching against live `get_active_tasks()` results. Hooked the new actions into `handle_reply()` between the existing mutation block and the off-topic guard.

Key files: `celery_worker/ai/replies.py`, `celery_worker/tests/ai/test_replies.py`

### Task 2: Add overload detection to generate_briefing()
**Commit:** edc27fa

Added `_count_items_due_today()` querying `canonical_events` with a 24h window from briefing time. No `delivery_status` filter per RESEARCH Pitfall 6. Integrated into `generate_briefing()` to prepend "Heavy day — N items due today. Prioritize: X, Y." when 5+ items found. Updated 5 existing tests to mock `_count_items_due_today` returning `(0, [])`.

Key files: `celery_worker/ai/briefing.py`, `celery_worker/tests/ai/test_briefing.py`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Lazy imports for todoist.db/fetch in _apply_todoist_mutation**
- **Found during:** Task 1 GREEN phase
- **Issue:** Module-level `from todoist.db import get_todoist_token` means tests patching `todoist.db.get_todoist_token` don't affect the already-imported name in `ai.replies`. At call time, SUPABASE_URL was missing causing KeyError.
- **Fix:** Moved imports inside `_apply_todoist_mutation()` body so tests patching `todoist.db.*` and `todoist.fetch.*` work correctly.
- **Files modified:** `celery_worker/ai/replies.py`
- **Commit:** 286ec23

**2. [Rule 3 - Blocking] Add `from __future__ import annotations` to replies.py and briefing.py**
- **Found during:** Task 1 and Task 2 GREEN phases
- **Issue:** Python 3.9 system test runner fails at module import time on `str | None` and `dict | None` union syntax (Python 3.10+ feature). Existing briefing.py had same issue once new tests attempted to import it.
- **Fix:** Added `from __future__ import annotations` at top of both files — defers annotation evaluation to strings, compatible with 3.9.
- **Files modified:** `celery_worker/ai/replies.py`, `celery_worker/ai/briefing.py`
- **Commit:** 286ec23, edc27fa

**3. [Rule 1 - Bug] Existing generate_briefing tests broken by new overload detection**
- **Found during:** Task 2 GREEN phase
- **Issue:** 5 existing `generate_briefing` tests called `generate_briefing()` without mocking `_count_items_due_today`, which hit `_get_supabase()` → `os.environ["SUPABASE_URL"]` → KeyError.
- **Fix:** Added `patch("ai.briefing._count_items_due_today", return_value=(0, []))` to each affected test. Also `test_generate_briefing_returns_text` would have failed if overload prepended text (asserting `result == expected`).
- **Files modified:** `celery_worker/tests/ai/test_briefing.py`
- **Commit:** edc27fa

## Decisions Made

1. **Lazy imports in _apply_todoist_mutation** — module-level imports prevent test mocking at `todoist.*` paths; lazy imports preserve the correct patch target for unit tests without requiring `ai.replies.*` patches in every test.

2. **`from __future__ import annotations`** — avoids changing type annotation syntax throughout the file while still supporting the Python 3.9 test runner. This is the same pattern already used by other modules in the codebase per STATE.md decision log.

3. **Existing test update strategy** — updated 5 pre-existing tests to mock `_count_items_due_today` rather than adding `SUPABASE_URL` to env patches, keeping the test intent clear and avoiding reliance on real Supabase connectivity.

## Test Results

```
celery_worker/tests/ai/test_replies.py  17 passed  (6 new Todoist tests)
celery_worker/tests/ai/test_briefing.py 22 passed  (4 new overload tests)
tests/ai/ + tests/todoist/              59 passed
```

## Self-Check

- [x] `celery_worker/ai/replies.py` modified — `286ec23`
- [x] `celery_worker/tests/ai/test_replies.py` modified — `286ec23`
- [x] `celery_worker/ai/briefing.py` modified — `edc27fa`
- [x] `celery_worker/tests/ai/test_briefing.py` modified — `edc27fa`
- [x] All 6 new Todoist reply tests pass
- [x] All 4 new overload tests pass
- [x] Full AI + Todoist suite: 59 passed

## Self-Check: PASSED
