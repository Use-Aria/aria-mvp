---
phase: 05-priority-engine-canonical-timeline-db
plan: 01
subsystem: priority-engine
tags: [priority-scoring, delivery-routing, tdd, pure-python, prio-02, prio-03]
dependency_graph:
  requires: []
  provides: [priority.engine.score_event, priority.engine.compute_urgency, priority.engine.SOURCE_AUTHORITY, priority.router.route_event]
  affects: [celery_worker/priority/ingest.py (plan 02), canvas_sync_user integration (plan 02)]
tech_stack:
  added: []
  patterns: [TDD red-green, pure stdlib math, pytest.approx for float assertions]
key_files:
  created:
    - celery_worker/priority/__init__.py
    - celery_worker/priority/engine.py
    - celery_worker/priority/router.py
    - celery_worker/tests/priority/__init__.py
    - celery_worker/tests/priority/test_engine.py
    - celery_worker/tests/priority/test_router.py
  modified: []
decisions:
  - "score_event() returns int (not float) — round(raw * 100) stored as 0-100 integer for clean DB queries and delivery threshold comparisons"
  - "Unknown source defaults to 0.5 authority — not an error; enables future sources (discord) to work before being added to SOURCE_AUTHORITY"
  - "compute_urgency clamp: days_remaining <= 0 (includes exactly 0) returns 1.0 — due-today events get max urgency"
metrics:
  duration: 2 minutes
  completed_date: "2026-03-19"
  tasks_completed: 2
  files_created: 6
  tests_passing: 21
---

# Phase 05 Plan 01: Priority Scoring Engine + Delivery Router Summary

**One-liner:** Pure Python priority engine using exponential urgency decay (math.exp(-0.15×days)) and three-tier SMS delivery router, built TDD with 21 passing tests covering all formula spot checks and boundary values.

## What Was Built

### celery_worker/priority/engine.py

Implements the locked priority formula from CONTEXT.md:

```
Priority = (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)
```

- `compute_urgency(days_remaining)` — exponential decay using `math.exp(-0.15 * days_remaining)`, clamped to 1.0 for overdue events (days_remaining <= 0)
- `score_event(grade_weight, days_remaining, source)` — returns integer 0-100; NULL grade_weight defaults to 0.0; unknown source defaults to authority 0.5
- `SOURCE_AUTHORITY` dict — canvas=1.0, gmail=0.9, todoist=0.8, discord=0.6 (locked)

### celery_worker/priority/router.py

Maps integer priority scores to delivery tiers:
- `route_event(priority_score)` — returns 'immediate' (>=80), 'digest' (50-79), or 'silent' (<50)

### Test Coverage

- `tests/priority/test_engine.py` — 13 tests: urgency spot checks (14/7/3/1/0 days, overdue), score_event formula verification (canvas due tomorrow, due today with weight), NULL grade_weight safety, unknown source fallback, SOURCE_AUTHORITY values, integer return type
- `tests/priority/test_router.py` — 8 tests: all boundary values (0, 49, 50, 65, 79, 80, 95, 100)

## Verification

```
cd celery_worker && python -m pytest tests/priority/ -x -q
21 passed in 0.05s
```

## Deviations from Plan

None — plan executed exactly as written. The `score_event()` return type was clarified to `int` (matching the plan's formula comment "returns round(...)=59"), consistent with storing priority_score as INTEGER in the DB.

## Self-Check: PASSED

- celery_worker/priority/engine.py — FOUND
- celery_worker/priority/router.py — FOUND
- celery_worker/tests/priority/test_engine.py — FOUND
- celery_worker/tests/priority/test_router.py — FOUND
- Commit 5d3307e (Task 1 — engine) — FOUND
- Commit fc1c608 (Task 2 — router) — FOUND
- 21 tests passing — CONFIRMED
