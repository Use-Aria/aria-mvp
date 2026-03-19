# Phase 5: Priority Engine + Canonical Timeline DB - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the unified `canonical_events` table that all Phase 6+ integrations write to, backfill existing Canvas deadlines into it, implement the priority scoring engine with urgency decay, and wire the delivery router (immediate SMS, next-digest queue, silent log). This phase does NOT implement Google OAuth or Gmail/GCal ingestion — those land in Phase 6 and write to the Canonical Store once it exists.

</domain>

<decisions>
## Implementation Decisions

### Canonical Store Architecture
- New `canonical_events` table — not an extension of `deadlines`
- `deadlines` table is kept as Canvas-specific source-of-truth; canvas sync continues writing there
- A backfill job copies existing Canvas deadline rows into `canonical_events` on Phase 5 deploy
- `ai/db.py` briefing queries switch to read from `canonical_events` going forward
- `canonical_events` schema (Phase 5): `id`, `user_id`, `source` (canvas/gcal/gmail/todoist), `type`, `title`, `due_at`, `course_id`, `grade_weight`, `priority_score` (computed on ingestion), `delivery_status` (immediate/digest/silent)
- Phase 6+ adds its own columns via incremental migrations when those integrations land

### Priority Score Formula
- Locked: `Priority = (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)`
- Source authority values (locked): Canvas = 1.0, professor email = 0.9, Todoist = 0.8
- Urgency function: `urgency = min(1.0, e^(-0.15 × days_remaining))` — aggressive decay
  - 14 days out → ~0.12 urgency; 7 days → ~0.35; 3 days → ~0.64; 1 day → ~0.86; 0 days → 1.0
  - Overdue (days_remaining < 0): clamped to urgency = 1.0

### Delivery Router
- Score ≥ 80: immediate SMS — fires within 60 seconds of ingestion
- Score 50–79: queued for next morning digest (always tomorrow's briefing, no same-night send)
- Score < 50: logged silently in `canonical_events`, visible in app only (Phase 8)

### Immediate Alerts + TCPA
- Score ≥ 80 alerts bypass quiet hours (10pm–8am) — sent immediately regardless of time
- Score ≥ 80 alerts are exempt from the 3 unsolicited messages/day cap (treated as transactional, same logic as STOP confirmation using `send_sms_direct`)
- A new `send_sms_alert()` function wraps `send_sms_direct` with alert-specific logic (opt-out check still applies — never bypass STOP)
- **TCPA note:** Bypassing quiet hours requires explicit opt-in consent language in onboarding (Phase 8): "I agree to receive time-sensitive deadline alerts at any hour." Flag this for Seb's onboarding copy.

### Claude's Discretion
- Exact backfill job implementation (Celery task vs. migration script)
- Index strategy for `canonical_events` (covering index for delivery_status queries)
- How `delivery_status` is updated after a digest includes the event

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Priority Engine requirements
- `.planning/REQUIREMENTS.md` §Priority Engine — PRIO-01, PRIO-02, PRIO-03 define the Canonical Store schema, scoring formula, and delivery routing thresholds exactly

### Existing SMS send patterns
- `celery_worker/sms/send.py` — `send_sms_safe()` and `send_sms_direct()` — new `send_sms_alert()` should follow the same pattern as `send_sms_direct` (bypasses cap/quiet hours but not opt-out)

### Existing DB patterns
- `celery_worker/ai/db.py` — shared Supabase query layer; briefing queries switch to `canonical_events` in this phase
- `supabase/migrations/004_deadlines_task_management.sql` — last migration; Phase 5 adds migration 005

No external specs beyond REQUIREMENTS.md — all constraints captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `celery_worker/ai/db.py`: `_get_supabase()`, `get_deadlines_for_briefing()` — the briefing query function switches to query `canonical_events` instead of `deadlines`; same filter logic applies
- `celery_worker/sms/send.py`: `send_sms_direct()` — `send_sms_alert()` follows this pattern (bypasses TCPA guards except STOP opt-out check)
- `celery_worker/tasks.py`: `canvas_sync_user` — integration point where Phase 5 backfill trigger fires on first deploy

### Established Patterns
- All Supabase migrations live in `supabase/migrations/` as numbered SQL files (005 is next)
- Celery tasks fan out per-user (see `canvas_sync_all` → `canvas_sync_user` pattern) — priority scoring should follow same fan-out pattern
- DB queries always use service role key via `_get_supabase()` helper (bypasses RLS)

### Integration Points
- `canvas_sync_user` in `tasks.py`: after `apply_diff`, write changed/new events to `canonical_events` and trigger priority scoring
- `ai/db.py`: `get_deadlines_for_briefing()` needs a variant that reads from `canonical_events` (or replace entirely)
- Phase 6 GCal/Gmail ingestion tasks will call a shared `ingest_canonical_event()` function that handles scoring + routing

</code_context>

<specifics>
## Specific Ideas

- TCPA bypass for score ≥ 80 needs onboarding consent copy flagged to Seb — "time-sensitive deadline alerts at any hour" language required before Yale beta ships
- STATE.md blocker noted: verify `claude-haiku-4-5-20251001` model string before Phase 5 — use `anthropic.models.list()` (not directly relevant to this phase but worth clearing)

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-priority-engine-canonical-timeline-db*
*Context gathered: 2026-03-19*
