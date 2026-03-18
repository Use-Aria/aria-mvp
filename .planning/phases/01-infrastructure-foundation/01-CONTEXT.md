# Phase 1: Infrastructure Foundation - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the data layer (Supabase schema + auth), job queue (Celery + Redis on Railway), and deployment targets (Vercel + Railway) so every subsequent phase has somewhere to write data, enqueue jobs, and send messages. Also provision the Twilio phone number and a stub webhook to verify the end-to-end inbound SMS connection works in the Railway environment.

Actual SMS logic, Canvas sync, Claude integration, and all business logic are out of scope — those belong to Phases 2–6.

</domain>

<decisions>
## Implementation Decisions

### Supabase Schema
- Single migration file: `001_initial_schema.sql` — all 7 core tables in one file (users, integrations, deadlines, syllabi, calendar_events, tasks, messages)
- `users.id` is a UUID foreign key to `auth.users.id` — Supabase Auth manages credentials, `users` table stores app-specific fields (phone, preferences_json, etc.)
- RLS enabled on all tables from day one with user-scoped policies (`WHERE user_id = auth.uid()`)
- Schema only — no seed data or test fixtures in migrations

### Env & Secrets Management
- `.env.example` committed to repo with all required keys and empty values — developers copy to `.env.local`
- Railway: one shared environment group referenced by both services (Next.js API + Celery worker) — single place to rotate secrets
- Env verification via a `/api/health` endpoint that checks all required env vars and returns 200 (all present) or 500 (missing keys listed) — automated, reusable across phases

### Twilio Provisioning
- Phone number type: 10DLC local number (US) — cheapest, most carrier-trusted for a US college audience; A2P 10DLC registration required before sending bulk SMS
- Local dev webhook: ngrok (consistent with CLAUDE.md gotchas)
- Phase 1 scope: provision number + a minimal stub `/api/sms/webhook` route that returns HTTP 200 and logs the inbound payload — proves Railway ↔ Twilio connection works; full SMS logic ships in Phase 3

### Celery / Redis Deployment
- Local dev: Docker Compose with Redis + Celery worker services — one command for full stack, matches Railway topology
- Railway: three separate entities — Next.js API service, Celery worker service, Redis plugin — independent scaling and deployment
- Phase 1 test task: `tasks.ping()` — logs execution timestamp to console and writes a test record to Supabase; verifies worker is alive AND can reach the database

### Claude's Discretion
- Exact Docker Compose service names and port mappings
- Health endpoint response body structure (beyond 200/500 status codes)
- Celery worker concurrency setting (start with default, tune later)
- Supabase storage bucket setup (needed in Phase 6 for syllabus PDFs — can defer)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Architecture
- `CLAUDE.md` — Tech stack decisions, normalized data model, full DB schema definition, env var list, file structure, integration patterns, code style rules, team ownership boundaries

### Requirements
- `.planning/REQUIREMENTS.md` — Full v1 requirements; Phase 1 maps to AUTH-01, AUTH-04, SYNC-01
- `.planning/ROADMAP.md` §Phase 1 — Success criteria (5 items), dependency chain, requirement traceability

No external specs — requirements fully captured in decisions above and the canonical docs listed.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None yet — greenfield project. No existing `src/` directory.

### Established Patterns
- None yet — patterns will be established in this phase and followed by subsequent phases per CLAUDE.md integration pattern spec:
  ```
  src/lib/integrations/[service].ts  → raw API calls
  src/lib/sync/[service]-sync.ts     → fetch + normalize + cache
  src/app/api/sync/[service]/route.ts → Next.js API route
  ```

### Integration Points
- Supabase schema established here is the foundation every subsequent phase writes to
- Railway services established here are where all background jobs (Phases 2–6) will run
- Twilio stub webhook at `src/app/api/sms/webhook/route.ts` becomes the full SMS handler in Phase 3

</code_context>

<specifics>
## Specific Ideas

- No specific references — open to standard approaches for all implementation details

</specifics>

<deferred>
## Deferred Ideas

- Supabase Storage bucket setup (for syllabus PDFs) — Phase 6
- pgvector extension enable (for syllabus embeddings) — Phase 6
- A2P 10DLC campaign registration — should be started during Phase 3 work (takes time to approve); flagged in STATE.md blockers

</deferred>

---

*Phase: 01-infrastructure-foundation*
*Context gathered: 2026-03-18*
