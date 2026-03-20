---
phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection
plan: 02
subsystem: sms-batching
tags: [redis, celery, sms, batching, rate-limiting, tcpa]
dependency_graph:
  requires: [celery_worker/sms/send.py, celery_worker/tasks.py, celery_worker/celery_app.py]
  provides: [celery_worker/sms/batch.py, flush_sms_batch Celery task]
  affects: [send_priority_alert routing, downstream GCal/Gmail alert plans 03/04]
tech_stack:
  added: [fakeredis (test dependency)]
  patterns: [SETNX atomic lock, Redis RPUSH/LRANGE/DELETE, Celery countdown dispatch]
key_files:
  created:
    - celery_worker/sms/batch.py
    - celery_worker/tests/sms/test_batch.py
  modified:
    - celery_worker/tasks.py
decisions:
  - SMS-10 and SMS-11 enforced via batch queue — all priority alerts enqueue rather than send directly
  - SETNX lock (not llen==0 check) used for atomic first-enqueuer detection to prevent duplicate flush scheduling
  - Event marked 'sent' immediately on enqueue (not at flush) to prevent priority router re-dispatch
metrics:
  duration: 8 minutes
  completed: "2026-03-20T02:55:47Z"
  tasks_completed: 2
  files_changed: 3
---

# Phase 06 Plan 02: SMS Batch Queue Summary

**One-liner:** Redis-based SMS batching layer with SETNX lock and Celery countdown flush, enforcing SMS-10 (10-min window combining) and SMS-11 (3-per-window cap).

## What Was Built

A Redis-backed SMS batching queue that collects multiple high-priority alerts for the same user within a 10-minute window and delivers them as a single combined SMS. This prevents alert spam when Canvas diffs, GCal changes, and Gmail signals fire simultaneously.

**`celery_worker/sms/batch.py`** — Core batch module:
- `enqueue_alert(user_id, text, priority_score)` — appends alert to `sms_batch:{user_id}` list and atomically acquires a 600s flush lock via SETNX. Returns `True` only for the first enqueuer in a window (caller schedules flush).
- `flush_batch(user_id)` — reads and deletes all items, sorts by priority descending, caps at 3 (SMS-11), formats body (single item: direct text; multiple: numbered "N updates:" list), sends via `send_sms_alert()`.

**`celery_worker/tasks.py`** — Two changes:
1. Added `flush_sms_batch` Celery task (`name="tasks.flush_sms_batch"`) — calls `flush_batch()` after the 600s countdown window.
2. Modified `send_priority_alert` — replaced direct `send_sms_alert()` call with `enqueue_alert()`. On first enqueue, schedules `flush_sms_batch.apply_async(args=[user_id], countdown=600)`. Event is marked as `'sent'` immediately to prevent priority router re-dispatch.

## Tests

14 new tests in `celery_worker/tests/sms/test_batch.py`:
- `enqueue_alert` tests: first item returns True, second returns False, SETNX semantics, different-user independence, item JSON storage, TTL on batch key and lock key.
- `flush_batch` tests: empty queue no-op, single-item direct send, multi-item numbered list, 5-item truncation to top-3, Redis key cleanup, priority sort order, missing user state returns None.

Full suite: **144 tests pass** (130 existing + 14 new, zero failures).

## Decisions Made

**SETNX over `llen == 0` for lock detection:** A `llen == 0` check has a race condition — two workers can both see `llen == 0` before either pushes an item. SETNX is atomic at the Redis level, eliminating the race.

**Mark event 'sent' at enqueue time, not flush time:** The priority router (Phase 5) checks `delivery_status` to decide whether to re-dispatch. Waiting until the 10-minute flush window closes would allow the router to fire the same event a second time. Marking 'sent' immediately prevents double-dispatch while the batch is held.

**Batch queue for all priority alerts (not only simultaneous ones):** The SETNX lock window means even a single isolated alert waits 10 minutes before delivery. This is the correct trade-off — SMS-10 requires combining within any 10-minute window, not just simultaneous bursts.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `celery_worker/sms/batch.py` — created and contains all required strings
- `celery_worker/tests/sms/test_batch.py` — created with 14 tests (>50 lines)
- `celery_worker/tasks.py` — contains `flush_sms_batch`, `enqueue_alert`, `flush_sms_batch.apply_async`, `countdown=600`
- All 144 tests pass
- Commits: eecf4c5 (failing tests), 6d02146 (batch.py implementation), 52afac0 (tasks.py integration)
