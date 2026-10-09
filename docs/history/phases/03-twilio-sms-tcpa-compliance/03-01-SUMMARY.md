---
phase: 03-twilio-sms-tcpa-compliance
plan: 01
subsystem: sms
tags: [tcpa, twilio, compliance, sms, celery, supabase, tdd]
dependency_graph:
  requires: []
  provides: [send_sms_safe, send_sms_direct, 003_tcpa_columns]
  affects: [03-02-commands, 03-03-webhook]
tech_stack:
  added: [twilio==9.10.3]
  patterns: [centralized-guard, structured-logging, tdd-red-green]
key_files:
  created:
    - supabase/migrations/003_tcpa_columns.sql
    - celery_worker/sms/__init__.py
    - celery_worker/sms/send.py
    - celery_worker/tests/sms/__init__.py
    - celery_worker/tests/sms/test_send.py
    - celery_worker/conftest.py
  modified:
    - celery_worker/requirements.txt
decisions:
  - "conftest.py adds celery_worker root to sys.path for pytest — required because @patch() resolves module paths at collection time, not runtime"
  - "send_sms_safe() guards execute in fixed order: opted_out → paused → quiet_hours → daily_cap"
  - "Midnight-spanning quiet window uses OR logic: (local_time >= qs) or (local_time < qe)"
  - "_increment_daily_count uses state dict from _get_user_sms_state to avoid second DB read"
metrics:
  duration_seconds: 417
  completed_date: "2026-03-19"
  tasks_completed: 1
  files_created: 6
  files_modified: 1
---

# Phase 03 Plan 01: TCPA Migration + send_sms_safe() Summary

**One-liner:** Centralized `send_sms_safe()` TCPA guard with opt-out, pause, midnight-spanning quiet hours, and daily cap enforcement, backed by 7 new users table columns and 14 passing unit tests.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Write failing tests for all 14 TCPA guard behaviors | 098155c | celery_worker/tests/sms/test_send.py |
| 1 (GREEN) | Implement send_sms_safe(), migration 003, requirements | 79d9f3a, 098155c | sms/send.py, 003_tcpa_columns.sql, requirements.txt |

---

## What Was Built

### Migration 003 (`supabase/migrations/003_tcpa_columns.sql`)

Adds 7 TCPA compliance columns to `public.users`:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `sms_opted_out` | BOOLEAN NOT NULL | false | Hard opt-out flag |
| `sms_opted_out_at` | TIMESTAMPTZ | NULL | When opt-out was set |
| `sms_paused_until` | TIMESTAMPTZ | NULL | Temporary pause expiry |
| `daily_sms_count` | INT NOT NULL | 0 | Count of proactive messages today |
| `daily_sms_date` | DATE | NULL | Date the count applies to (user local TZ) |
| `quiet_hours_start` | TIME | '22:00' | Start of quiet window |
| `quiet_hours_end` | TIME | '08:00' | End of quiet window |

Two partial indexes: `idx_users_sms_paused` and `idx_users_sms_opted_out`.

### `celery_worker/sms/send.py`

Five functions:

- **`send_sms_safe(user_id, to_phone, body, is_proactive=True) -> bool`** — The primary entry point for all outbound SMS. Runs 4 guards in sequence; calls `client.messages.create()` only when all pass.
- **`send_sms_direct(to_phone, body) -> str`** — Bypass for STOP confirmation only. Returns MessageSid.
- **`_get_user_sms_state(user_id) -> dict`** — Supabase select on users table for all TCPA columns.
- **`_increment_daily_count(user_id, local_date_str, user) -> None`** — Atomic increment or reset of daily count.
- **`_log_suppressed(hashed_id, reason) -> None`** — Structured JSON log with hashed uid, never PII.

Guard order in `send_sms_safe()`:
1. `sms_opted_out == True` → block (reason: opted_out)
2. `sms_paused_until` in future → block (reason: paused)
3. Quiet hours: `(local_time >= qs) or (local_time < qe)` → block (reason: quiet_hours)
4. `is_proactive=True` and `daily_sms_count >= 3` and date matches → block (reason: daily_cap)

### Test Coverage (`celery_worker/tests/sms/test_send.py`)

14 tests, all passing:

| Test | Guard Tested |
|------|-------------|
| test_send_happy_path | All guards pass, Twilio called |
| test_opted_out_blocks | opted_out=True → False |
| test_paused_blocks | paused_until=future → False |
| test_paused_expired_allows | paused_until=past → allowed |
| test_quiet_hours_blocks_11pm | 23:00 in quiet window → False |
| test_quiet_hours_blocks_3am | 03:00 in midnight-spanning window → False |
| test_quiet_hours_allows_9am | 09:00 outside window → allowed |
| test_quiet_hours_allows_9pm | 21:00 before quiet start → allowed |
| test_daily_cap_blocks_4th_proactive | count=3, is_proactive=True → False |
| test_daily_cap_allows_reply | count=3, is_proactive=False → allowed |
| test_daily_cap_resets_new_day | date=yesterday, count=3 → resets, allowed |
| test_daily_count_incremented | _increment_daily_count called with local date |
| test_suppressed_log_opted_out | JSON log has event, reason, uid (12-char hash) |
| test_suppressed_log_no_phone | Raw phone/user_id never appears in log output |

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added conftest.py for pytest sys.path**
- **Found during:** Task 1 GREEN phase, first test run
- **Issue:** `@patch("sms.send._increment_daily_count")` raised `ModuleNotFoundError: No module named 'sms'` because pytest's working directory wasn't on `sys.path` when decorators were evaluated at collection time. `python -c "import sms.send"` worked fine from the `celery_worker/` dir, but pytest's internal `importlib.import_module` had no path to resolve `sms`.
- **Fix:** Created `celery_worker/conftest.py` that inserts `os.path.dirname(__file__)` (the celery_worker root) into `sys.path[0]`. This is the standard pytest pattern for rootless packages.
- **Files modified:** `celery_worker/conftest.py` (created)
- **Commit:** 098155c

**2. [Note] Plan 02 pre-implemented send.py stub**
- Plan 02 was executed before Plan 01 (plans ran in order 02 → 01 in previous session context). The stub at `celery_worker/sms/send.py` was already replaced by the full implementation via commit `79d9f3a` during Plan 02 execution. This plan's GREEN phase confirmed the implementation is correct and all 14 tests pass against it. No re-implementation was needed.

---

## Self-Check: PASSED

- `celery_worker/sms/send.py` — FOUND
- `celery_worker/sms/__init__.py` — FOUND
- `celery_worker/tests/sms/__init__.py` — FOUND
- `celery_worker/tests/sms/test_send.py` — FOUND
- `supabase/migrations/003_tcpa_columns.sql` — FOUND
- `celery_worker/conftest.py` — FOUND
- Commit 098155c — FOUND
- Commit 79d9f3a (send.py implementation) — FOUND
- `pytest tests/sms/test_send.py -x -q` — 14 passed, exit 0
