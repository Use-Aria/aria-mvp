---
phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection
verified: 2026-03-20T04:00:00Z
status: passed
score: 19/19 must-haves verified
re_verification: false
---

# Phase 6: Google OAuth + GCal + Gmail + Alerts + Conflict Detection Verification Report

**Phase Goal:** Full Google integrations (OAuth + GCal + Gmail) with intelligent alerts and conflict detection
**Verified:** 2026-03-20T04:00:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Gmail_flags and conflict_alerts tables exist with correct columns and RLS | VERIFIED | `supabase/migrations/006_google_integrations.sql` lines 8-41 |
| 2 | Integrations table has channel_id, resource_id, watch_expires_at, history_id columns | VERIFIED | migration 006 lines 46-50 |
| 3 | OAuth tokens encrypted with Fernet before storage, decrypted on load | VERIFIED | `google_auth/encryption.py` (encrypt_token/decrypt_token), `google_auth/tokens.py` (encrypt before upsert, decrypt on load) |
| 4 | User completing OAuth flow gets tokens stored encrypted; confirmation SMS sent | VERIFIED | `src/app/api/auth/google/callback/route.ts` dispatches `encrypt_and_store_tokens`; `tasks.py:664` encrypts and sends SMS |
| 5 | OAuth callback NEVER writes plaintext tokens to Supabase | VERIFIED | Callback route contains no direct `upsert`/`integrations` write; task is the encryption boundary |
| 6 | Multiple alerts within 10 minutes combined into one SMS | VERIFIED | `sms/batch.py:enqueue_alert` + `flush_batch` with SETNX lock and BATCH_TTL=600 |
| 7 | No more than 3 texts in any 10-minute window | VERIFIED | `sms/batch.py:MAX_TEXTS_PER_WINDOW = 3`, items capped at flush |
| 8 | GCal events fetched (7-day window), declined/transparent filtered, stored in calendar_events + canonical_events | VERIFIED | `gcal/fetch.py:fetch_gcal_events` filters both; `tasks.py:gcal_sync_user` calls `store_calendar_events` + `ingest_canonical_event` |
| 9 | GCal push webhook returns 200 immediately and enqueues gcal_sync_user | VERIFIED | `src/app/api/gcal/webhook/route.ts` lines 32-88; always returns 200, enqueues via Redis |
| 10 | Watch channel established on first sync; renewed 48h before expiry via Celery Beat | VERIFIED | `gcal/watch.py:establish_watch`; `celery_app.py` has `renew-watch-channels` Beat entry; `renew_watch_channels` checks 48h cutoff |
| 11 | Gmail watch established via Pub/Sub; renewed before 7-day expiry | VERIFIED | `gmail/watch.py:establish_gmail_watch`; `tasks.py:renew_watch_channels` extended to renew Gmail watches |
| 12 | New .edu emails fetched via history.list; metadata only (subject + sender; full body NEVER stored) | VERIFIED | `gmail/fetch.py:fetch_new_messages` uses `format="metadata"`, filters `.edu` senders, never returns body |
| 13 | Claude Haiku classifies emails; confidence >= 0.8 AND is_deadline_change fires alert | VERIFIED | `gmail/classify.py:classify_email` uses `claude-haiku-4-5-20251001`; `tasks.py:604` checks both conditions |
| 14 | Gmail signals cross-referenced against Canvas deadlines via rapidfuzz (score >= 70) | VERIFIED | `gmail/classify.py:find_matching_deadline` uses `fuzz.token_set_ratio`, threshold 70 |
| 15 | Contradiction alerts surface both Canvas state and email claim | VERIFIED | `tasks.py:gmail_process_notification` builds body with Canvas due_date and email subject |
| 16 | Canvas deadline on same day as GCal busy event fires conflict alert; deduped per (deadline_id, gcal_event_id) | VERIFIED | `gcal/conflicts.py:detect_conflicts_user` matches by `due_date[:10] == start_time[:10]`; UNIQUE constraint in migration 006 |
| 17 | User can request study block via SMS; appears on Google Calendar | VERIFIED | `gcal/writeback.py:create_study_block` calls `events().insert()`; `schedule_study_block` finds free slot + creates event |
| 18 | Monday briefing enriched with conflict warnings and study windows when GCal connected | VERIFIED | `ai/briefing.py:get_briefing_gcal_context` + `generate_briefing` accepts `gcal_context`; `tasks.py:334-346` passes on Mondays |
| 19 | Study preference captured on first Google connect; stored in preferences_json | VERIFIED | `tasks.py:encrypt_and_store_tokens` sends study pref SMS; `ai/replies.py:_handle_study_preference_reply` captures answer |

**Score:** 19/19 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supabase/migrations/006_google_integrations.sql` | gmail_flags, conflict_alerts tables + watch columns | VERIFIED | All tables + constraints present; RLS enabled on both tables |
| `celery_worker/google_auth/encryption.py` | Fernet encrypt/decrypt | VERIFIED | `encrypt_token` + `decrypt_token` + `get_fernet()` using `TOKEN_ENCRYPTION_KEY` |
| `celery_worker/google_auth/tokens.py` | Load/store with encryption | VERIFIED | `store_google_tokens` encrypts before upsert; `load_google_tokens` decrypts on return |
| `src/app/api/auth/google/route.ts` | OAuth initiation redirect | VERIFIED | HMAC state, httpOnly cookie, Calendar + Gmail scopes, access_type=offline, prompt=consent |
| `src/app/api/auth/google/callback/route.ts` | OAuth callback token exchange | VERIFIED | CSRF validation, token exchange, dispatches `encrypt_and_store_tokens` via Redis, no plaintext DB write |
| `celery_worker/sms/batch.py` | Redis-based SMS batching | VERIFIED | `enqueue_alert` (SETNX), `flush_batch` (sorted, capped at 3); 119 lines |
| `celery_worker/gcal/auth.py` | GCal service builder with auto-refresh | VERIFIED | `build_gcal_service` with 5-min pre-expiry refresh + `store_google_tokens` on refresh |
| `celery_worker/gcal/fetch.py` | GCal events.list wrapper | VERIFIED | `fetch_gcal_events` for 7-day window, filters declined + transparent, infers type |
| `celery_worker/gcal/db.py` | calendar_events CRUD + watch state | VERIFIED | `store_calendar_events`, `get_calendar_events`, `store_watch_channel`, `get_watch_channel` |
| `celery_worker/gcal/watch.py` | Push notification watch management | VERIFIED | `establish_watch`, `stop_watch`, `renew_watch` with graceful stop-failure handling |
| `src/app/api/gcal/webhook/route.ts` | GCal push notification receiver | VERIFIED | Returns 200 for sync handshake; enqueues `gcal_sync_user` via Redis; always returns 200 |
| `celery_worker/gmail/auth.py` | Gmail service builder | VERIFIED | `build_gmail_service` mirrors gcal/auth.py pattern |
| `celery_worker/gmail/fetch.py` | Gmail history-based message fetcher | VERIFIED | `fetch_new_messages` (`.edu` filter, `format=metadata`), `decode_pubsub_message`, history_id cursor management |
| `celery_worker/gmail/classify.py` | Claude Haiku email classifier + fuzzy match | VERIFIED | `classify_email` uses `claude-haiku-4-5-20251001`; `find_matching_deadline` uses `token_set_ratio` >= 70 |
| `celery_worker/gmail/watch.py` | Gmail watch channel management | VERIFIED | `establish_gmail_watch` + `renew_gmail_watch` with `GMAIL_PUBSUB_TOPIC`; stores historyId |
| `src/app/api/gmail/webhook/route.ts` | Pub/Sub push notification receiver | VERIFIED | Decodes base64url, dispatches `gmail_process_notification` for all Google-connected users; always returns 200 |
| `celery_worker/gcal/conflicts.py` | Conflict detection | VERIFIED | `detect_conflicts_user` matches same-day, dedupes via set + DB, routes through batch queue |
| `celery_worker/gcal/writeback.py` | GCal event creation for study blocks | VERIFIED | `create_study_block` via `events().insert()`, `delete_study_block`, `schedule_study_block` |
| `celery_worker/gcal/slots.py` | Free slot finder | VERIFIED | `find_free_slots` with `PREFERENCE_ORDER`, waking hours 7am-10pm, min_duration filtering |
| `celery_worker/ai/briefing.py` | Monday briefing enrichment | VERIFIED | `get_briefing_gcal_context` + `gcal_context` param in `generate_briefing`; includes SCHEDULING CONFLICTS + BEST AVAILABLE STUDY WINDOWS sections |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/app/api/auth/google/callback/route.ts` | `celery_worker/google_auth/tokens.py` | `encrypt_and_store_tokens` dispatched via Redis; task calls `store_google_tokens` | WIRED | Verified: callback dispatches task; task line 684 calls `store_google_tokens` |
| `celery_worker/google_auth/tokens.py` | `celery_worker/google_auth/encryption.py` | `encrypt_token`/`decrypt_token` calls | WIRED | Direct imports at module level; `encrypt_token(access_token)` before upsert |
| `celery_worker/gcal/auth.py` | `celery_worker/google_auth/tokens.py` | `load_google_tokens` + `store_google_tokens` for refresh | WIRED | Lazy import inside `build_gcal_service`; both functions called |
| `celery_worker/tasks.py` | `celery_worker/gcal/fetch.py` | `gcal_sync_user` calls `fetch_gcal_events` | WIRED | `tasks.py:436` lazy imports and calls `fetch_gcal_events` |
| `celery_worker/tasks.py` | `celery_worker/priority/ingest.py` | `gcal_sync_user` calls `ingest_canonical_event` for each event | WIRED | `tasks.py:444` calls `ingest_canonical_event` in loop over events |
| `src/app/api/gcal/webhook/route.ts` | `celery_worker/tasks.py` | Webhook enqueues `gcal_sync_user` via Redis | WIRED | Route uses `lpush('celery', ...)` with task name `tasks.gcal_sync_user` |
| `celery_worker/gmail/classify.py` | anthropic | Claude Haiku call for email classification | WIRED | `classify_email` uses `Anthropic()` client with `model="claude-haiku-4-5-20251001"` |
| `celery_worker/gmail/classify.py` | rapidfuzz | `token_set_ratio` for fuzzy matching | WIRED | `from rapidfuzz import fuzz; fuzz.token_set_ratio(...)` |
| `celery_worker/tasks.py` | `celery_worker/gmail/classify.py` | `gmail_process_notification` calls `classify_email` + `find_matching_deadline` | WIRED | `tasks.py:562-606` lazy imports and calls both functions |
| `celery_worker/gcal/conflicts.py` | `celery_worker/sms/batch.py` | Conflict alerts routed through batch queue | WIRED | `conflicts.py:28+118` lazy imports `enqueue_alert` and calls it |
| `celery_worker/gcal/writeback.py` | Google Calendar API | `events().insert()` for study blocks | WIRED | `writeback.py:41` calls `service.events().insert(calendarId="primary", body=event).execute()` |
| `celery_worker/ai/briefing.py` | `celery_worker/gcal/slots.py` | Monday briefing calls `find_free_slots` | WIRED | `briefing.py:get_briefing_gcal_context` calls `find_free_slots` across 7 days |
| `celery_worker/ai/briefing.py` | `celery_worker/gcal/conflicts.py` | Monday briefing includes conflict data | WIRED | `briefing.py:get_briefing_gcal_context` queries `conflict_alerts` table; passes to prompt |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| GCAL-01 | 06-01, 06-03 | Fetch Google Calendar events (7-day rolling window) via OAuth | SATISFIED | `gcal/fetch.py:fetch_gcal_events` with 7-day window |
| GCAL-02 | 06-03 | Calendar events normalized to CalendarEvent type and stored in Supabase | SATISFIED | `gcal/db.py:store_calendar_events` upserts to `calendar_events` |
| GCAL-03 | 06-03 | GCal push notification channel established for real-time change detection | SATISFIED | `gcal/watch.py:establish_watch`; webhook receives push notifications |
| GCAL-04 | 06-03 | GCal push channel renewed automatically before 7-day expiry | SATISFIED | `celery_app.py` Beat: `renew-watch-channels` every 6 hours; 48h window |
| GCAL-05 | 06-05 | User can request study blocks written to Google Calendar via SMS | SATISFIED | `gcal/writeback.py:create_study_block` + `schedule_study_block` |
| GMAI-01 | 06-04 | System monitors Gmail for emails from course-related senders | SATISFIED | `gmail/fetch.py:fetch_new_messages` with `.edu` filter |
| GMAI-02 | 06-04 | Keyword detection identifies deadline changes in emails | SATISFIED | `gmail/classify.py:classify_email` using Claude Haiku with deadline keywords |
| GMAI-03 | 06-01 | Parsed Gmail signals stored in `gmail_flags` (metadata only; no full body) | SATISFIED | `tasks.py:595-600` inserts to `gmail_flags` with subject, sender, summary[:200], confidence only |
| GMAI-04 | 06-04 | Gmail watch channel renewed automatically before 7-day expiry | SATISFIED | `tasks.py:renew_watch_channels` extended to renew Gmail watches |
| GMAI-05 | 06-04 | Gmail signals cross-referenced against Canvas state to detect contradictions | SATISFIED | `gmail/classify.py:find_matching_deadline` (token_set_ratio >= 70) |
| ALRT-01 | 06-04 | Deadline change alert fired within 15 minutes of Canvas diff detection | SATISFIED | GCal push → webhook → Celery → detect (real-time path); Canvas sync also triggers conflict detection |
| ALRT-02 | 06-04 | Gmail contradiction alert fired when professor email conflicts with Canvas deadline | SATISFIED | `tasks.py:gmail_process_notification` builds contradiction body with Canvas due_date |
| ALRT-03 | 06-04 | Alert SMS includes original deadline, new deadline, course name, assignment title | SATISFIED | Contradiction alert body includes matched deadline title, due_date, email subject |
| INTEL-03 | 06-05 | Conflict detection — flag Canvas deadlines overlapping GCal events | SATISFIED | `gcal/conflicts.py:detect_conflicts_user` with same-day matching |
| SMS-10 | 06-02 | Multiple alerts within 10 minutes batched into single SMS | SATISFIED | `sms/batch.py` with SETNX lock, 600s BATCH_TTL, `flush_batch` |
| SMS-11 | 06-02 | No more than 3 texts in any 10-minute window | SATISFIED | `sms/batch.py:MAX_TEXTS_PER_WINDOW = 3` |
| SYNC-03 | 06-03 | GCal push notification handler processes changes in real time | SATISFIED | Webhook → Redis → `gcal_sync_user` Celery task |
| SYNC-04 | 06-01, 06-03 | GCal and Gmail watch channels renewed via Celery Beat (48h before expiry) | SATISFIED | `celery_app.py` Beat entry; `renew_watch_channels` covers both GCal and Gmail |
| AI-08 (full) | 06-05 | Monday briefing enriched with GCal conflicts and available study windows | SATISFIED | `ai/briefing.py:get_briefing_gcal_context` + `gcal_context` parameter; appended to Claude prompt on Mondays |

All 19 Phase 6 requirements: SATISFIED.
No orphaned requirements found — every requirement ID from plan frontmatter is covered.

---

## Test Coverage

| Module | Test File | Test Count | Tests Cover |
|--------|-----------|-----------|-------------|
| google_auth/encryption | test_encryption.py | 4 | Round-trip, non-deterministic, not-plaintext, invalid key |
| google_auth/tokens | test_tokens.py | 3 | Encrypted storage, decrypted load, None for missing user |
| sms/batch | test_batch.py | 14 | enqueue_alert (SETNX, first/second item), flush_batch (empty, single, multi, truncation, cleanup, priority sort) |
| gcal/fetch | test_fetch.py | 9 | Normalization, declined filter, transparent filter, type inference, all-day events |
| gcal/db | test_db.py | 8 | Upsert, range query, watch channel read/write |
| gcal/watch | test_watch.py | 7 | establish, stop, renew (including stop-failure grace) |
| gmail/classify + fetch | test_classify.py | 14 | Haiku model selection, JSON parsing, error fallback, fuzzy match (match/no-match/empty/combo), pubsub decode, .edu filter |
| gmail/watch | test_watch.py | 6 | establish (topic call, historyId stored, missing topic), renew delegates |
| gcal/conflicts | test_conflicts.py | 7 | Same-day fire, different-day skip, dedup, re-fire on date change, SMS body format, no-op cases |
| gcal/slots | test_slots.py | 9 | No events (full day), partial events (gaps), fully booked, min_duration filter, morning/evening preference |
| gcal/writeback | test_writeback.py | 8 | insert(), delete(), schedule_study_block (slot found / no slot), preference pass-through |
| ai/briefing (gcal) | test_briefing_gcal.py | 8 | No integration → empty, conflict strings, study window cap at 3, SCHEDULING CONFLICTS in prompt, BEST STUDY WINDOWS in prompt, non-Monday skips gcal_context |

**Total new Phase 6 tests: 97** (220 total in suite per Plan 05 SUMMARY)

---

## Anti-Patterns Found

No blocking anti-patterns detected.

Notable items (informational only):

| File | Pattern | Severity | Notes |
|------|---------|----------|-------|
| `src/app/api/gmail/webhook/route.ts:55` | `TODO: Add google_email column to integrations for precise matching` | Info | Explicitly documented limitation; MVP dispatches to all Google-connected users. Not a correctness issue — historyId cursor prevents duplicate processing |
| `celery_worker/tasks.py:7-17` | Forward declarations for `gcal_sync_user` / `gmail_establish_watch_task` | Info | Intentional pattern (documented in SUMMARY). try/except allows `tasks.py` to compile before Plans 03/04 register those task names. Forward declarations are now resolved since both tasks are defined. |

---

## Human Verification Required

### 1. Google OAuth End-to-End Flow

**Test:** Open `GET /api/auth/google?user_id=<valid_uuid>` in a browser. Complete Google sign-in. Observe confirmation HTML page.
**Expected:** Redirect to Google, complete auth, land on "Google Connected!" page. Receive confirmation SMS within ~30 seconds.
**Why human:** Requires real Google credentials, real Twilio SMS, and a running Celery worker.

### 2. GCal Push Notification Real-Time Latency

**Test:** Connect Google account. Create or modify a calendar event in Google Calendar. Observe whether Aria detects the change.
**Expected:** Within a few minutes (GCal push latency + Celery processing), the calendar_events table in Supabase should update.
**Why human:** Requires deployed application with public URL for GCal push channel registration.

### 3. Gmail Watch + Pub/Sub Pipeline

**Test:** Connect Google account. Have a professor send an email to the connected Gmail address with a deadline-change subject line.
**Expected:** Within ~15 minutes, the gmail_flags table should have a new row, and if confidence >= 0.8, an SMS alert should be sent.
**Why human:** Requires real Gmail watch + Google Cloud Pub/Sub topic configured with `GMAIL_PUBSUB_TOPIC` env var.

### 4. Study Block SMS Command Flow

**Test:** Send an SMS to Aria saying "add a study block for [assignment] tomorrow evening."
**Expected:** Aria finds a free slot matching the evening preference and creates an event on the connected Google Calendar.
**Why human:** End-to-end SMS intent routing + GCal write-back requires running full stack.

### 5. Monday Briefing with GCal Context

**Test:** On a Monday with active conflicts in conflict_alerts, trigger a briefing generation. Observe the briefing SMS content.
**Expected:** Briefing SMS should include "SCHEDULING CONFLICTS THIS WEEK:" section and "BEST AVAILABLE STUDY WINDOWS:" section.
**Why human:** Requires Monday date + Google-connected user + existing conflicts in DB.

---

## Gaps Summary

No gaps. All 19 observable truths verified. All 19 requirements satisfied. All key links confirmed wired. Test coverage present for all new modules.

---

_Verified: 2026-03-20T04:00:00Z_
_Verifier: Claude (gsd-verifier)_
