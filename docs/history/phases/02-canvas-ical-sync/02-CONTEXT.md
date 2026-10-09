# Phase 2: Canvas iCal Sync - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Fetch Canvas iCal feeds for all users, parse VEVENT records into the normalized Task type, diff against the previously stored state, and persist results in the `deadlines` table — every 60 minutes via Celery background job. This is the data foundation Phase 4 (briefings) and Phase 5 (alerts) read from.

Out of scope: the web UI for entering the Canvas iCal URL (Phase 7), SMS alerting on deadline changes (Phase 5), and briefing generation (Phase 4).

</domain>

<decisions>
## Implementation Decisions

### Canvas URL bootstrapping (Phase 2 testing)
- No onboarding UI exists yet (Phase 7). For Phase 2 testing, manually insert the Canvas iCal URL directly into the `integrations` table via Supabase table editor.
- `integrations.platform = 'canvas'`, `integrations.ical_url = <paste URL>`, `integrations.user_id = <test user UUID>`
- This is a dev-only workaround. AUTH-05 (user enters URL during onboarding) is Phase 7's responsibility.

### Diff sensitivity
- Only `due_date` changes count as a "changed" deadline. Title-only changes do not trigger a diff event.
- The diff engine compares `canvas_uid` (stable iCal UID) across syncs to detect: added, due_date-changed, and removed deadlines.
- When a deadline disappears from the Canvas iCal feed: **soft-delete** — add a `deleted_at TIMESTAMPTZ` column (or `is_deleted BOOLEAN`) to the `deadlines` table. Never hard-delete. This preserves history and lets Phase 5 alert the user that a deadline was removed.

### Timezone handling
- Always store `due_date` as **UTC** in Supabase (`TIMESTAMPTZ` column, which already exists in schema).
- On ingest: parse the iCal `DTSTART` + `TZID` (e.g., `DTSTART;TZID=America/New_York:20260401T235900`) and convert to UTC before writing.
- Conversion to user's local timezone happens at read time (Phase 4 briefing generation, Phase 5 alerts) using the user's timezone stored in `preferences_json`.

### Sync logic placement
- **Python only** — all iCal fetching, VEVENT parsing, diffing, and Supabase writes happen inside the Celery task in `celery_worker/`.
- The Next.js API route at `src/app/api/sync/canvas/route.ts` exists only to trigger the Celery task on demand (manual trigger / health check). It does NOT parse iCal or write to DB itself.
- No TypeScript implementation of iCal parsing — one implementation, one language.

### Claude's Discretion
- Python iCal parsing library choice (icalendar, ics.py, or similar)
- Celery task retry count and backoff multiplier for rate limit errors (CANV-05 requires exponential backoff — implementation details are Claude's call)
- Whether to use Celery Beat for the 60-min schedule or a periodic task decorator
- Exact structure of the soft-delete migration (column name, index)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project architecture & code style
- `CLAUDE.md` — Integration pattern (`src/lib/integrations/[service].ts` → `src/lib/sync/[service]-sync.ts` → `src/app/api/sync/[service]/route.ts`), code style rules, team ownership boundaries, critical gotchas (Canvas iCal rate limits, Canvas iCal UID stability warning)
- `src/types/index.ts` — `Task` type definition that Canvas deadlines must normalize to (`source: 'canvas'`, `due_date` as ISO 8601)

### Database schema
- `supabase/migrations/001_initial_schema.sql` — `deadlines` table (canvas_uid, title, due_date, course, type, grade_weight, last_synced) and `integrations` table (ical_url, synced_at) — Phase 2 needs a migration to add soft-delete column to `deadlines`

### Requirements
- `.planning/REQUIREMENTS.md` — CANV-01 through CANV-05 (the five Canvas requirements this phase implements)
- `.planning/ROADMAP.md` §Phase 2 — Success criteria (4 items), dependency on Phase 1

### Existing Celery patterns
- `celery_worker/tasks.py` — Existing task structure to follow for the new canvas_sync task
- `celery_worker/celery_app.py` — App configuration (broker, include list — new tasks module must be registered here)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `celery_worker/tasks.py` — `ping()` task is the pattern to follow: `@celery_app.task(name="tasks.X")`, returns dict with status
- `celery_worker/celery_app.py` — Celery app instance; new canvas sync task registers here via `include`
- `src/lib/supabase/server.ts` — Server-side Supabase client for Next.js API route (manual trigger route)
- `supabase/migrations/001_initial_schema.sql` — `deadlines` and `integrations` tables already exist; Phase 2 adds a soft-delete migration on top

### Established Patterns
- Background job = Python Celery task in `celery_worker/tasks.py`
- Next.js API route = thin trigger only, never does the heavy work
- Supabase writes from Python use the `supabase-py` client (already in `celery_worker/requirements.txt`)
- All due dates stored as `TIMESTAMPTZ` (UTC) in Supabase

### Integration Points
- `integrations` table: Phase 2 reads `ical_url` and writes `synced_at` on each successful sync
- `deadlines` table: Phase 2 is the sole writer; Phase 4 and Phase 5 are readers
- `celery_app.include`: must add the new canvas sync task module so Celery discovers it

</code_context>

<specifics>
## Specific Ideas

- No specific references — open to standard Python iCal parsing approaches

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-canvas-ical-sync*
*Context gathered: 2026-03-18*
