# Phase 7: Syllabus Parsing + Study Gap Detection - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can upload course syllabus PDFs via Next.js API route. Claude Opus parses each PDF and extracts exams, assignment types, grade weights, and key topics — stored as structured JSON in the existing `syllabi` table. Daily briefings gain grade-weight context and exam topic hints from parsed syllabi. A Celery Beat task fires study gap analysis SMS at T-5 days before each exam. PDFs are never re-parsed; `parsed_json` is the authoritative record.

No new integrations, no onboarding UI — this phase is backend intelligence only.

</domain>

<decisions>
## Implementation Decisions

### PDF Upload Pathway
- Upload endpoint: `POST /api/upload/syllabus` multipart (already in CLAUDE.md file structure)
- File size limit: 4MB client-side validation (Vercel Hobby multipart cap is ~4.5MB; 4MB gives buffer; typical syllabi are 100KB–2MB)
- Raw PDF is NOT stored permanently — parse immediately via Celery, discard PDF bytes after enqueue
- Next.js route enqueues Celery task and returns HTTP 202; user gets SMS confirmation when parsing completes
- Processing is fully async (Claude Opus calls take 5–20s — synchronous route would timeout)

### Parsed JSON Schema
Structure stored in `syllabi.parsed_json`:
```json
{
  "course_name": "BIOL 201",
  "exams": [
    {"title": "Midterm", "date_str": "2026-03-15", "topics": ["Krebs cycle", "glycolysis", "ATP synthesis"], "weight_pct": 25}
  ],
  "assignments": [
    {"type": "Problem Set", "weight_pct": 15}
  ],
  "total_tracked_weight_pct": 75
}
```
- Topics are flat string lists per exam (not nested) — simpler for gap scoring
- `date_str` is a raw string as extracted by Claude Opus; downstream normalizes to ISO date
- Multiple syllabi per user: one per course, upsert on `(user_id, course_name)` — re-upload replaces
- Downstream consumers (briefing, gap analysis) read directly from `syllabi.parsed_json` — no secondary table

### Study Gap Analysis Delivery
- Trigger: T-5 days before exam (ROADMAP success criteria #3 — locked)
- "Covered material" definition: time-elapsed proxy — topics from exams scheduled more than 5 days prior are assumed covered; topics for the upcoming exam are gap candidates
- SMS format: "Gap alert for [Course] exam in 5 days: [topic 1], [topic 2], [topic 3] (worth ~X%). Review these first." ≤ 800 chars, top 3 topics by weight_pct descending
- Delivery: routes through existing `send_priority_alert` → batch queue (SMS-10/SMS-11 compliant, consistent with Phase 6)
- Beat task: daily scan, same renew_watch_channels pattern — checks for T-5 exams across all users

### Briefing Enrichment Scope
- `grade_weight` already flows through `canonical_events` → `generate_briefing` (Phase 5 shim — no change needed)
- New enrichment: if exam is within 7 days AND `syllabi.parsed_json` exists for that course → append top-3 uncovered topic hint to Claude prompt
- Monday extended briefing: include exam topic coverage summary for all exams in next 14 days (additive to existing Monday prompt)
- Enrichment is gated: graceful degradation if no syllabus uploaded for a course — briefing still works without it
- Enrichment follows same `is_monday` gating pattern as gcal_context (daily brevity, Monday depth)

### Claude's Discretion
- Exact Claude Opus prompt for PDF parsing (structure it to extract reliably; handle edge cases like combined midterm/final sections)
- How to handle syllabi where grade weights don't sum to 100% (partial syllabi)
- Error handling when Opus extracts malformed or empty JSON
- Beat task scheduling (daily at what time — pick a low-traffic window)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Syllabus parsing requirements
- `.planning/REQUIREMENTS.md` §AI-01, AI-02, AI-03, AI-10, INTEL-01 — Full acceptance criteria for upload, parsing, storage, gap analysis
- `.planning/ROADMAP.md` §Phase 7 — Success criteria (5 items) that define what must be true
- `CLAUDE.md` §Claude Model Breakdown — Claude Opus for syllabus parsing (accuracy-critical); Haiku for classification

### Existing briefing integration
- `celery_worker/ai/briefing.py` — `generate_briefing()` signature and `grade_weight` handling (line ~80); `get_exam_touchpoints()` for T-N countdown logic; Monday extended prompt structure
- `celery_worker/ai/db.py` — `get_events_for_briefing()` field mapping shim; how `grade_weight` flows from `canonical_events`

### Database schema
- `supabase/migrations/006_google_integrations.sql` — Most recent migration; new migration (007) adds to this
- `CLAUDE.md` §Database Schema — `syllabi` table columns: `id, user_id, course_name, raw_text, parsed_json, uploaded_at`

### SMS delivery
- `celery_worker/sms/batch.py` — `enqueue_alert()` interface; 10-min batch window; SMS-11 3-item cap
- `celery_worker/tasks.py` — `send_priority_alert` pattern for Phase 6 alerts (gap alert should match this pattern)

### Upload endpoint pattern
- `CLAUDE.md` §Integration Patterns — Every integration follows `src/lib/integrations/` + `src/lib/sync/` + `src/app/api/` structure
- `src/app/api/upload/syllabus/route.ts` — Target file (doesn't exist yet; follows route.ts pattern from existing routes)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `celery_worker/ai/briefing.py` → `generate_briefing()`: already accepts `grade_weight` field and renders `(worth X% of grade)` — no changes needed to daily briefing rendering
- `celery_worker/ai/briefing.py` → `get_exam_touchpoints()`: already identifies T-5 exams — gap analysis Beat task can reuse this logic to find trigger targets
- `celery_worker/ai/db.py` → `get_events_for_briefing()`: already selects `grade_weight` from `canonical_events` — syllabus enrichment reads `syllabi` table separately and merges
- `celery_worker/sms/batch.py` → `enqueue_alert()`: gap analysis SMS routes through this — batch queue already handles SMS-10/SMS-11
- `celery_worker/tasks.py` → `renew_watch_channels`: Beat task pattern to follow for gap analysis daily scan

### Established Patterns
- Celery task = async processing boundary (PDF parsing happens in Celery, not Next.js)
- Next.js API route → Redis LPUSH → Celery worker (same as gcal/gmail webhooks in Phase 6)
- Upsert pattern: `(user_id, X)` unique constraint + on-conflict update (same as `calendar_events` upsert in Phase 6)
- TDD pattern: failing tests first, then implementation (all prior phases)
- `_get_supabase()` lazy import pattern in `celery_worker/ai/db.py` — follow same for syllabus queries

### Integration Points
- `celery_worker/tasks.py` — add `parse_syllabus_task`, `run_gap_analysis_task`, `gap_analysis_all_users` tasks
- `celery_worker/celery_app.py` — add Beat schedule for daily gap analysis scan
- `celery_worker/ai/briefing.py` → `generate_briefing()` — add optional `syllabus_context` param (same pattern as `gcal_context`)
- `supabase/migrations/` — migration 007 is not needed if `syllabi` table already exists from Phase 1 schema; verify before creating

</code_context>

<specifics>
## Specific Ideas

- "A PDF is never re-parsed" — `parsed_json` is the authoritative record; idempotency is a hard requirement
- Gap alert SMS must stay under 800 chars — cap at 3 topics, abbreviate course names
- Enrichment is always additive — if no syllabus, briefing still works exactly as before Phase 7
- The time-elapsed proxy for "covered material" is a deliberate simplification for MVP — no lecture notes, no manual tracking required from the student

</specifics>

<deferred>
## Deferred Ideas

- Manual topic coverage tracking (student marks topics as "covered") — Phase 9+
- Lecture note upload for more precise gap detection — future phase
- Re-parse trigger when syllabus is re-uploaded — could be Phase 9 polish

</deferred>

---

*Phase: 07-syllabus-parsing-study-gap-detection*
*Context gathered: 2026-03-20*
