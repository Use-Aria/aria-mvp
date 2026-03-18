# Aria — Project Context

> **Read this at the start of every Claude session** before reading anything else.
> It's the TL;DR of the entire project state. Reduces context window overhead.

---

## What We're Building

**Aria** — proactive AI academic assistant for Yale students via SMS.
Syncs Canvas deadlines, Gmail, and Google Calendar. Sends a daily 8am briefing + deadline change alerts. Students reply by text. No app needed.

**Team:** Josh Shin (backend, Claude Code) + Seb (frontend, separate Claude Code account)
**Started:** March 18, 2026

---

## Current State

| Artifact | Status | Location |
|----------|--------|----------|
| Project definition | ✅ Done | `.planning/PROJECT.md` |
| GSD config (YOLO mode) | ✅ Done | `.planning/config.json` |
| Domain research | ✅ Done | `.planning/research/` |
| Requirements (52 reqs) | ✅ Done | `.planning/REQUIREMENTS.md` |
| Roadmap (7 phases) | ✅ Done | `.planning/ROADMAP.md` |
| Work coordination | ✅ Done | `WORK.md` |
| Phase 1 context | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-CONTEXT.md` |
| Phase 1 research | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-RESEARCH.md` |
| Phase 1 plans (2) | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-01-PLAN.md`, `01-02-PLAN.md` |
| Phase 1 validation | ✅ Done | `.planning/phases/01-infrastructure-foundation/01-VALIDATION.md` |
| App code | ❌ Not started | — |

**Active phase:** Phase 1 — Infrastructure Foundation (planned, ready to execute)
**Next action:** `/gsd:execute-phase 1`

---

## Phase 1 — What's Planned

Two plans run in parallel (Wave 1):

| Plan | What it builds |
|------|---------------|
| `01-01` | Next.js 15.2 scaffold, Supabase schema (`001_initial_schema.sql`), Supabase Auth middleware, `/api/health` endpoint, `/api/sms/webhook` stub |
| `01-02` | Celery worker app, `tasks.ping()` smoke test, `Dockerfile`, Docker Compose (Redis + worker), Railway deployment config |

Files that will be created (none exist yet — greenfield):
- `src/app/api/health/route.ts`
- `src/app/api/sms/webhook/route.ts`
- `src/lib/supabase/server.ts`, `client.ts`, `middleware.ts`
- `src/middleware.ts`
- `src/types/index.ts`
- `.env.example`
- `supabase/migrations/001_initial_schema.sql`
- `celery_worker/tasks.py`, `celery_app.py`, `requirements.txt`, `Dockerfile`
- `docker-compose.yml`

---

## Roadmap (7 phases)

| # | Phase | Owner | Key Goal |
|---|-------|-------|----------|
| 1 | Infrastructure Foundation | Josh | Supabase schema + Redis + Celery + Vercel wired up |
| 2 | Canvas iCal Sync | Josh | Deadlines fetched, normalized, stored, diffed every 60 min |
| 3 | Twilio SMS + TCPA | Josh | Send/receive SMS with full TCPA compliance from day 1 |
| 4 | Claude AI + Daily Briefing | Josh | 8am SMS + welcome briefing at onboarding end |
| 5 | Google OAuth + GCal + Gmail + Alerts | Josh | Deadline alerts ≤15 min, watch channel auto-renewal |
| 6 | Syllabus Parsing | Josh | Claude Opus extracts grade weights, enriches briefings |
| 7 | Onboarding + Frontend UI | **Seb** | Can start in parallel after Phase 4 ships |

---

## Key Decisions Made

| Decision | What | Why |
|----------|------|-----|
| Next.js version | **15.2** (not 14) | 14 is outdated; breaking changes in params/cookies now async |
| Vector DB | **pgvector** (Supabase native) | Chroma dropped — unnecessary Railway service for 50 users |
| Auth package | **@supabase/ssr** (not `auth-helpers`) | auth-helpers-nextjs is deprecated; session persistence requires `getClaims()` in middleware |
| SMS for MVP | **Twilio SMS** | No native iMessage API; Sendblue iMessage is v2 |
| Briefing cadence | **Daily** (7am generate, 8am send) | Not weekly — daily is the confirmed MVP spec |
| Gmail scope | **MVP** (not v2) | Cross-referencing professor emails is core to deadline accuracy |
| Background jobs | **FastAPI + Celery + Redis on Railway** | Python needed for Claude AI workloads; Next.js handles webhooks only |
| Claude in webhooks | **Never inline** | Always enqueue to Celery — Vercel 30s timeout would kill it |
| Twilio number type | **10DLC local number** | Cheapest + most carrier-trusted for US college audience; A2P registration required before Phase 3 sends bulk SMS |
| `tasks.ping()` | **Console-only in Phase 1** | `messages.user_id` is NOT NULL — no real user exists yet; DB write deferred to Phase 2 |
| Railway layout | **3 separate entities** | Next.js service + Celery worker service + Redis plugin; shared env group for secrets |
| Supabase users table | **FK to `auth.users.id`** | Supabase Auth owns credentials; `public.users` stores app fields only (phone, preferences) |
| RLS | **On from day one** | User-scoped policies (`WHERE user_id = auth.uid()`) on all 7 tables; never retrofitted |

---

## ⚠️ Critical Gotchas

1. **Google OAuth Gmail scope** — app verification by Google takes 1–6 weeks. Start the Google Cloud Console verification process NOW (Phase 1), before you need it in Phase 5.
2. **GCal + Gmail watch channels expire every 7 days** silently — the Celery renewal cron (runs 48h before expiry) is P0 infrastructure, not optional polish. Goes in Phase 5.
3. **Twilio inbound webhook** — must return HTTP 200 in <1 second. Never call Claude inline. Return 200, enqueue Celery task, reply async.
4. **TCPA compliance** — opt-out check before EVERY outbound SMS regardless of carrier blocking. Ships in Phase 3, not retrofitted later.
5. **Welcome briefing** — trigger synchronously at onboarding completion. Users who wait 18h for first SMS think the product is broken.
6. **Canvas iCal UID stability** — validate against a real Yale Canvas feed before building the diff engine (UID may be unstable on some instances).

---

## Two-Developer Coordination

**Always start with:** `git pull origin main` → read `WORK.md` → claim a task → push claim
**Never touch the other dev's files** (see ownership table in `CLAUDE.md`)
**Slash commands:** `/project:start` (claim task) → `/project:done` (release + handoff note)

Josh owns: `src/lib/`, `src/app/api/`, `supabase/`
Seb owns: `src/app/(pages)/`, `src/components/`
Both must sync before touching: `src/types/index.ts`, `supabase/migrations/`

---

## Tech Stack (confirmed)

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15.2, TypeScript, Tailwind, `@supabase/ssr` |
| Backend | Next.js API routes (webhooks) + FastAPI + Celery + Redis |
| Database | Supabase (PostgreSQL + pgvector) |
| Auth | Supabase Auth + Google OAuth 2.0 |
| SMS | Twilio (MVP) → Sendblue iMessage (v2) |
| AI | Claude API: Opus (syllabus), Sonnet (briefing + replies), Haiku (classification) |
| Jobs | Celery + Redis on Railway |
| Deploy | Vercel (Next.js) + Railway (FastAPI + Celery workers) |

---

## Files to Read for Full Context

- `CLAUDE.md` — architecture decisions, code style, integration patterns, ownership rules
- `WORK.md` — active work state (claimed tasks, queue, handoff notes)
- `.planning/ROADMAP.md` — full phase breakdown with success criteria
- `.planning/REQUIREMENTS.md` — all 52 v1 requirements with traceability
- `.planning/research/SUMMARY.md` — research synthesis (stack, features, architecture, pitfalls)
- `.planning/phases/01-infrastructure-foundation/` — context, research, plans, validation for Phase 1
