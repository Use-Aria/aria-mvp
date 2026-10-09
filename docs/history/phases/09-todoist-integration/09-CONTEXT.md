# Phase 9: Todoist Integration - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Connect Todoist via OAuth, sync tasks into the Priority Engine's `canonical_events` table, include tasks in daily briefings, and enable full task CRUD (create/complete/update/delete) via SMS. This phase does NOT change the scoring formula (locked in Phase 5), add Todoist to web onboarding, or implement syllabus-to-task matching (Phase 7 concern).

</domain>

<decisions>
## Implementation Decisions

### OAuth Connection
- Entry point: iOS Preferences page only (Phase 8 Preferences screen already exists — add a "Connect Todoist" button)
- No web onboarding path for Todoist in MVP
- OAuth handshake: `WebBrowser.openAuthSessionAsync` — same pattern as Google OAuth in Phase 8
- Token exchange handled by a new Next.js API route (`/api/auth/todoist/callback`)
- Scope: `data:read_write` — required for task creation and completion via SMS
- Access + refresh tokens stored AES-256 encrypted in `integrations` table (same pattern as Google OAuth)

### Task Sync Scope
- Sync all active (non-completed) Todoist tasks that have a due date set
- Tasks without due dates are ignored — no due date means urgency = undefined, nothing to score
- Sync frequency: every 2 hours via Celery Beat (new `todoist_sync_all` → `todoist_sync_user` fan-out)
- Same delivery routing as Canvas: score ≥ 80 → immediate SMS; 50–79 → digest; < 50 → silent
- `grade_weight = 0.0` for all Todoist tasks by default; Phase 7 syllabus matching may update this later
- `source_authority = 0.8` (locked — Phase 5 Priority Engine formula)

### Task CRUD via SMS
- All actions handled via natural language through the existing Claude Sonnet conversational handler (Phase 4 AI-07 pattern)
- Supported actions: create task, complete task, update due date, delete task
- Claude extracts intent + task title + due date from free-text SMS; calls Todoist REST API; confirms back
- Confirmation format: brief + action summary
  - Create: "Done — added 'Buy textbook' to Todoist, due Friday."
  - Complete: "Marked 'PSET 3' complete in Todoist."
  - Update: "Moved 'PSET 3' to Friday in Todoist."
  - Delete: "Deleted 'Buy textbook' from Todoist."
- If task disambiguation is needed (multiple tasks match title), Claude asks: "Which one — 'Buy textbook for CPSC 365' (due Fri) or 'Buy textbook for MATH 120' (due Mon)?"

### Briefing Display
- Todoist tasks interleaved with Canvas deadlines in briefing — all items sorted by `priority_score` descending from `canonical_events`
- No separate "Personal tasks" section; source label included inline (e.g., "PSET 3 (Canvas, due 5pm)")
- `get_events_for_briefing()` already reads `canonical_events` — no briefing query changes needed, Todoist events appear automatically

### Task Overload Detection
- Threshold: 5 or more items (Todoist P1 tasks + Canvas deadlines) due within the next 24 hours
- Overload warning appears as a single line at the top of the morning briefing SMS
- Format: "⚠️ Heavy day — 5 items due today. Prioritize: [top 2 by priority_score]."
- Detection runs during briefing generation in `generate_briefing()` — count items from `canonical_events` where `due_at` is within 24 hours of briefing time

### Claude's Discretion
- Exact Todoist API client library (requests vs. todoist-api-python SDK)
- Celery retry policy for Todoist sync failures
- How to handle Todoist token expiry (Todoist tokens don't expire but can be revoked — handle 403 gracefully)
- Exact overload threshold tuning (5 is the starting point; adjust based on beta feedback)
- Index strategy for Todoist rows in `canonical_events`

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Task requirements
- `.planning/REQUIREMENTS.md` §Task Management — TASK-01, TASK-02 define OAuth, sync, and briefing inclusion requirements

### Priority Engine integration
- `celery_worker/priority/ingest.py` — `ingest_canonical_event()` is the ONLY entry point for writing to `canonical_events`; Todoist sync must call this, not write directly
- `celery_worker/priority/engine.py` — scoring formula and source_authority constants; Todoist = 0.8 is already defined here

### Briefing integration
- `celery_worker/ai/db.py` — `get_events_for_briefing()` already reads `canonical_events`; Todoist tasks appear automatically once ingested; `generate_briefing()` is the overload detection insertion point

### Existing OAuth + sync patterns (reference implementations)
- `src/app/api/sync/canvas/route.ts` — Next.js API route pattern; Todoist callback follows same structure
- `celery_worker/tasks.py` — `canvas_sync_all` → `canvas_sync_user` fan-out pattern; Todoist sync mirrors this
- `celery_worker/canvas/` — fetch/parse/diff/db modules; Todoist follows same 4-module structure under `celery_worker/todoist/`

### iOS OAuth pattern
- `mobile/src/` — Phase 8 Google OAuth implementation using `WebBrowser.openAuthSessionAsync`; Todoist OAuth follows the same pattern in Preferences screen

No external specs — Todoist REST API v2 docs are the authoritative reference for API calls.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `celery_worker/priority/ingest.py`: `ingest_canonical_event()` — single function call with `source='todoist'` handles all scoring, routing, and upsert
- `celery_worker/tasks.py`: `canvas_sync_all` + `canvas_sync_user` fan-out — copy this pattern for `todoist_sync_all` + `todoist_sync_user`
- `celery_worker/ai/db.py`: `get_events_for_briefing()` — no changes needed; Todoist tasks appear automatically
- `celery_worker/sms/send.py`: `send_sms_direct()`, `send_sms_safe()`, `send_sms_alert()` — confirmation SMS uses `send_sms_safe()` (task action confirmations are conversational, not alerts)
- Phase 8 iOS Preferences screen — add "Connect Todoist" button alongside existing Google OAuth entry

### Established Patterns
- All integrations: `fetch.py` (raw API), `parse.py` (normalize to types), `db.py` (Supabase writes), `sync.py` (orchestrate) — create `celery_worker/todoist/` with this 4-module structure
- OAuth tokens: stored in `integrations` table (`platform='todoist'`, `access_token` encrypted, `synced_at` updated after each sync)
- Celery task naming: `tasks.todoist_sync_user`, `tasks.todoist_sync_all`
- Celery Beat schedule: add `todoist_sync_all` cron at every 2 hours alongside existing `canvas_sync_all`

### Integration Points
- `celery_worker/tasks.py` — add `todoist_sync_all`, `todoist_sync_user`, and Todoist task action helpers
- `src/app/api/` — new route `/api/auth/todoist/callback` for OAuth token exchange
- `celery_worker/ai/` — `generate_briefing()` gets overload detection logic (count `canonical_events` due within 24h)
- `mobile/src/screens/preferences/` (or equivalent) — "Connect Todoist" button triggers `WebBrowser.openAuthSessionAsync`
- `supabase/migrations/` — no schema changes needed (canonical_events and integrations tables already support Todoist)

</code_context>

<specifics>
## Specific Ideas

No specific design references — standard Todoist REST API v2 integration following established codebase patterns.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 09-todoist-integration*
*Context gathered: 2026-03-19*
