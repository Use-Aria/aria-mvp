---
phase: 04-claude-ai-daily-briefing
plan: "01"
subsystem: ai
tags: [claude, briefing, daily-sms, load-score, exam-countdown, supabase, tdd]
dependency_graph:
  requires:
    - 03-twilio-sms-tcpa-compliance (sms/send.py, conftest.py patterns)
    - 02-canvas-ical-sync (deadlines table, canvas_uid, deleted_at)
  provides:
    - celery_worker/ai/briefing.py (generate_briefing, compute_load_score, get_exam_touchpoints, is_in_briefing_window)
    - celery_worker/ai/db.py (get_deadlines_for_briefing, get_conversation_history, briefing_sent_today, write_outbound_message)
    - supabase/migrations/004_deadlines_task_management.sql (status, snoozed_until, priority columns)
  affects:
    - 04-02 (reply handler depends on ai/db.py, briefing.py patterns)
tech_stack:
  added:
    - anthropic>=0.86.0 (Claude Sonnet API client)
    - zoneinfo (stdlib — timezone-aware date math for exam touchpoints)
  patterns:
    - TDD red-green: failing tests committed before implementation
    - Timezone-aware date comparison (local date not UTC) for all-day events
    - SHA-256 hashed user_id for logging (never plaintext PII)
    - Snoozed deadline filtering in Python (not SQL) after Supabase query
key_files:
  created:
    - supabase/migrations/004_deadlines_task_management.sql
    - celery_worker/ai/__init__.py
    - celery_worker/ai/db.py
    - celery_worker/ai/briefing.py
    - celery_worker/tests/ai/__init__.py
    - celery_worker/tests/ai/test_briefing.py
  modified:
    - celery_worker/requirements.txt (added anthropic>=0.86.0)
decisions:
  - "[04-01]: Snoozed deadline filtering is done in Python after Supabase query — supabase-py v2 lacks native timestamp comparison filter for 'snoozed_until > now'; Python filter is correct and cheap at MVP scale"
  - "[04-01]: generate_briefing takes no conversation_history param — briefing personalization from conversation context is deferred to future phases per CONTEXT.md; reply handler (Plan 02) owns conversation history"
  - "[04-01]: Timezone-aware date comparison uses local date for days_until calculation — prevents off-by-one errors with Canvas all-day events stored as 23:59:59 UTC"
metrics:
  duration_minutes: 4
  completed_date: "2026-03-19"
  tasks_completed: 2
  files_created: 7
  files_modified: 1
---

# Phase 04 Plan 01: Daily Briefing Generator Core Summary

**One-liner:** Claude Sonnet briefing generator with load score (green/yellow/red), exam countdown touchpoints (T-7,5,3,1,0), timezone-aware date math, and shared Supabase query layer.

## What Was Built

### Migration 004 — Task Management Columns

Added three columns to the `deadlines` table:
- `status TEXT DEFAULT 'upcoming'` — enables "mark complete" SMS command
- `snoozed_until TIMESTAMPTZ` — enables "snooze" SMS command
- `priority VARCHAR DEFAULT 'normal'` — enables "mark high priority" SMS command

Added `idx_deadlines_briefing` partial index on `(user_id, due_date)` filtered to active, non-completed deadlines for briefing query performance.

### celery_worker/ai/db.py — Shared Query Layer

Four exported functions consumed by both the briefing generator and the reply handler (Plan 02):

- `get_deadlines_for_briefing(user_id, days_ahead)` — fetches active deadlines within window, filters snoozed in Python
- `get_conversation_history(user_id, limit=10)` — last N messages for SMS reply context
- `briefing_sent_today(user_id, user_local_date_str)` — deduplication guard before sending briefing
- `write_outbound_message(user_id, body, trigger_type)` — persists outbound message record

### celery_worker/ai/briefing.py — Briefing Generator

Four exported functions:

- `compute_load_score(deadlines_48h)` — green (0-1), yellow (2-3), red (4+) based on 48h deadline count
- `get_exam_touchpoints(deadlines, user_tz)` — returns exams at T-7, T-5, T-3, T-1, T-0 with timezone-aware local date math
- `is_in_briefing_window(preferences_json)` — returns True only when user's local hour == 8
- `generate_briefing(user_id, deadlines, is_monday, is_welcome, user_tz)` — calls Claude Sonnet with standard or Monday extended prompt; enforces 800-char limit with ellipsis truncation

## Test Coverage

18 unit tests across all four functions. Zero Supabase or Twilio calls — all external dependencies mocked.

Key test cases:
- Load score thresholds (0, 1, 2, 3, 4, 10 deadlines)
- Exam touchpoints at T-7, T-0, and non-touchpoint T-4
- Non-exam deadlines correctly ignored
- Timezone-aware exam date: 23:59:59 UTC on March 26 is 7 days from March 19 EST
- Briefing window check at hour 8 (True) and hour 9 (False)
- Claude called with `model="claude-sonnet-4-6"` and system containing "Aria"
- Monday prompt vs standard prompt selection
- 900-char Claude output truncated to <= 800 chars with "..."

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] anthropic package not installed in dev environment**
- **Found during:** Task 2 GREEN phase — tests could not collect because `from anthropic import Anthropic` raised `ModuleNotFoundError`
- **Fix:** Ran `pip install "anthropic>=0.86.0"` in the celery_worker environment
- **Files modified:** None (pip install only; package already in requirements.txt)
- **Commit:** Not applicable (environment-level fix)

## Self-Check: PASSED

Files verified:
- FOUND: supabase/migrations/004_deadlines_task_management.sql
- FOUND: celery_worker/ai/__init__.py
- FOUND: celery_worker/ai/db.py
- FOUND: celery_worker/ai/briefing.py
- FOUND: celery_worker/tests/ai/__init__.py
- FOUND: celery_worker/tests/ai/test_briefing.py
- FOUND: 18 test functions in test_briefing.py
- All tests pass: 18 passed in 4.19s
