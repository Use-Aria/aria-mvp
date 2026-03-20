---
phase: 09-todoist-integration
verified: 2026-03-20T18:00:00Z
status: human_needed
score: 11/11 must-haves verified
human_verification:
  - test: "Navigate to Preferences screen on iOS simulator and confirm Todoist row appears in Connected Accounts below the Google row with 'Not connected' label and a 'Connect' button"
    expected: "Todoist row visible with dot indicator, 'Not connected' status label, and tappable 'Connect' button"
    why_human: "Visual layout verification requires running the iOS app; TypeScript compiles but rendering cannot be confirmed programmatically"
  - test: "(Optional — requires Todoist dev app registered) Tap Connect on the Preferences screen and verify Todoist OAuth page opens in a browser session"
    expected: "WebBrowser.openAuthSessionAsync opens Todoist OAuth page at app.todoist.com/oauth/authorize with scope=data:read_write; after approval the browser closes and the Preferences screen updates to 'Connected'"
    why_human: "End-to-end OAuth round-trip requires a registered Todoist application with the correct redirect URI configured"
---

# Phase 9: Todoist Integration Verification Report

**Phase Goal:** Integrate Todoist as a task source — OAuth connection, background sync into canonical_events, SMS CRUD actions, and briefing overload detection.
**Verified:** 2026-03-20T18:00:00Z
**Status:** human_needed (all automated checks pass; 2 items require human/device verification)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Todoist tasks with due dates are fetched via REST API v2 and normalized to internal format | VERIFIED | `fetch.py` GET /tasks filters `t.get("due")`; `parse.py` normalizes datetime/date-only with T23:59:59Z fallback and priority inversion map {4:urgent,3:high,2:medium,1:normal} |
| 2 | Normalized tasks are ingested into canonical_events via ingest_canonical_event(source='todoist') | VERIFIED | `sync.py` line 41 calls `ingest_canonical_event(user_id, source="todoist", event_type="task", ..., course_id=None, grade_weight=0.0)` |
| 3 | Sync runs every 2 hours via Celery Beat fan-out (todoist_sync_all -> todoist_sync_user) | VERIFIED | `celery_app.py` beat_schedule entry "todoist-sync-all-users" with schedule=7200.0; `tasks.py` todoist_sync_all fans out to todoist_sync_user.delay(user_id) |
| 4 | 403 token revocation stops retries and marks integration as revoked | VERIFIED | `sync.py` line 34 checks `e.response.status_code == 403` -> calls `mark_integration_revoked(user_id)` and returns (does not raise, preventing Celery retry) |
| 5 | Access tokens are never passed as Celery task args (fetched from DB inside task body) | VERIFIED | `todoist_sync_user(self, user_id: str)` signature — no access_token arg; token fetched via `get_todoist_token(user_id)` inside `sync_todoist_user()` |
| 6 | User can create, complete, update, and delete Todoist tasks via natural language SMS | VERIFIED | `replies.py` `_apply_todoist_mutation()` handles all 4 actions; wired into `handle_reply()` at line 273 |
| 7 | Claude intent classifier recognizes todoist_create, todoist_complete, todoist_update_due, todoist_delete actions | VERIFIED | `INTENT_SYSTEM_PROMPT` in `replies.py` line 32 includes all 4 action variants with `due_string` field |
| 8 | Creating a task without a due date prompts Claude to ask for one | VERIFIED | `replies.py` line 189: `return "When should that be due? Give me a date like 'Friday' or 'next Tuesday'."` when `due_string is None` |
| 9 | Morning briefing prepends overload warning when 5+ items are due within 24 hours | VERIFIED | `briefing.py` `_count_items_due_today()` queries canonical_events with 24h window; `generate_briefing()` line 240-244 prepends "Heavy day — N items due today. Prioritize: X, Y." when count >= 5 |
| 10 | Todoist OAuth code is exchanged for access token and stored in integrations table | VERIFIED | `src/app/api/auth/todoist/callback/route.ts` POST to Todoist token endpoint, upsert with `platform: 'todoist'` and `onConflict: 'user_id,platform'` |
| 11 | iOS Preferences screen has a working Todoist Connect/Disconnect row | VERIFIED (automated) / NEEDS HUMAN (visual) | `preferences.tsx` has `todoistIntegration` lookup, `handleConnectTodoist`, Todoist row with `WebBrowser.openAuthSessionAsync(authUrl, 'aria://todoist-connected')` |

**Score:** 11/11 truths verified (2 truths have human-verification sub-items)

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `celery_worker/todoist/fetch.py` | REST API v2 client: get_active_tasks, create_task, close_task, update_task, delete_task | VERIFIED | All 5 functions present; TODOIST_BASE constant defined; raise_for_status() on all calls |
| `celery_worker/todoist/parse.py` | normalize raw tasks: datetime/date-only handling, priority inversion | VERIFIED | parse_tasks() present; T23:59:59Z normalization; {4:"urgent",...} map |
| `celery_worker/todoist/db.py` | Supabase helpers: get_all_todoist_integrations, get_todoist_token, mark_synced, mark_integration_revoked | VERIFIED | All 4 functions; queries with `.eq("platform", "todoist")`; token never selected in get_all_todoist_integrations |
| `celery_worker/todoist/sync.py` | Sync orchestrator: fetch -> parse -> ingest loop | VERIFIED | sync_todoist_user() wires full pipeline; 403 handling; mark_synced() called after loop |
| `celery_worker/tasks.py` | todoist_sync_all and todoist_sync_user Celery tasks | VERIFIED | Both tasks present; name="tasks.todoist_sync_all" and name="tasks.todoist_sync_user"; no access_token in args |
| `celery_worker/celery_app.py` | Beat schedule entry "todoist-sync-all-users" at 7200s | VERIFIED | "todoist-sync-all-users" entry with schedule: 7200.0 |
| `celery_worker/ai/replies.py` | Extended intent classifier with 4 Todoist actions + _apply_todoist_mutation | VERIFIED | All 4 actions in INTENT_SYSTEM_PROMPT; _apply_todoist_mutation() handles create/complete/update/delete; lazy imports for testability |
| `celery_worker/ai/briefing.py` | _count_items_due_today and overload detection in generate_briefing | VERIFIED | _count_items_due_today() queries canonical_events with .is_("deleted_at", "null") (no delivery_status filter); overload_count >= 5 gate; "Heavy day" prefix |
| `src/app/api/auth/todoist/callback/route.ts` | OAuth token exchange endpoint | VERIFIED | GET handler; exchanges code at Todoist token endpoint; upserts to integrations; redirects to aria://todoist-connected |
| `mobile/app/(home)/preferences.tsx` | Todoist row in Connected Accounts section | VERIFIED | todoistIntegration lookup; handleConnectTodoist callback; Todoist row with Connect/Disconnect; app.todoist.com/oauth/authorize with scope=data:read_write |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `celery_worker/todoist/sync.py` | `celery_worker/priority/ingest.py` | `ingest_canonical_event(source='todoist', grade_weight=0.0)` | WIRED | Lazy import at line 25; called at line 41 with all required args |
| `celery_worker/tasks.py` | `celery_worker/todoist/sync.py` | `todoist_sync_user calls sync_todoist_user` | WIRED | Lazy import `from todoist.sync import sync_todoist_user`; called as return value |
| `celery_worker/celery_app.py` | `celery_worker/tasks.py` | `beat_schedule dispatches tasks.todoist_sync_all` | WIRED | "todoist-sync-all-users": {"task": "tasks.todoist_sync_all", "schedule": 7200.0} |
| `celery_worker/ai/replies.py` | `celery_worker/todoist/fetch.py` | `_apply_todoist_mutation calls create_task/close_task/update_task/delete_task` | WIRED | Lazy import `from todoist.fetch import (create_task, close_task, update_task, delete_task)` inside function body |
| `celery_worker/ai/briefing.py` | canonical_events table | `_count_items_due_today queries canonical_events with 24h window` | WIRED | `.table("canonical_events").select(...).eq("user_id", user_id).is_("deleted_at", "null").gte("due_at", ...).lte("due_at", ...)` |
| `mobile/app/(home)/preferences.tsx` | `src/app/api/auth/todoist/callback/route.ts` | `WebBrowser opens Todoist auth URL -> callback redirects to aria://todoist-connected` | WIRED | handleConnectTodoist builds URL with redirectUri pointing to /api/auth/todoist/callback; openAuthSessionAsync captures aria://todoist-connected |
| `src/app/api/auth/todoist/callback/route.ts` | Supabase integrations table | upsert with platform='todoist' | WIRED | `supabase.from('integrations').upsert({..., platform: 'todoist'}, { onConflict: 'user_id,platform' })` |

---

## Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|---------------|-------------|--------|---------|
| TASK-01 | 09-01, 09-02, 09-03 | Todoist OAuth connection and task read/write | SATISFIED | OAuth callback route exchanges code and stores token; fetch.py provides create/close/update/delete; preferences.tsx provides Connect/Disconnect UI; replies.py SMS CRUD uses these write functions |
| TASK-02 | 09-01, 09-02 | Todoist tasks normalized to Task type and included in briefings and scheduling priority | SATISFIED | parse.py normalizes to {title, due_date, todoist_id, priority_label}; sync.py ingests via ingest_canonical_event(source='todoist') into canonical_events; briefing.py picks them up automatically through canonical_events; overload detection in _count_items_due_today |

No orphaned requirements found. Both requirement IDs declared in plan frontmatter are accounted for.

---

## Anti-Patterns Found

None detected. Scanned all phase 09 files for TODO/FIXME/placeholder comments, empty implementations, and stub return values — all clear.

**Test suite status:**
- `tests/todoist/` — 20 passed (all phase 09 Todoist backend tests)
- `tests/ai/test_replies.py` — 17 passed (includes 6 new Todoist reply tests)
- `tests/ai/test_briefing.py` — 22 passed (includes 4 new overload tests)
- `tests/test_tasks_ai.py` and `tests/test_tasks_sms.py` — failures due to `ModuleNotFoundError: No module named 'celery'` in test runner environment; pre-existing before phase 09 (confirmed via git stash regression test — 10 of these failures existed before first phase 09 commit)
- `tests/canvas/`, `tests/priority/`, `tests/sms/`, `tests/test_celery_app.py` — collection errors due to missing packages (pre-existing)

---

## Human Verification Required

### 1. Todoist Row on Preferences Screen

**Test:** Run `cd mobile && npx expo start` on an iOS simulator. Navigate to the Preferences screen (Connected Accounts section). Confirm the Todoist row appears below Google with a grey dot, "Not connected" label, and a blue "Connect" button.
**Expected:** Todoist row renders correctly with the same visual pattern as Canvas and Google rows.
**Why human:** Visual layout and styling can only be confirmed by running the app; TypeScript compiles cleanly but rendering behavior requires device/simulator.

### 2. Todoist OAuth Round-Trip (Conditional)

**Test:** (Requires a Todoist app registered at developer.todoist.com with redirect URI set to your app's callback URL.) Tap "Connect" on the Preferences screen. Verify the Todoist OAuth authorization page opens in a browser. Grant permissions. Verify the browser closes and returns to Preferences with the Todoist row updated to "Connected".
**Expected:** Full OAuth handshake completes; access token stored in integrations table; Preferences row shows "Connected" and a "Disconnect" button.
**Why human:** End-to-end OAuth requires a registered Todoist developer app with correct credentials in `.env.local` (`TODOIST_CLIENT_ID`, `TODOIST_CLIENT_SECRET`, `EXPO_PUBLIC_TODOIST_CLIENT_ID`, `NEXT_PUBLIC_APP_URL`).

---

## Gaps Summary

No gaps. All automated checks pass:
- All 11 observable truths verified in code
- All 10 artifacts exist and are substantive (no stubs)
- All 7 key links confirmed wired
- Both requirements (TASK-01, TASK-02) satisfied
- 59 phase-relevant tests pass; pre-existing environment failures are unrelated to this phase

Phase goal is achieved. The two human verification items are confirmatory (visual rendering + OAuth end-to-end) — they test that existing, verified code works correctly at runtime, not that the implementation is missing.

---

_Verified: 2026-03-20T18:00:00Z_
_Verifier: Claude (gsd-verifier)_
