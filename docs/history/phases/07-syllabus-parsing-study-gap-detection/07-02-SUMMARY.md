---
phase: 07-syllabus-parsing-study-gap-detection
plan: "02"
subsystem: ai
tags: [gap-analysis, briefing, celery, syllabus, sms]
dependency_graph:
  requires: ["07-01"]
  provides: ["gap_analysis_all_users", "run_gap_analysis_task", "get_syllabus_context", "briefing_syllabus_enrichment"]
  affects: ["celery_worker/ai/briefing.py", "celery_worker/tasks.py", "celery_worker/celery_app.py"]
tech_stack:
  added: []
  patterns: ["TDD red-green", "Celery fan-out pattern", "SMS batch queue with priority_score=75", "ILIKE case-insensitive course matching", "graceful degradation (no syllabus = no alert)"]
key_files:
  created:
    - celery_worker/tests/ai/test_briefing_syllabus.py
  modified:
    - celery_worker/ai/syllabus.py
    - celery_worker/tasks.py
    - celery_worker/celery_app.py
    - celery_worker/ai/briefing.py
    - celery_worker/tests/ai/test_syllabus.py
    - celery_worker/tests/test_tasks_ai.py
decisions:
  - "get_syllabus_context uses Python-side partial matching after fetching all user syllabi — avoids N DB queries per deadline (one query for all syllabi, then dict lookup)"
  - "gap_analysis_all_users queries canonical_events by UTC date range for T-5 — targets calendar day not exact timestamp for robustness"
  - "Lazy import pattern for get_syllabus_context in generate_daily_briefing_user — consistent with existing lazy import pattern throughout tasks.py"
metrics:
  duration_minutes: 4
  completed_date: "2026-03-21"
  tasks_completed: 2
  files_changed: 6
---

# Phase 7 Plan 02: Study Gap Analysis + Briefing Enrichment Summary

Study gap analysis at T-5 days (fan-out Celery tasks + Beat schedule at 03:00 UTC) and syllabus-aware briefing enrichment with exam topic hints and Monday coverage summaries.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Gap analysis functions + Celery tasks + Beat schedule | 9e3b95c | syllabus.py, tasks.py, celery_app.py, test_syllabus.py |
| 2 | Briefing enrichment with syllabus_context + wiring | 0b613fb | briefing.py, tasks.py, test_briefing_syllabus.py, test_tasks_ai.py |

## What Was Built

### Task 1: Gap analysis core

Three new functions added to `celery_worker/ai/syllabus.py`:

- **`get_gap_topics(user_id, course_id)`** — queries `syllabi` table with ILIKE for case-insensitive course matching, returns top-3 exam topics sorted by weight_pct descending. Returns `[]` gracefully when no syllabus exists.
- **`build_gap_alert_body(course, days_until, exam_title, topics)`** — builds SMS under 800 chars with exam name, days, topic list, and grade weight hint. Truncates with `...` if exceeded.
- **`get_syllabus_context(user_id, deadlines, is_monday)`** — fetches all user syllabi in one query, builds exam topic hints for exams within 7 days, and Monday coverage summaries for exams within 14 days.

Two new Celery tasks added to `celery_worker/tasks.py`:

- **`gap_analysis_all_users`** — daily Beat fan-out: queries `canonical_events` for `type='exam'` in T-5 date range, dispatches `run_gap_analysis_task.delay()` per match.
- **`run_gap_analysis_task`** — per-user/per-exam: calls `get_gap_topics`, builds alert body, routes through `enqueue_alert(priority_score=75)` + `flush_sms_batch.apply_async`. Skips silently when no syllabus.

Beat schedule added to `celery_worker/celery_app.py`: `gap-analysis-daily` fires at `crontab(hour=3, minute=0)` — avoids the 06:00-12:00 briefing window.

### Task 2: Briefing enrichment

`generate_briefing()` signature extended with `syllabus_context: dict | None = None` parameter (fully backwards-compatible). When provided:
- Daily: appends `EXAM TOPIC HINTS (from syllabus)` section to Claude prompt for exams within 7 days.
- Monday only: also appends `EXAM TOPIC COVERAGE (next 14 days)` section with full topic lists.

`generate_daily_briefing_user` now calls `get_syllabus_context()` after fetching deadlines, passes result as `syllabus_context=syllabus_context` to `generate_briefing`.

### Test coverage

- 8 new tests in `test_syllabus.py` covering all gap analysis behaviors
- 5 new tests in `test_briefing_syllabus.py` covering briefing enrichment paths
- Total suite: 242 tests passing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated test_tasks_ai.py to mock get_syllabus_context**
- **Found during:** Task 2 full suite run
- **Issue:** `test_generate_daily_briefing_user_sends_on_valid_window` did not mock `get_syllabus_context`, causing it to reach `_get_supabase()` which requires `SUPABASE_URL` env var. The test broke after we wired the new call into the task.
- **Fix:** Added `patch("ai.syllabus.get_syllabus_context", return_value=None)` to the existing test's context manager stack.
- **Files modified:** `celery_worker/tests/test_tasks_ai.py`
- **Commit:** 0b613fb

## Decisions Made

- `get_syllabus_context` fetches all user syllabi in one query then does Python-side partial matching, avoiding N Supabase calls per deadline loop. At MVP scale (few syllabi per user), single-query pattern is optimal.
- `gap_analysis_all_users` targets a full calendar day UTC range (00:00:00 to 23:59:59) for T-5 detection. This is more robust than exact timestamp comparison for exams stored as 23:59:59Z all-day events.
- Lazy import for `get_syllabus_context` inside `generate_daily_briefing_user` matches the existing pattern throughout `tasks.py` and avoids circular import risk.

## Self-Check: PASSED

- celery_worker/ai/syllabus.py: FOUND
- celery_worker/tests/ai/test_briefing_syllabus.py: FOUND
- .planning/phases/07-syllabus-parsing-study-gap-detection/07-02-SUMMARY.md: FOUND
- Commit 9e3b95c (Task 1): FOUND
- Commit 0b613fb (Task 2): FOUND
