# Phase 3: Twilio SMS + TCPA Compliance - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Upgrade the Phase 1 webhook stub into a full SMS pipeline: outbound sending via Twilio, inbound webhook with signature validation, TCPA compliance enforcement (opt-out, quiet hours, daily proactive cap), and keyword command handling (STOP/START/PAUSE/HELP). Every TCPA safeguard must be active before the first outbound message leaves — Phase 4 (briefings) and Phase 5 (alerts) build on this send layer.

Out of scope: Claude conversational replies (Phase 4), natural-language opt-out ("turn off my messages") (Phase 4), app toggle for opt-out (Phase 7 frontend).

</domain>

<decisions>
## Implementation Decisions

### TCPA enforcement architecture
- **Centralized guard**: a single `send_sms_safe()` function in Python (`celery_worker/sms/`) that all senders call. Opt-out check, quiet hours check, and daily cap check happen in one place — impossible to accidentally bypass when adding future senders (Phase 4 briefings, Phase 5 alerts).
- When `send_sms_safe()` is blocked (opted out, quiet hours, or cap hit): **drop silently + write a structured log entry** (reason, hashed user_id, timestamp). No retry. No DB record for suppressed messages. Simple and auditable.
- The actual Twilio REST API call is wrapped inside `send_sms_safe()` — callers never import the Twilio client directly.

### TCPA state storage
- **Dedicated columns on `users` table** (new migration):
  - `sms_opted_out BOOLEAN NOT NULL DEFAULT false`
  - `sms_opted_out_at TIMESTAMPTZ` (nullable — records when opt-out occurred)
  - `daily_sms_count INT NOT NULL DEFAULT 0` (proactive messages sent today)
  - `daily_sms_date DATE` (the local date the count applies to — resets on mismatch)
  - `quiet_hours_start TIME DEFAULT '22:00'` (user-configurable, defaults to 10pm)
  - `quiet_hours_end TIME DEFAULT '08:00'` (user-configurable, defaults to 8am)
- **NOT in `preferences_json`** — these fields are queried on every send, must be indexable without JSON parsing.
- User timezone stored in `preferences_json` (already exists in schema) — used to evaluate quiet hours and daily count reset.

### Daily proactive message cap
- Cap covers **proactive/unsolicited messages only**: daily briefings and deadline alerts. Replies to user-initiated texts are **uncapped** — the user started the conversation (not "unsolicited" under TCPA intent).
- `daily_sms_count` tracks proactive sends only. Conversational replies do not increment it.
- Count resets at **midnight in the user's local timezone**. Implementation: compare `daily_sms_date` (stored as the user's local date) to today's local date on each send. If mismatched, reset count to 0 before checking cap.
- Cap limit: 3 proactive messages/day per user.

### Opt-out and re-opt-in commands
- Aria is a **conversational service, not a marketing sender**. App toggle (Phase 7) + Claude conversational opt-out ("turn off messages", Phase 4) are the primary UX paths.
- **STOP and START are carrier compliance requirements only** (non-negotiable for 10DLC) — handled as quiet safety nets, not surfaced as primary features.
- STOP: set `sms_opted_out=true`, `sms_opted_out_at=now()`. Send one final confirmation SMS: "You've been unsubscribed from Aria. Text START to resubscribe." Then silence.
- START: set `sms_opted_out=false`, clear `sms_opted_out_at`. Send confirmation: "Welcome back to Aria."
- PAUSE: set a `sms_paused_until TIMESTAMPTZ` column (24 hours from now). `send_sms_safe()` checks this alongside opt-out.
- HELP: reply with command list in a single SMS.
- All keyword matching is case-insensitive, exact match on trimmed message body.

### Inbound webhook (upgrade from Phase 1 stub)
- Location: `src/app/api/sms/webhook/route.ts` (already exists as stub — upgrade in place).
- **Twilio signature validation**: strict in production, bypassed in dev via `TWILIO_DEV_BYPASS=true` env var.
  - If signature invalid in production: return **HTTP 403** + log warning (structured log, no phone numbers). Spoofed requests are not from Twilio so no retries will occur.
  - Always return **HTTP 200** to legitimate Twilio requests (even on processing errors) to prevent Twilio retries.
- On valid inbound: return 200 immediately, then enqueue a Celery task for processing. **Never call Claude or do heavy work synchronously in the webhook.**
- Inbound message logged to `messages` table with `direction='in'` before enqueueing.

### Python SMS module structure
- New module: `celery_worker/sms/` (parallel to `celery_worker/canvas/`)
  - `celery_worker/sms/send.py` — `send_sms_safe()` guard + Twilio REST call
  - `celery_worker/sms/commands.py` — keyword detection and command dispatch (STOP/START/PAUSE/HELP)
- New Celery task: `tasks.process_inbound_sms(message_sid, body, from_hash)` — reads message, dispatches to commands.py, routes non-command messages to future Claude handler (Phase 4 stub).

### Claude's Discretion
- Exact Twilio RequestValidator implementation details
- `sms_paused_until` column type and index (add to same migration as other TCPA columns)
- HELP reply message copy
- Logging format for suppressed messages (structured JSON recommended)
- Whether to use `twilio-python` SDK or raw REST calls (SDK recommended)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project architecture & code style
- `CLAUDE.md` — Integration patterns, Twilio webhook rules (must return 200 in <1s, never inline Claude), phone number logging prohibition, team ownership boundaries, env var list
- `src/types/index.ts` — `Message` type definition that inbound/outbound SMS must normalize to

### Database schema
- `supabase/migrations/001_initial_schema.sql` — `users` table (Phase 3 adds TCPA columns via new migration), `messages` table (direction, body, sent_at, trigger_type)
- `supabase/migrations/002_deadlines_soft_delete.sql` — Pattern to follow for Phase 3 TCPA migration

### Existing Phase 1 stub to upgrade
- `src/app/api/sms/webhook/route.ts` — Current stub; Phase 3 adds signature validation, DB write, and Celery enqueue

### Existing Celery patterns
- `celery_worker/tasks.py` — Task structure to follow; `canvas_sync_user` pattern for the new `process_inbound_sms` task
- `celery_worker/celery_app.py` — App config; new `sms` module must be registered in `include`
- `celery_worker/canvas/` — Module structure to replicate for `celery_worker/sms/`

### Requirements
- `.planning/REQUIREMENTS.md` — SMS-01 through SMS-09, SYNC-02 (the 10 requirements this phase implements)
- `.planning/ROADMAP.md` §Phase 3 — Success criteria (5 items), dependency on Phase 2

### TCPA compliance context
- No external spec doc — requirements fully captured in decisions above. Key constraint: 10DLC carriers require STOP/START handling regardless of marketing classification.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/app/api/sms/webhook/route.ts` — Upgrade target; already handles `request.text()` parse, always-200 error handling, and phone-number-free logging pattern
- `celery_worker/tasks.py` — `canvas_sync_user` is the pattern for the new `process_inbound_sms` task (bind=True, named task, returns dict)
- `celery_worker/celery_app.py` — Add `"sms"` or new task module to `include` list
- `src/lib/supabase/server.ts` — Server-side Supabase client for Next.js webhook route DB writes

### Established Patterns
- All heavy processing in Python Celery — Next.js webhook returns 200 and enqueues
- Module structure: `celery_worker/[domain]/` with `fetch.py`, `parse.py`, `db.py` sub-files (Canvas pattern to replicate for SMS)
- All due dates/timestamps stored as UTC TIMESTAMPTZ
- Phone numbers never in logs — use hashed user_id for observability

### Integration Points
- `messages` table: Phase 3 is the writer for inbound and outbound records; Phase 4 reads outbound history for context
- `users` table: Phase 3 adds TCPA columns via migration; `send_sms_safe()` reads these on every outbound call
- `celery_app.beat_schedule`: Phase 4 will add briefing tasks; Phase 3's `send_sms_safe()` is what those tasks call

</code_context>

<specifics>
## Specific Ideas

- Aria is a **conversational assistant, not a marketing sender** — STOP/START keyword handling is carrier compliance infrastructure, not a product feature. The real opt-out UX is the in-app toggle (Phase 7) and Claude conversational handling (Phase 4).
- The `send_sms_safe()` centralized guard is the single most important abstraction in this phase — every future sender (briefings, alerts, replies) routes through it, so TCPA enforcement can never be accidentally bypassed.

</specifics>

<deferred>
## Deferred Ideas

- Natural-language opt-out ("turn off my messages") — Phase 4 when Claude is integrated
- In-app toggle for SMS on/off — Phase 7 frontend
- Conversation reply abuse cap (e.g., 10 AI replies/day) — consider for Phase 4 if needed

</deferred>

---

*Phase: 03-twilio-sms-tcpa-compliance*
*Context gathered: 2026-03-19*
