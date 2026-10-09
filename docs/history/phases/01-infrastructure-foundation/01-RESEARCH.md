# Phase 1: Infrastructure Foundation - Research

**Researched:** 2026-03-18
**Domain:** Supabase (schema + Auth + RLS), Celery + Redis (Railway), Next.js 15 scaffolding, Twilio provisioning
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Single migration file: `001_initial_schema.sql` — all 7 core tables in one file (users, integrations, deadlines, syllabi, calendar_events, tasks, messages)
- `users.id` is a UUID foreign key to `auth.users.id` — Supabase Auth manages credentials, `users` table stores app-specific fields (phone, preferences_json, etc.)
- RLS enabled on all tables from day one with user-scoped policies (`WHERE user_id = auth.uid()`)
- Schema only — no seed data or test fixtures in migrations
- `.env.example` committed to repo with all required keys and empty values — developers copy to `.env.local`
- Railway: one shared environment group referenced by both services (Next.js API + Celery worker) — single place to rotate secrets
- Env verification via a `/api/health` endpoint that checks all required env vars and returns 200 (all present) or 500 (missing keys listed) — automated, reusable across phases
- Phone number type: 10DLC local number (US) — A2P 10DLC registration required before sending bulk SMS
- Local dev webhook: ngrok
- Phase 1 scope: provision number + a minimal stub `/api/sms/webhook` route that returns HTTP 200 and logs the inbound payload — full SMS logic ships in Phase 3
- Local dev: Docker Compose with Redis + Celery worker services
- Railway: three separate entities — Next.js API service, Celery worker service, Redis plugin
- Phase 1 test task: `tasks.ping()` — logs execution timestamp to console and writes a test record to Supabase

### Claude's Discretion
- Exact Docker Compose service names and port mappings
- Health endpoint response body structure (beyond 200/500 status codes)
- Celery worker concurrency setting (start with default, tune later)
- Supabase storage bucket setup (needed in Phase 6 for syllabus PDFs — can defer)

### Deferred Ideas (OUT OF SCOPE)
- Supabase Storage bucket setup (for syllabus PDFs) — Phase 6
- pgvector extension enable (for syllabus embeddings) — Phase 6
- A2P 10DLC campaign registration — should be started during Phase 3 work (takes time to approve)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AUTH-01 | User can create an account with email and password via Supabase Auth | @supabase/ssr + middleware pattern enables email/password signup with persistent session across browser refresh |
| AUTH-04 | User session persists across browser refresh | Middleware with `supabase.auth.getClaims()` writes refreshed token to cookies on every request; session survives refresh |
| SYNC-01 | Celery + Redis deployed on Railway for all background jobs | Three-service Railway topology (API service + Celery worker service + Redis plugin) with REDIS_URL shared variable |
</phase_requirements>

---

## Summary

Phase 1 is purely infrastructure — no business logic. It establishes four independent pillars that every later phase depends on: (1) Supabase schema with RLS, (2) Supabase Auth wired into the Next.js 15 App Router, (3) Celery + Redis running on Railway with a verified ping task, and (4) a Twilio phone number with a stub inbound webhook.

The most technically nuanced part is Supabase Auth with Next.js 15. The `@supabase/auth-helpers` package is deprecated; the current standard is `@supabase/ssr`, which requires a Next.js middleware file to refresh tokens on every request and write them back to cookies. Without this middleware, sessions do not persist across browser refresh (AUTH-04 would fail). The `getClaims()` method — not `getSession()` — is the correct server-side check.

The Celery + Redis setup on Railway follows a well-worn pattern: three separate Railway services (Next.js API, Celery worker, Redis plugin) sharing secrets via Railway's Shared Variables feature. The only gotcha is that the Celery worker and Next.js API must share the same REDIS_URL, which Railway's reference variable syntax (`${{shared.REDIS_URL}}`) handles cleanly. The Docker Compose local dev stack mirrors this topology.

**Primary recommendation:** Build in this order — (1) Next.js scaffold + env setup, (2) Supabase project + migration + RLS, (3) Auth middleware + health check, (4) Docker Compose + Celery ping task, (5) Railway deployment wiring, (6) Twilio number + stub webhook. Each step is independently verifiable.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | 16.2.0 (npm latest) — use 15.2 per CLAUDE.md | Next.js App Router framework | Project decision; async Request API is stable in 15.x |
| @supabase/supabase-js | 2.99.2 | Supabase client for DB + Auth | Official client library |
| @supabase/ssr | 0.9.0 | SSR-safe Auth with cookie handling | Replaces deprecated @supabase/auth-helpers; required for session persistence in App Router |
| celery | 5.6.2 (Python) | Background job worker | Project decision; integrates with Redis broker |
| redis | 5.x (Python redis package) | Celery broker + result backend | Celery's recommended broker for Railway deployments |
| twilio | 5.13.0 (Node) | SMS send/receive | Project decision; Twilio Messaging API |

**Version note:** `next` npm registry shows 16.2.0 but CLAUDE.md locks to 15.2. Use `npx create-next-app@15.2` to pin to the decided version. Do not drift to 16.x without a deliberate decision.

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| supabase (CLI) | 2.81.3 | Migration management, local dev | `npx supabase db push` to apply migrations |
| dotenv | latest | Environment loading in Python | Load `.env` for local Celery worker |
| flower | latest | Celery task monitoring UI | Optional; add to Docker Compose for debug visibility |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @supabase/ssr | @supabase/auth-helpers | auth-helpers is deprecated — bugs won't be fixed; ssr is the current standard |
| Celery + Redis | BullMQ (Node) | BullMQ would keep stack all-JS, but CLAUDE.md specifies FastAPI (Python) for AI jobs — Celery is correct |
| Railway Redis plugin | Upstash Redis | Upstash is HTTP-based (slower for Celery); Railway plugin is lower latency and simpler networking |

### Installation

**Next.js project (TypeScript + Tailwind + App Router):**
```bash
npx create-next-app@15.2 aria-mvp --typescript --tailwind --eslint --app --src-dir
```

**Supabase client packages:**
```bash
npm install @supabase/supabase-js @supabase/ssr
```

**Twilio:**
```bash
npm install twilio
```

**Python (Celery worker — requirements.txt):**
```
celery==5.6.2
redis>=5.0.0
supabase>=2.0.0
python-dotenv>=1.0.0
```

---

## Architecture Patterns

### Recommended Project Structure
```
aria-mvp/
├── src/
│   ├── types/
│   │   └── index.ts              # Task, CalendarEvent, Message types
│   ├── lib/
│   │   └── supabase/
│   │       ├── client.ts         # createBrowserClient() — used in client components
│   │       └── server.ts         # createServerClient() — used in server components + API routes
│   └── app/
│       ├── api/
│       │   ├── health/route.ts   # env var check → 200/500
│       │   └── sms/
│       │       └── webhook/route.ts  # Twilio stub → 200 + log
│       └── middleware.ts         # Supabase token refresh middleware
├── celery_worker/
│   ├── celery_app.py             # Celery app instance
│   ├── tasks.py                  # tasks.ping() and future tasks
│   └── requirements.txt
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql
├── docker-compose.yml            # redis + celery_worker services
└── .env.example                  # all required keys, empty values
```

### Pattern 1: Supabase Auth Middleware (Session Persistence)

**What:** A Next.js middleware file that intercepts every request, refreshes the Supabase Auth token if expired, and writes the updated token back to request and response cookies.

**When to use:** Required for AUTH-04. Without this, Server Components cannot read the session and tokens expire silently.

**Example:**
```typescript
// src/app/middleware.ts
// Source: https://supabase.com/docs/guides/auth/server-side/nextjs
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: use getClaims(), never getSession() on server
  await supabase.auth.getClaims()

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

### Pattern 2: Supabase Client Factories

**What:** Two factory functions — one for browser (client components) and one for server (server components + API routes).

```typescript
// src/lib/supabase/client.ts — browser client
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
}
```

```typescript
// src/lib/supabase/server.ts — server client (API routes, Server Components)
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component — ignore (middleware handles cookie writes)
          }
        },
      },
    }
  )
}
```

**Note on env var name:** Current Supabase docs use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (not `NEXT_PUBLIC_SUPABASE_ANON_KEY`). CLAUDE.md uses the older name. Both work — the key value is the same. Use `NEXT_PUBLIC_SUPABASE_ANON_KEY` to match CLAUDE.md and keep consistency across the project.

### Pattern 3: Supabase Migration with RLS

```sql
-- supabase/migrations/001_initial_schema.sql
-- Source: CLAUDE.md DB schema + Supabase RLS docs

-- users: app-specific profile, FK to auth.users
CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  university TEXT,
  graduation_year INT,
  preferences_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own row" ON public.users
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

-- Auto-create users row on signup
CREATE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- integrations
CREATE TABLE public.integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  ical_url TEXT,
  connected_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User-scoped" ON public.integrations FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- deadlines
CREATE TABLE public.deadlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  canvas_uid TEXT,
  title TEXT NOT NULL,
  due_date TIMESTAMPTZ,
  course TEXT,
  type TEXT,
  grade_weight NUMERIC,
  last_synced TIMESTAMPTZ
);
ALTER TABLE public.deadlines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User-scoped" ON public.deadlines FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- syllabi
CREATE TABLE public.syllabi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  course_name TEXT,
  raw_text TEXT,
  parsed_json JSONB,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.syllabi ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User-scoped" ON public.syllabi FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- calendar_events
CREATE TABLE public.calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  google_event_id TEXT,
  title TEXT NOT NULL,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  type TEXT
);
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User-scoped" ON public.calendar_events FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- tasks
CREATE TABLE public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  todoist_id TEXT,
  title TEXT NOT NULL,
  due_date TIMESTAMPTZ,
  priority INT,
  completed BOOLEAN DEFAULT false
);
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User-scoped" ON public.tasks FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- messages
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body TEXT,
  sent_at TIMESTAMPTZ DEFAULT now(),
  trigger_type TEXT
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User-scoped" ON public.messages FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- spotify_sessions (schema only, used in Phase 2+)
CREATE TABLE public.spotify_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  playlist_uri TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INT
);
ALTER TABLE public.spotify_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "User-scoped" ON public.spotify_sessions FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
```

### Pattern 4: Celery App + Ping Task

```python
# celery_worker/celery_app.py
import os
from celery import Celery

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "aria",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["celery_worker.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
)
```

```python
# celery_worker/tasks.py
from celery_worker.celery_app import celery_app
from datetime import datetime, timezone
import os

@celery_app.task(name="tasks.ping")
def ping():
    """Smoke-test task: logs timestamp and writes a record to Supabase."""
    from supabase import create_client
    ts = datetime.now(timezone.utc).isoformat()
    print(f"[ping] executed at {ts}")

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb = create_client(url, key)
    # Write test record to messages table as a canary
    sb.table("messages").insert({
        "user_id": os.environ.get("PING_TEST_USER_ID"),
        "direction": "out",
        "body": f"[ping] {ts}",
        "trigger_type": "ping",
    }).execute()
    return {"status": "ok", "timestamp": ts}
```

**Worker start command:**
```bash
celery -A celery_worker.celery_app worker --loglevel=info
```

### Pattern 5: Docker Compose (local dev)

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  celery_worker:
    build:
      context: ./celery_worker
      dockerfile: Dockerfile
    command: celery -A celery_worker.celery_app worker --loglevel=info --concurrency=2
    environment:
      - REDIS_URL=redis://redis:6379/0
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
    depends_on:
      redis:
        condition: service_healthy
    volumes:
      - ./celery_worker:/app
```

### Pattern 6: Twilio Stub Webhook

```typescript
// src/app/api/sms/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'

/**
 * Twilio inbound SMS webhook stub.
 * Phase 1: Returns 200 immediately and logs payload.
 * Phase 3: Full SMS processing added here.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.text()
    const params = Object.fromEntries(new URLSearchParams(body))
    // Phone numbers must not appear in logs — hash or omit
    console.log('[sms/webhook] inbound:', {
      MessageSid: params['MessageSid'],
      NumMedia: params['NumMedia'],
      // From: intentionally omitted — CLAUDE.md: phone numbers hashed in logs
    })
    // Twilio expects a 200 response body of TwiML or empty
    return new NextResponse('', { status: 200 })
  } catch (err) {
    console.error('[sms/webhook] error:', err)
    return new NextResponse('', { status: 200 }) // always 200 to Twilio
  }
}
```

### Pattern 7: Health Check Endpoint

```typescript
// src/app/api/health/route.ts
import { NextResponse } from 'next/server'

const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ANTHROPIC_API_KEY',
]

export async function GET() {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k])
  if (missing.length > 0) {
    return NextResponse.json({ ok: false, missing }, { status: 500 })
  }
  return NextResponse.json({ ok: true, checked: REQUIRED_ENV_VARS.length })
}
```

### Anti-Patterns to Avoid
- **`getSession()` on the server:** Returns unvalidated cached data; use `getClaims()` instead for auth checks in Server Components and API routes.
- **Module-level Supabase client:** Never instantiate a Supabase client at module scope in server code — always create it inside the request handler. Shared state across requests causes session leakage.
- **Running Celery beat + worker in same Railway service:** Beat and worker should be separate Railway services to allow independent scaling and restarts.
- **Applying migrations without coordination:** Schema rule from CLAUDE.md — never run a migration without telling the other developer first.
- **Exposing `SUPABASE_SERVICE_ROLE_KEY` to client:** The service role key bypasses RLS entirely. It must only be used in server-side Celery tasks and Next.js API routes, never in browser clients.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token refresh on every request | Manual JWT parsing middleware | `@supabase/ssr` middleware pattern | Handles PKCE flow, cookie scoping, expiry edge cases |
| Auth cookie management | Custom cookie encoding | `@supabase/ssr` `createServerClient` | Supabase uses specific cookie naming conventions; custom code breaks session |
| Migration tracking | Custom migration table | Supabase CLI (`supabase db push`) | CLI manages migration state, ordering, and remote/local sync |
| Celery app factory | Custom task queue | Celery + Redis | Reliable retry logic, dead letter queues, beat scheduling — non-trivial to replicate |
| Twilio signature validation | Manual HMAC-SHA1 | `twilio.validateRequest()` from the `twilio` npm package | Timing-safe comparison, handles URL normalization quirks |

**Key insight:** Auth session management in SSR apps has many subtle failure modes (PKCE race conditions, cookie domain scoping, refresh token rotation). `@supabase/ssr` exists specifically to solve these — do not deviate from its prescribed middleware pattern.

---

## Common Pitfalls

### Pitfall 1: Session Not Persisting After Browser Refresh
**What goes wrong:** User logs in successfully but the session disappears on page refresh. `useUser()` returns null.
**Why it happens:** The Supabase token was stored in memory but not persisted to cookies, because the Next.js middleware was not set up or is missing the `getClaims()` call.
**How to avoid:** Implement `src/app/middleware.ts` exactly as documented. The `matcher` pattern must cover all routes except static assets.
**Warning signs:** Auth works in browser but Server Components see no user; session present in DevTools Application tab but disappears after refresh.

### Pitfall 2: RLS Blocks Celery Worker
**What goes wrong:** `tasks.ping()` fails with a Supabase permission error despite valid credentials.
**Why it happens:** The Celery worker is using the `ANON_KEY` (subject to RLS) instead of the `SERVICE_ROLE_KEY`. The `ping` test user may not exist, making `WHERE user_id = auth.uid()` fail.
**How to avoid:** Celery worker always uses `SUPABASE_SERVICE_ROLE_KEY` for DB writes. Disable auth persistence on the server client (`persistSession: False`).
**Warning signs:** 403 errors in Celery logs with message `new row violates row-level security policy`.

### Pitfall 3: Celery Worker Cannot Reach Redis on Railway
**What goes wrong:** Celery worker starts but tasks sit in queue unexecuted. `celery inspect active` shows no workers.
**Why it happens:** The `REDIS_URL` Railway reference variable is not correctly injected into the Celery worker service, so the worker connects to a different broker than the API service enqueues to.
**How to avoid:** Use Railway Shared Variables (`${{shared.REDIS_URL}}`) to ensure both services use the identical value. Verify with `celery -A celery_worker.celery_app inspect ping` from the worker service shell.
**Warning signs:** Tasks enqueued but never executed; Celery logs show "Connected to redis://" with a different host than expected.

### Pitfall 4: Twilio Webhook Fails Validation in Production
**What goes wrong:** Twilio receives a non-200 response and marks the webhook as failed; SMS delivery stops working.
**Why it happens:** In Phase 1, the stub returns 200 without validation — this is intentional. The risk is that when Phase 3 adds signature validation, the URL used for validation does not match the exact URL Twilio is sending to (including protocol, host, and path).
**How to avoid:** The stub should log the full request URL so Phase 3 can construct validation correctly. Add an `x-forwarded-proto` check early.
**Warning signs:** Twilio console shows 403 responses from your webhook URL.

### Pitfall 5: `auth.users` Trigger Fails and Blocks Signup
**What goes wrong:** New user registration fails with a server error because the `handle_new_user` trigger threw an exception (e.g., duplicate key, missing required field).
**Why it happens:** The trigger runs inside the auth signup transaction. If it fails, the entire signup is rolled back.
**How to avoid:** Keep the trigger insert minimal — only `id` (required FK). All other fields (phone, preferences_json) are nullable so there is no reason for the insert to fail. Test the trigger with the Supabase SQL editor before deploying.
**Warning signs:** Supabase Auth logs show "Database error saving new user"; the `auth.users` table has entries but `public.users` does not.

### Pitfall 6: 10DLC Registration Delay Blocks Phase 3
**What goes wrong:** Phase 3 tries to send outbound SMS but Twilio rejects messages because A2P 10DLC registration is not approved yet.
**Why it happens:** Campaign approval takes 10–15 business days. Registration is a CONTEXT.md deferred item but has a long lead time.
**How to avoid:** Start A2P 10DLC brand registration in Twilio Trust Hub as soon as the phone number is provisioned in Phase 1 (even though it is officially "deferred"). Brand registration ($44 one-time) is quick; campaign approval takes the time.
**Warning signs:** Twilio error code 30034 "Message blocked — 10DLC" when sending from unregistered numbers.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@supabase/auth-helpers` | `@supabase/ssr` | 2024 — auth-helpers deprecated | Must use `@supabase/ssr` for new projects; auth-helpers receives no bug fixes |
| `getSession()` server-side | `getClaims()` server-side | late 2024 | `getSession()` does not revalidate tokens server-side; `getClaims()` is the secure replacement |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 2025 — Supabase renamed the key | Both names work; CLAUDE.md uses `ANON_KEY` — keep that name for consistency, same value |
| Celery 4.x | Celery 5.6.2 | 2021+ | Celery 5 dropped Python 2 support; API is stable; all current docs target 5.x |

**Deprecated/outdated:**
- `@supabase/auth-helpers`: Do not install. Use `@supabase/ssr` exclusively.
- `supabase.auth.getSession()` in server code: Replaced by `getClaims()`. Using `getSession()` server-side is a security anti-pattern per current Supabase docs.

---

## Open Questions

1. **PING_TEST_USER_ID for Celery smoke test**
   - What we know: The `tasks.ping()` task writes to `public.messages` which has `user_id NOT NULL`. The table has an RLS policy but the service role key bypasses it.
   - What's unclear: Should the ping task use a fixed test user UUID, or should it omit the user_id write and just log to console? Writing to Supabase proves DB connectivity but requires a valid user to exist.
   - Recommendation: Log to console only in Phase 1 (proves worker is alive and Redis connection works). Add DB write in the first real task in Phase 2 when a real user record exists.

2. **Next.js version — npm registry shows 16.2.0**
   - What we know: CLAUDE.md locks to 15.2. The npm registry latest is 16.2.0 as of this research.
   - What's unclear: Whether `create-next-app@15.2` installs cleanly or if `@15` resolves to 15.x latest.
   - Recommendation: Use `npx create-next-app@15` (installs 15.x latest) and pin the version in package.json. Verify with `next --version` after scaffold.

3. **Railway Celery worker — Nixpacks vs Dockerfile**
   - What we know: Railway can auto-detect Python projects via Nixpacks. A Dockerfile gives more control.
   - What's unclear: Whether Nixpacks correctly installs all Celery dependencies without a Dockerfile.
   - Recommendation: Use a minimal Dockerfile for the Celery worker service to ensure reproducibility. Nixpacks is fine for the Next.js service.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest (Next.js built-in via create-next-app) |
| Config file | `jest.config.ts` — Wave 0 creation needed |
| Quick run command | `npm test -- --testPathPattern=health` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 | User can create account with email/password | smoke (manual) | Manual: create account in browser, check Supabase dashboard | ❌ Wave 0 |
| AUTH-04 | Session persists across browser refresh | smoke (manual) | Manual: log in, hard-refresh, verify session still active | ❌ Wave 0 |
| SYNC-01 | Celery worker accepts and executes ping task | smoke | `celery -A celery_worker.celery_app call tasks.ping` | ❌ Wave 0 |

**Supplementary automated checks (infrastructure verification):**
| Check | Test Type | Automated Command | File Exists? |
|-------|-----------|-------------------|-------------|
| `/api/health` returns 200 with all env vars set | integration | `curl http://localhost:3000/api/health` | ❌ Wave 0 |
| `/api/health` returns 500 when env var missing | unit | `npm test -- --testPathPattern=health` | ❌ Wave 0 |
| Supabase: test record written to each table | integration | `npm test -- --testPathPattern=schema` | ❌ Wave 0 |
| Twilio stub webhook returns 200 | unit | `npm test -- --testPathPattern=webhook` | ❌ Wave 0 |
| RLS blocks unauthenticated read | integration | `npm test -- --testPathPattern=rls` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run lint` (ESLint must pass per CLAUDE.md)
- **Per wave merge:** `npm test` full suite
- **Phase gate:** All 5 success criteria from CONTEXT.md verified manually before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/api/health.test.ts` — covers health endpoint 200/500 behavior
- [ ] `tests/api/sms-webhook.test.ts` — covers Twilio stub returns 200
- [ ] `tests/db/schema.test.ts` — covers test record write to each Supabase table
- [ ] `tests/db/rls.test.ts` — covers unauthenticated access is blocked
- [ ] `jest.config.ts` + `jest.setup.ts` — framework config
- [ ] Python: `celery_worker/tests/test_ping.py` — unit test for ping task (mock Supabase client)

**AUTH-01 and AUTH-04 are manual-only** because they require a real browser + real Supabase auth flow. No useful unit test can substitute for the end-to-end session persistence check.

---

## Sources

### Primary (HIGH confidence)
- [Supabase Auth Server-Side Next.js docs](https://supabase.com/docs/guides/auth/server-side/nextjs) — middleware pattern, client factories, getClaims() vs getSession()
- [Supabase Row Level Security docs](https://supabase.com/docs/guides/database/postgres/row-level-security) — auth.uid() policy patterns
- [Supabase Managing User Data docs](https://supabase.com/docs/guides/auth/managing-user-data) — handle_new_user() trigger pattern
- [Celery 5.6.2 Redis docs](https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html) — broker/backend configuration
- [Railway Variables docs](https://docs.railway.com/reference/variables) — Shared Variables, reference variable syntax
- npm registry: `@supabase/supabase-js@2.99.2`, `@supabase/ssr@0.9.0`, `twilio@5.13.0`, `next@16.2.0` — verified 2026-03-18
- pip: `celery==5.6.2` — verified 2026-03-18

### Secondary (MEDIUM confidence)
- [Railway FastAPI + Celery template](https://railway.com/deploy/fastapi-celery-beat-worker-flower) — three-service topology pattern verified against Railway docs
- [Twilio A2P 10DLC registration guide](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart) — 10–15 day approval timeline
- [Next.js installation docs](https://nextjs.org/docs/app/getting-started/installation) — create-next-app flags, Node 20.9 minimum requirement

### Tertiary (LOW confidence)
- Various community blog posts on Celery + FastAPI + Docker Compose — patterns cross-verified with official Celery and Railway docs; use as reference only

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions verified against npm/pip registry, official docs consulted
- Architecture: HIGH — patterns drawn directly from official Supabase and Celery documentation
- Pitfalls: MEDIUM — items 1–3 verified with official docs; items 4–6 are logical deductions from architecture knowledge and CLAUDE.md gotchas
- Railway deployment topology: MEDIUM — official Railway docs confirm Shared Variables; three-service pattern verified from Railway template

**Research date:** 2026-03-18
**Valid until:** 2026-04-18 (stable ecosystem; @supabase/ssr and Celery 5.x are not fast-moving)
