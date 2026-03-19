---
phase: 03-twilio-sms-tcpa-compliance
plan: "03"
subsystem: sms-inbound-pipeline
tags: [twilio, webhook, celery, redis, tcpa, inbound-sms, signature-validation]
dependency_graph:
  requires: ["03-01", "03-02"]
  provides: ["SMS-02", "SMS-03", "SYNC-02"]
  affects: [celery_worker/tasks.py, src/app/api/sms/webhook/route.ts]
tech_stack:
  added: [ioredis]
  patterns: [celery-protocol-v2-redis-lpush, twilio-signature-validation, service-role-supabase-webhook]
key_files:
  created:
    - celery_worker/tests/test_tasks_sms.py
  modified:
    - src/app/api/sms/webhook/route.ts
    - celery_worker/tasks.py
    - celery_worker/sms/send.py
    - .env.example
    - package.json
decisions:
  - "Celery task receives user_id (UUID) not phone — webhook looks up user before enqueueing to avoid PII in Redis"
  - "phone added to _get_user_sms_state select so process_inbound_sms can retrieve it without a second DB call"
  - "Pre-existing test_send_happy_path failure (missing TWILIO env vars) is out of scope — confirmed pre-existing"
metrics:
  duration: 4 minutes
  completed_date: "2026-03-19T05:11:45Z"
  tasks_completed: 2
  files_changed: 5
---

# Phase 03 Plan 03: Inbound SMS Pipeline — Webhook, DB Write, Celery Dispatch Summary

**One-liner:** Upgraded Twilio webhook with signature validation + Supabase DB write + Redis Celery enqueue, wired to process_inbound_sms task that dispatches STOP/START/PAUSE/HELP commands.

## What Was Built

The inbound SMS pipeline is now end-to-end:

```
Twilio -> POST /api/sms/webhook -> (validate sig) -> (write messages table) -> (Redis LPUSH) -> process_inbound_sms Celery task -> dispatch_command()
```

**Webhook (`src/app/api/sms/webhook/route.ts`):**
- Validates Twilio signature via `twilio.validateRequest()` in production; bypassed with `TWILIO_DEV_BYPASS=true` in dev
- Uses `TWILIO_WEBHOOK_URL` env var (not `request.url`) to avoid Vercel proxy mismatch
- Returns 403 on invalid signature, 200 on all legitimate requests (including errors)
- Looks up user by phone via Supabase service role client
- Writes inbound message to messages table (`direction='in'`) before enqueueing
- Enqueues `tasks.process_inbound_sms` via Celery protocol v2 `LPUSH` to Redis `celery` queue
- No phone numbers appear in any log statement

**Celery task (`celery_worker/tasks.py`):**
- `process_inbound_sms(message_sid, body, user_id)` receives user UUID (not phone)
- Calls `_get_user_sms_state(user_id)` to retrieve phone for reply
- Dispatches to `dispatch_command()` for recognized keywords (STOP/START/PAUSE/HELP)
- Stubs non-command path with a log message — Phase 4 will route to Claude

**SYNC-02 verified:** `canvas-sync-all-users` Beat schedule at 3600.0s confirmed by existing `test_celery_app.py` tests (all pass).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Data] Added `phone` to `_get_user_sms_state` select**
- **Found during:** Task 2 implementation
- **Issue:** `_get_user_sms_state` select query did not include `phone` column. `process_inbound_sms` needs the user's phone to pass to `dispatch_command()` — without it, every inbound message would hit the `no_phone` early return and never dispatch.
- **Fix:** Added `phone` to the select string in `celery_worker/sms/send.py`
- **Files modified:** `celery_worker/sms/send.py`
- **Commit:** 3211871

## Test Results

| Test file | Tests | Result |
|-----------|-------|--------|
| tests/test_celery_app.py | 3 | PASS |
| tests/test_tasks_sms.py | 3 | PASS |
| npm run build | — | PASS |

## Self-Check

**Files exist:**
- src/app/api/sms/webhook/route.ts: present
- celery_worker/tasks.py: contains process_inbound_sms
- celery_worker/tests/test_tasks_sms.py: created

**Commits:**
- 657e4fe: feat(03-03): upgrade webhook with signature validation, DB write, Celery enqueue
- 3211871: feat(03-03): add process_inbound_sms task, fix phone in _get_user_sms_state
