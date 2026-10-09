---
phase: 05-priority-engine-canonical-timeline-db
plan: 02
subsystem: canonical-timeline-db
tags: [canonical-events, ingest, backfill, priority-routing, sms-alert, migration, prio-01, prio-03]
dependency_graph:
  requires: [priority.engine.score_event, priority.router.route_event, sms.send.send_sms_safe]
  provides: [canonical_events table, priority.ingest.ingest_canonical_event, sms.send.send_sms_alert, tasks.send_priority_alert, tasks.backfill_canonical_events, ai.db.get_events_for_briefing]
  affects: [canvas_sync_user (writes to canonical_events), generate_daily_briefing_user (reads from canonical_events), welcome_briefing (reads from canonical_events), Phase 6 integrations (call ingest_canonical_event)]
tech_stack:
  added: []
  patterns: [upsert-on-conflict, skip_routing backfill safety, field mapping shim for backwards compat, lazy import to avoid circular dependency]
key_files:
  created:
    - supabase/migrations/005_canonical_events.sql
    - celery_worker/priority/ingest.py
    - celery_worker/tests/priority/test_ingest.py
  modified:
    - celery_worker/sms/send.py
    - celery_worker/tasks.py
    - celery_worker/ai/db.py
    - celery_worker/tests/sms/test_send.py
    - celery_worker/tests/test_tasks_ai.py
decisions:
  - "ingest_canonical_event uses lazy import 'from tasks import send_priority_alert' to avoid circular dependency (tasks.py imports from priority)"
  - "grade_weight > 1 normalized to fraction before scoring — enables raw percentages (25.0) from Canvas to work without caller normalization"
  - "get_events_for_briefing appends due_date/course shim keys — generate_briefing remains unchanged; transition is backwards-compatible"
  - "send_sms_alert skips quiet hours, pause, and daily cap but always checks opt-out — TCPA hard requirement"
  - "backfill_canonical_events_user uses skip_routing=True — prevents alert spam for all pre-existing deadlines on Phase 5 deploy"
metrics:
  duration: 6 minutes
  completed_date: "2026-03-19"
  tasks_completed: 2
  files_created: 3
  files_modified: 5
  tests_passing: 123
---

# Phase 05 Plan 02: Canonical Timeline DB + Ingest + SMS Alert Summary

**One-liner:** Supabase canonical_events table with RLS/indexes, single ingest entry point scoring and routing all events, send_sms_alert bypassing quiet hours for score >= 80 delivery, canvas_sync wired to write diffs, idempotent backfill, and briefing tasks switched to read from canonical_events.

## What Was Built

### supabase/migrations/005_canonical_events.sql

Unified event store for all integrations:
- `canonical_events` table with `UNIQUE(user_id, source, title, due_at)` for idempotent upserts
- `delivery_status` constrained to `('immediate', 'digest', 'silent', 'sent')`
- RLS policy: user-scoped, service role bypasses via `_get_supabase()`
- Two partial indexes: `idx_canonical_events_briefing` (due_at where not deleted + digest/immediate) and `idx_canonical_events_delivery` (where immediate)

### celery_worker/priority/ingest.py

Single entry point for all event writes:
- `ingest_canonical_event()` — parses due_at, coerces UTC, computes days_remaining, normalizes grade_weight (% → fraction), scores via `score_event()`, routes via `route_event()`, upserts to canonical_events
- `skip_routing=True` overrides delivery_status to `'silent'` (backfill safety)
- Dispatches `send_priority_alert.delay()` for `immediate` non-backfill events via lazy import (avoids circular dependency with tasks.py)

### celery_worker/sms/send.py — send_sms_alert()

New function for high-priority delivery:
- Checks opt-out only — skips quiet hours, pause, daily cap entirely
- Logs `sms_alert_sent` event with hashed user ID (no PII)
- Reserved for priority_score >= 80 events

### celery_worker/tasks.py — three new tasks + wiring

- `send_priority_alert`: fetches canonical event, builds body, calls `send_sms_alert()`, marks event as `'sent'`
- `backfill_canonical_events`: fans out per user from deadlines table
- `backfill_canonical_events_user`: copies all user's deadlines to canonical_events with `skip_routing=True`
- `canvas_sync_user`: now calls `ingest_canonical_event()` for `diff['added'] + diff['changed']` after `apply_diff`
- `generate_daily_briefing_user` and `welcome_briefing`: switched from `get_deadlines_for_briefing` to `get_events_for_briefing`

### celery_worker/ai/db.py — get_events_for_briefing()

Replaces `get_deadlines_for_briefing()` for briefing tasks:
- Reads from `canonical_events` filtering on `delivery_status IN ('digest', 'immediate')`
- Filters snoozed events in Python (supabase-py v2 limitation — same pattern as Phase 04)
- Marks returned `digest` events as `'sent'` to prevent re-inclusion in future briefings
- Field mapping shim: appends `e["due_date"] = e["due_at"]` and `e["course"] = e.get("course_id")` for backwards compatibility with `generate_briefing()`

## Test Coverage

- `tests/priority/test_ingest.py` — 5 tests: happy path upsert, skip_routing=True forces silent, None grade_weight stored as 0, score >= 80 dispatches alert, grade_weight percentage normalization
- `tests/sms/test_send.py` — 3 new tests: send_sms_alert active user, opted-out blocked, bypasses guards (pause + quiet hours + daily cap)
- `tests/test_tasks_ai.py` — updated 3 existing tests to patch `get_events_for_briefing` instead of `get_deadlines_for_briefing`

## Verification

```
cd celery_worker && python -m pytest tests/ -x -q
123 passed in 3.27s
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] test_tasks_ai.py patches broken by briefing switchover**
- **Found during:** Task 2 verification
- **Issue:** Three existing tests in test_tasks_ai.py patched `ai.db.get_deadlines_for_briefing` which was no longer called after switching tasks.py to `get_events_for_briefing`. Tests would hit Supabase connection attempting to call the real function.
- **Fix:** Updated three patch targets in test_tasks_ai.py to `ai.db.get_events_for_briefing`
- **Files modified:** `celery_worker/tests/test_tasks_ai.py`
- **Commit:** 7099a67

**2. [Rule 1 - Bug] test_ingest.py used wrong patch paths for module-level attributes**
- **Found during:** Task 1 test run
- **Issue:** Initial test used `patch("priority.ingest.score_event")` but `ingest.py` uses local imports inside the function body, so `score_event` is not a module-level attribute of `priority.ingest`. Patching must target the source module.
- **Fix:** Changed all patches to `priority.engine.score_event`, `priority.router.route_event`, and used `create=True` for `tasks.send_priority_alert` (which doesn't exist until Task 2 runs).
- **Files modified:** `celery_worker/tests/priority/test_ingest.py`
- **Commit:** 96626e7

## Self-Check: PASSED

- supabase/migrations/005_canonical_events.sql — FOUND
- celery_worker/priority/ingest.py — FOUND
- celery_worker/tests/priority/test_ingest.py — FOUND
- celery_worker/sms/send.py contains send_sms_alert — FOUND
- celery_worker/tasks.py contains send_priority_alert, backfill_canonical_events, backfill_canonical_events_user — FOUND
- celery_worker/ai/db.py contains get_events_for_briefing — FOUND
- Commit 96626e7 (Task 1) — FOUND
- Commit 7099a67 (Task 2) — FOUND
- 123 tests passing — CONFIRMED
