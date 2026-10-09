---
phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection
plan: 04
subsystem: gmail-pipeline
tags: [gmail, pubsub, claude-haiku, rapidfuzz, webhook, alerts, tdd]
dependency_graph:
  requires: ["06-01", "06-02"]
  provides: ["gmail-auth", "gmail-watch", "gmail-classify", "gmail-alerts", "gmail-webhook"]
  affects: ["tasks.renew_watch_channels", "gmail_flags table", "canonical_events"]
tech_stack:
  added: ["rapidfuzz", "gmail-api", "pubsub-push"]
  patterns: ["history-based-fetch", "fuzzy-matching", "batch-alerts"]
key_files:
  created:
    - celery_worker/gmail/__init__.py
    - celery_worker/gmail/auth.py
    - celery_worker/gmail/fetch.py
    - celery_worker/gmail/classify.py
    - celery_worker/gmail/watch.py
    - celery_worker/tests/gmail/__init__.py
    - celery_worker/tests/gmail/test_classify.py
    - celery_worker/tests/gmail/test_watch.py
    - src/app/api/gmail/webhook/route.ts
  modified:
    - celery_worker/tasks.py
    - .env.example
key_decisions:
  - "rapidfuzz token_set_ratio threshold set to 70 — allows partial matches (Bio Lab Report Extended matches Bio Lab Report) while rejecting unrelated subjects"
  - ".edu filter applied before any processing — professors only, eliminates spam signal"
  - "Gmail watch renewal piggybacks on existing renew_watch_channels Beat job — no new Beat task needed"
  - "Pub/Sub webhook dispatches to all Google-connected users at MVP scale; google_email column deferred for precise matching in production"
metrics:
  duration_minutes: 6
  tasks_completed: 2
  files_created: 9
  files_modified: 2
  tests_added: 20
  tests_total: 188
  completed_date: "2026-03-20"
---

# Phase 06 Plan 04: Gmail Pipeline Summary

Complete Gmail monitoring pipeline from Pub/Sub push notification to classified contradiction alert with Canvas cross-reference using Claude Haiku and rapidfuzz fuzzy matching.

## What Was Built

### Gmail Auth Module (`celery_worker/gmail/auth.py`)
`build_gmail_service(user_id)` — mirrors `gcal/auth.py` pattern. Loads encrypted tokens from `integrations` table, builds Gmail API v1 service with 5-minute pre-expiry refresh. Same token lifecycle as GCal.

### Gmail Fetch Module (`celery_worker/gmail/fetch.py`)
- `decode_pubsub_message(data)` — decodes base64url Pub/Sub payload to `{emailAddress, historyId}`, handles padding stripping
- `fetch_new_messages(user_id, start_history_id)` — uses `history.list` API with `messageAdded` history type; fetches only `format=metadata` with From/Subject headers; filters to `.edu` senders only; NEVER returns full email body
- `get_stored_history_id()` / `update_history_id()` — cursor management in `integrations.history_id` column

### Gmail Classify Module (`celery_worker/gmail/classify.py`)
- `classify_email(subject, snippet)` — Claude Haiku (`claude-haiku-4-5-20251001`) classifies subject + snippet, returns `{is_deadline_change: bool, confidence: float}`. Error fallback: `{is_deadline_change: False, confidence: 0.0}`
- `find_matching_deadline(email_subject, deadlines)` — rapidfuzz `token_set_ratio` matching against deadline title and title+course combo. Returns best match if score >= 70, else None.

### Gmail Watch Module (`celery_worker/gmail/watch.py`)
- `establish_gmail_watch(user_id)` — calls `users.watch()` with `GMAIL_PUBSUB_TOPIC`, stores `historyId` cursor, stores `watch_expires_at` in integrations table. Returns `{}` if topic not configured.
- `renew_gmail_watch(user_id)` — delegates to `establish_gmail_watch` (Gmail handles replacement automatically)

### Gmail Webhook Route (`src/app/api/gmail/webhook/route.ts`)
Pub/Sub push receiver. Decodes `message.data` (base64url) to extract `historyId` and `emailAddress`. Enqueues `tasks.gmail_process_notification` to Redis/Celery for each Google-connected user. Always returns 200 to prevent Pub/Sub retry loops.

### Gmail Tasks in `celery_worker/tasks.py`
- `gmail_process_notification(user_id, new_history_id)` — main processing pipeline:
  1. Checks stored historyId (initializes cursor on first call)
  2. Fetches `.edu` messages since stored cursor
  3. Advances cursor to new historyId
  4. Classifies each email with Claude Haiku
  5. Inserts into `gmail_flags` (subject, sender, summary truncated to 200 chars, confidence) — NEVER full body
  6. If `confidence >= 0.8 AND is_deadline_change`: finds Canvas match via rapidfuzz
  7. If Canvas match: fires contradiction alert (both Canvas state and email claim surfaced)
  8. If no Canvas match: fires general deadline change alert
  9. Routes alert through `enqueue_alert` with priority_score=85, schedules `flush_sms_batch`
- `gmail_establish_watch_task(user_id)` — thin wrapper for OAuth callback dispatch
- `renew_watch_channels` extended to also query users with `history_id` set and renew Gmail watches

## Test Coverage (20 new tests)

**test_classify.py (14 tests):**
- `classify_email`: high confidence deadline change, Haiku model selection, low confidence non-deadline, ambiguous email, error fallback
- `find_matching_deadline`: high similarity match, no match below 70, empty list, course+title combo match
- `decode_pubsub_message`: base64url decode, padding handling
- `fetch_new_messages`: .edu filter, field structure, API error returns []

**test_watch.py (6 tests):**
- `establish_gmail_watch`: correct topic in watch call, historyId stored, missing topic returns {}, returns response
- `renew_gmail_watch`: delegates to establish, returns result

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing rapidfuzz dependency**
- **Found during:** Task 1 GREEN phase
- **Issue:** `from rapidfuzz import fuzz` raised `ModuleNotFoundError` — not installed in environment
- **Fix:** `pip install rapidfuzz`
- **Files modified:** None (runtime dependency install)
- **Commit:** 61617bd

**2. [Rule 1 - Bug] Test env var missing for ANTHROPIC_API_KEY**
- **Found during:** Task 1 GREEN phase
- **Issue:** `classify_email` tests without `@patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"})` raised `KeyError` because `Anthropic()` init reads the env var before mock takes effect
- **Fix:** Added `@patch.dict("os.environ", ...)` to all four classify_email tests
- **Files modified:** celery_worker/tests/gmail/test_classify.py
- **Commit:** 61617bd

**3. [Rule 1 - Bug] Watch tests missing Supabase mock**
- **Found during:** Task 2 watch test run
- **Issue:** `establish_gmail_watch` calls `_get_supabase()` to store `watch_expires_at`, but tests didn't mock `ai.db._get_supabase`
- **Fix:** Added `@patch("ai.db._get_supabase")` to tests that call establish_gmail_watch
- **Files modified:** celery_worker/tests/gmail/test_watch.py
- **Commit:** d27a22e

## Self-Check: PASSED

All created files verified present on disk. Both task commits verified in git history.
- celery_worker/gmail/auth.py: FOUND
- celery_worker/gmail/fetch.py: FOUND
- celery_worker/gmail/classify.py: FOUND
- celery_worker/gmail/watch.py: FOUND
- celery_worker/tests/gmail/test_classify.py: FOUND
- celery_worker/tests/gmail/test_watch.py: FOUND
- src/app/api/gmail/webhook/route.ts: FOUND
- Commit 61617bd: FOUND
- Commit d27a22e: FOUND
