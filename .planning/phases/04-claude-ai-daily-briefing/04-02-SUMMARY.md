---
phase: 04-claude-ai-daily-briefing
plan: 02
subsystem: ai
tags: [celery, anthropic, claude-sonnet-4-6, sms, briefing, conversation-history, beat-schedule, crontab]

# Dependency graph
requires:
  - phase: 04-01
    provides: generate_briefing, is_in_briefing_window, get_deadlines_for_briefing, briefing_sent_today, write_outbound_message
  - phase: 03
    provides: send_sms_safe, dispatch_command, _get_user_sms_state
  - phase: 02
    provides: get_all_canvas_integrations, canvas_sync_user infrastructure

provides:
  - Conversational SMS reply handler (ai/replies.py) with two-step intent + response generation
  - Daily briefing fan-out Celery task (generate_daily_briefings_all) with Beat schedule
  - Per-user briefing task (generate_daily_briefing_user) with timezone window + dedup guards
  - Welcome briefing task triggered on first Canvas sync
  - Fully wired process_inbound_sms routing non-commands to Claude reply handler
  - Beat schedule entry: every 15 min, 6-12 UTC (crontab)

affects:
  - phase-05-gmail-gcal (uses same Celery worker infrastructure)
  - phase-07-frontend (API routes may trigger reply handler)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Two-step Claude intent extraction (JSON) then reply generation for structured SMS actions
    - Fan-out Celery pattern: coordinator task dispatches N per-user tasks
    - Timezone-aware briefing guard using is_in_briefing_window before any Claude call
    - First-sync detection via synced_at IS NULL check before mark_synced

key-files:
  created:
    - celery_worker/ai/replies.py
    - celery_worker/tests/ai/test_replies.py
    - celery_worker/tests/test_tasks_ai.py
  modified:
    - celery_worker/celery_app.py
    - celery_worker/tasks.py
    - celery_worker/tests/test_tasks_sms.py
    - celery_worker/tests/sms/test_send.py

key-decisions:
  - "Off-topic SMS handled with OFF_TOPIC_RESPONSE constant (no second Claude call) — saves latency and cost on non-deadline messages"
  - "build_history_messages deduplicates consecutive same-role messages — prevents invalid alternating-role violations in Claude messages API"
  - "welcome_briefing.delay called AFTER mark_synced — first sync state is confirmed before triggering welcome"
  - "process_inbound_sms Phase 4 stub replaced with real handle_reply call + send_sms_safe(is_proactive=False) to bypass daily cap"

patterns-established:
  - "Two-step Claude pattern: intent extraction → mutation → reply generation (reduces token cost for off-topic)"
  - "Fan-out Beat pattern: coordinator task dispatches per-user tasks, per-user task owns its own guards"
  - "synced_at IS NULL check for first-sync detection before mark_synced call"

requirements-completed:
  - SMS-03
  - AI-07
  - AUTH-07
  - CONV-01
  - SYNC-05
  - SYNC-06

# Metrics
duration: 9min
completed: 2026-03-19
---

# Phase 4 Plan 02: Celery Task Wiring — Reply Handler, Briefing Fan-out, Welcome Briefing Summary

**Claude-powered conversational SMS reply handler with two-step intent extraction, Beat-scheduled briefing fan-out every 15 min (6-12 UTC), welcome briefing on first Canvas sync, and fully wired process_inbound_sms routing**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-19T21:43:27Z
- **Completed:** 2026-03-19T21:52:18Z
- **Tasks:** 2 completed
- **Files modified/created:** 7

## Accomplishments

- Conversational reply handler (`ai/replies.py`) extracts intent via Claude, applies DB mutations (mark complete, snooze, set priority), and generates warm replies with conversation history context — all within 800 chars
- Beat schedule fires `generate_daily_briefings_all` every 15 min from 6-12 UTC; per-user task guards on `is_in_briefing_window` (local hour=8) and `briefing_sent_today` dedup check before calling Claude
- Welcome briefing triggers automatically on first Canvas sync (synced_at IS NULL check), sends with `is_welcome=True` flag
- `process_inbound_sms` non-command path now routes to `handle_reply` with `send_sms_safe(is_proactive=False)` and `write_outbound_message(..., "reply")`
- Full test suite: 94 tests passing (11 reply handler unit tests + 10 task integration tests + all prior Phase 2/3 tests)

## Task Commits

1. **Task 1: Conversational reply handler (TDD)** — `5d80741` (feat)
2. **Task 2: Celery task wiring** — `32ea2d9` (feat)

## Files Created/Modified

- `celery_worker/ai/replies.py` — Claude conversational reply handler: `handle_reply`, `build_history_messages`, `_find_best_match`, `_apply_mutation`
- `celery_worker/celery_app.py` — Added Beat schedule entry for `generate-daily-briefings` with `crontab(minute="*/15", hour="6-12")`
- `celery_worker/tasks.py` — Added `generate_daily_briefings_all`, `generate_daily_briefing_user`, `welcome_briefing`; updated `canvas_sync_user` with first-sync check; replaced stub in `process_inbound_sms`
- `celery_worker/tests/ai/test_replies.py` — 11 unit tests for reply handler (TDD)
- `celery_worker/tests/test_tasks_ai.py` — 10 integration tests for new Celery tasks
- `celery_worker/tests/test_tasks_sms.py` — Updated stub test to assert real reply routing
- `celery_worker/tests/sms/test_send.py` — Fixed pre-existing `test_paused_expired_allows` mock bug

## Decisions Made

- Off-topic SMS served via constant `OFF_TOPIC_RESPONSE` without a second Claude call — reduces latency and cost for all non-deadline messages
- `build_history_messages` deduplicates consecutive same-role entries — prevents Claude API errors from invalid message alternation
- `welcome_briefing.delay` called after `mark_synced` to avoid re-triggering on race conditions
- `process_inbound_sms` uses `is_proactive=False` for reply sends — bypasses daily proactive cap for user-initiated conversations

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing test_paused_expired_allows mock bug**
- **Found during:** Task 2 verification (full suite run)
- **Issue:** `mock_dt.now.return_value = local_now` always returned the local timezone datetime regardless of tz arg; pause guard comparing `datetime.now(timezone.utc)` to a UTC past timestamp got a local_now value that appeared earlier than the past timestamp, causing the guard to incorrectly block
- **Fix:** Replaced `return_value` with `side_effect` that branches on tz arg — UTC calls return fixed UTC time, tz calls return local_now; also computed `past` from the same fixed UTC time
- **Files modified:** `celery_worker/tests/sms/test_send.py`
- **Verification:** Test passes; no other send tests affected (94 total)
- **Committed in:** `32ea2d9` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Fix was necessary to achieve acceptance criteria (full suite exits 0). No scope creep — fix corrects existing test logic without changing production code.

## Issues Encountered

None beyond the pre-existing test bug documented above.

## User Setup Required

None - no external service configuration required. `ANTHROPIC_API_KEY` was already required from Phase 4 Plan 01.

## Next Phase Readiness

- Phase 4 complete: Claude AI briefings + conversational SMS handler fully operational end-to-end
- Phase 5 (Gmail + GCal) can begin immediately — no Phase 4 blockers
- Reminder: Start Google Cloud Console verification request for Gmail readonly scope before Phase 5 ends (1-6 week review window)

---
*Phase: 04-claude-ai-daily-briefing*
*Completed: 2026-03-19*
