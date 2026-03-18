---
phase: 01-infrastructure-foundation
plan: 01
subsystem: infra
tags: [nextjs, supabase, postgresql, rls, auth, twilio, typescript, tailwind]

# Dependency graph
requires: []
provides:
  - Next.js 15.5 project with TypeScript strict mode, Tailwind CSS, ESLint
  - Supabase browser client factory (createBrowserClient via @supabase/ssr)
  - Supabase server client factory (createServerClient with async cookies for Next.js 15)
  - Auth middleware refreshing tokens on every request via getClaims()
  - Database migration: 8 tables (users, integrations, deadlines, syllabi, calendar_events, tasks, messages, spotify_sessions) with RLS and handle_new_user trigger
  - Normalized TypeScript types: Task, CalendarEvent, Message
  - /api/health endpoint (200 all vars present / 500 missing keys listed)
  - /api/sms/webhook stub (always 200, omits phone numbers from logs)
  - .env.example with all required keys
affects:
  - 01-02 (Celery worker, Docker Compose — depends on Supabase schema and env setup)
  - All subsequent phases (every phase writes to these tables via these client factories)

# Tech tracking
tech-stack:
  added:
    - next@15.5.13
    - react@19.1.0
    - "@supabase/supabase-js@^2.99.2"
    - "@supabase/ssr@^0.9.0"
    - twilio@^5.13.0
    - typescript@^5
    - tailwindcss@^4
    - eslint@^9
  patterns:
    - Supabase client factories: separate browser (createBrowserClient) and server (createServerClient) exports, never module-scope
    - Server client uses async cookies() — required for Next.js 15 compatibility
    - Auth middleware pattern: getClaims() on every request to refresh tokens (not getSession())
    - RLS policy pattern: USING ((SELECT auth.uid()) = user_id) WITH CHECK (...) for all tables
    - handle_new_user trigger: SECURITY DEFINER SET search_path = '' for safe cross-schema access

key-files:
  created:
    - src/types/index.ts
    - src/lib/supabase/client.ts
    - src/lib/supabase/server.ts
    - src/middleware.ts
    - src/app/api/health/route.ts
    - src/app/api/sms/webhook/route.ts
    - supabase/migrations/001_initial_schema.sql
    - .env.example
  modified:
    - src/app/page.tsx
    - src/app/layout.tsx
    - package.json

key-decisions:
  - "Used @supabase/ssr (not deprecated @supabase/auth-helpers) for session persistence in App Router"
  - "Used getClaims() not getSession() in middleware — getSession() does not revalidate tokens server-side (security anti-pattern per Supabase docs)"
  - "server.ts createClient() is async (await cookies()) — required for Next.js 15 async Request API"
  - "users.id is UUID FK to auth.users(id) — Supabase Auth manages credentials, public.users stores app fields"
  - "handle_new_user trigger uses SECURITY DEFINER SET search_path = '' to prevent search path injection"
  - "SMS webhook intentionally omits From field from logs — phone number privacy per CLAUDE.md"

patterns-established:
  - "Pattern: Supabase client factories — never instantiate at module scope, always inside request handler"
  - "Pattern: Auth middleware at src/middleware.ts (not src/app/middleware.ts) — Next.js requires root of src/"
  - "Pattern: SMS webhook always returns 200 to Twilio regardless of error state"
  - "Pattern: Health endpoint lists missing keys in 500 response body for fast diagnosis"

requirements-completed: [AUTH-01, AUTH-04]

# Metrics
duration: 5min
completed: 2026-03-18
---

# Phase 01 Plan 01: Infrastructure Foundation Summary

**Next.js 15.5 scaffolded with @supabase/ssr auth middleware (getClaims pattern), 8-table PostgreSQL schema with RLS, Twilio SMS stub, and health endpoint — all 7 required env vars verified at /api/health**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-18T21:12:16Z
- **Completed:** 2026-03-18T21:17:00Z
- **Tasks:** 2 of 2
- **Files modified:** 11

## Accomplishments
- Next.js 15 project with TypeScript, Tailwind, ESLint, and Supabase/Twilio packages installed
- Supabase client factories for browser and server with correct async cookie handling for Next.js 15
- Auth middleware using getClaims() that refreshes tokens on every non-static request (enables AUTH-04 session persistence)
- 8-table PostgreSQL schema with RLS policies and handle_new_user() trigger for automatic user row creation
- Health endpoint that returns 500 with specific missing key list — useful for CI/CD and ops
- Twilio SMS webhook stub that is phone-number-safe (From field never logged)

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold Next.js 15 project, Supabase clients, migration, env template, and types** - `e523a6f` (feat)
2. **Task 2: Create Auth middleware, health endpoint, and SMS webhook stub** - `734c88d` (feat)

## Files Created/Modified
- `src/types/index.ts` - Task, CalendarEvent, Message normalized types (verbatim from CLAUDE.md)
- `src/lib/supabase/client.ts` - Browser client factory using createBrowserClient from @supabase/ssr
- `src/lib/supabase/server.ts` - Server client factory using createServerClient with async cookies()
- `src/middleware.ts` - Auth token refresh middleware using getClaims() on every non-static request
- `src/app/api/health/route.ts` - Env var check endpoint, returns 200/500 with missing key list
- `src/app/api/sms/webhook/route.ts` - Twilio inbound stub, always 200, omits From field from logs
- `supabase/migrations/001_initial_schema.sql` - All 8 tables with RLS + handle_new_user trigger
- `.env.example` - All required env var keys with empty values
- `src/app/page.tsx` - Minimal Aria placeholder (h1 + paragraph)
- `src/app/layout.tsx` - Updated metadata title/description
- `package.json` - Added @supabase/supabase-js, @supabase/ssr, twilio; renamed to aria-mvp

## Decisions Made
- Used @supabase/ssr (not deprecated @supabase/auth-helpers) for session persistence
- Used getClaims() not getSession() in middleware — getSession() is a security anti-pattern server-side
- server.ts createClient() is async — required for Next.js 15 async cookies() API
- SMS webhook omits From field from logs per CLAUDE.md phone number privacy requirement

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None — no external service configuration required for this plan. All Supabase and Twilio setup (provisioning, credentials, migration run) is deferred to manual steps before the next phase.

## Next Phase Readiness
- Next.js 15 builds cleanly, lint passes, all routes compile
- Plan 01-02 (Celery worker + Docker Compose) can proceed — no blockers
- To run the migration against a real Supabase project: `npx supabase db push` (requires Supabase project URL + service role key in .env.local)
- AUTH-01 and AUTH-04 verification requires a real Supabase project and browser test (manual-only, per RESEARCH.md)

## Self-Check: PASSED

All files verified present. Both commits confirmed in git log. All acceptance criteria met:
- All 8 files created as specified
- package.json has @supabase/supabase-js, @supabase/ssr, twilio
- types/index.ts has Task, CalendarEvent, Message exports
- client.ts uses createBrowserClient
- server.ts uses createServerClient + await cookies(), does NOT contain getClaims (getClaims is middleware-only)
- middleware.ts uses getClaims(), NOT getSession() in actual code (getSession appears only in comments explaining why not to use it)
- migration has all 8 tables, 8x ENABLE ROW LEVEL SECURITY, handle_new_user trigger
- health route has NEXT_PUBLIC_SUPABASE_URL, TWILIO_ACCOUNT_SID, ANTHROPIC_API_KEY, status 500
- SMS webhook logs MessageSid only, From field omitted from actual log statements (only in JSDoc comment)
- npm run build exits 0
- npm run lint exits 0

---
*Phase: 01-infrastructure-foundation*
*Completed: 2026-03-18*
