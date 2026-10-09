# Stack Research

**Domain:** Proactive AI assistant — SMS delivery, multi-source data sync, background jobs, Claude AI
**Researched:** 2026-03-18
**Confidence:** MEDIUM-HIGH (Next.js and Anthropic SDK verified from official sources; Celery/Supabase versions from training data + architecture reasoning)

---

## Critical Stack Decision: Next.js 14 vs 15

CLAUDE.md specifies "Next.js 14 (App Router)" but **Next.js 15.2 is the current stable release** (published February 2025; docs last updated 2026-03-13). This is the most important correction to make before starting development.

**Verdict: Upgrade to Next.js 15.x. Do not start on 14.**

Reasons:
- 14 will reach end-of-life support faster
- 15 has a codemod CLI (`npx @next/codemod@canary upgrade latest`) that automates migration — it's easier to start on 15 than to migrate later
- React 19 stable (required for 15.1+) is now the default
- GET Route Handlers are no longer cached by default in 15 — this is the correct behavior for Aria's webhook endpoints

**Breaking changes to know before writing any code:**
1. `params`, `cookies`, `headers` are now async — must `await params` in route handlers and pages
2. GET Route Handlers uncached by default — no need for `export const dynamic = 'force-dynamic'` on webhook endpoints
3. Minimum Node.js: **18.18.0**

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Next.js | 15.2 | Frontend + API routes + webhook handlers | Current stable. App Router is the right pattern for this project. Turbopack dev is now stable (76% faster local startup). Railway has an official Next.js deploy template. |
| React | 19.x | UI framework | Required by Next.js 15.1+. Now stable. |
| TypeScript | 5.x | Type safety | Strict mode. Non-negotiable given the normalized data model and two-developer team. |
| Tailwind CSS | 3.4.x | Styling | Industry standard with Next.js. No reason to deviate. |
| FastAPI | 0.115.x | Python AI job processing | Correct choice. Python ecosystem is required for Celery. FastAPI is async-native, auto-documents endpoints for Josh, and is production-grade at Railway. Do not use Flask (synchronous) or Express (wrong language for Celery workers). |
| Celery | 5.4.x | Background job queue | Correct choice for this stack. Python-native, Redis-backed, handles Canvas 60-min sync and deadline alert jobs. Workers run on Railway alongside FastAPI. See alternatives section for why Inngest/BullMQ are wrong for this project. |
| Redis | 7.x | Celery broker + result backend | Required by Celery. Also usable for rate-limit tracking (Canvas 120 req/min). Railway provides managed Redis. |
| Supabase | 2.x JS client | PostgreSQL database + Auth + Storage | Correct choice. Relational schema fits `Task/CalendarEvent/Message` model. Auth handles Google OAuth token storage. Row-level security enforces user data isolation. |
| Anthropic Python SDK | 0.86.0 | Claude API for AI jobs (FastAPI side) | Current stable as of 2026-03-18. Use for syllabus parsing (Opus), briefing generation (Sonnet), deadline classification (Haiku). |
| Anthropic TypeScript SDK | 0.80.0 | Claude API for SMS replies (Next.js side) | Current stable as of 2026-03-18. Use for conversational SMS reply handling in the Next.js API layer. |

### Supporting Libraries — Node.js / Next.js

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@supabase/supabase-js` | 2.x | Supabase JS client | All Supabase operations from Next.js |
| `@supabase/ssr` | 0.x | Supabase SSR helpers for Next.js App Router | Required for cookie-based auth in App Router — replaces deprecated `@supabase/auth-helpers-nextjs` |
| `node-ical` | 0.18.x | Parse Canvas iCal feeds | Parses VEVENT entries to extract assignment/exam data. TypeScript types included. Actively maintained. |
| `twilio` | 5.x | Twilio SMS send/receive | Official Node.js SDK. Use for outbound briefings and validating inbound webhook signatures. |
| `googleapis` | 144.x | Google Calendar + Gmail OAuth | Official Google API client for Node.js. Handles token refresh automatically with `google-auth-library`. |
| `pdf-parse` | 1.1.x | PDF text extraction for syllabus upload | Extract raw text before sending to Claude Opus. Lightweight, no native dependencies. |
| `zod` | 3.x | Runtime schema validation | Validate Twilio webhook payloads, iCal data, API request bodies. Required given strict TypeScript mode. |
| `@anthropic-ai/sdk` | 0.80.0 | Claude API (TypeScript) | Conversational SMS replies from Next.js API layer |

### Supporting Libraries — Python / FastAPI

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `anthropic` | 0.86.0 | Claude API (Python) | All Claude jobs running through FastAPI/Celery workers |
| `celery[redis]` | 5.4.x | Task queue with Redis broker | Background Canvas sync, briefing generation, deadline classification |
| `supabase-py` | 2.x | Supabase Python client | Reading/writing from Celery workers to Supabase |
| `google-api-python-client` | 2.x | Google Calendar (Python side) | If GCal sync jobs run as Celery tasks |
| `pydantic` | 2.x | Data validation | FastAPI uses Pydantic v2 natively. Use for all request/response schemas. |
| `httpx` | 0.27.x | Async HTTP client | Async iCal fetching from Celery tasks. Better than `requests` for async contexts. |
| `python-dotenv` | 1.x | Environment variable loading | Dev environment secrets |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| ngrok | Expose local Twilio webhook | Required for local SMS testing. Twilio cannot hit localhost. Run `ngrok http 3000`. |
| Supabase CLI | Local Supabase dev + migrations | `npx supabase db push` for migration workflow. Use `supabase start` for local dev. |
| ESLint 9 | Linting | Next.js 15 ships with ESLint 9 support. Use flat config format. |
| Jest | Testing | Next.js default. Use for integration tests of iCal parsing and data normalization. |
| pytest | Python testing | Celery task tests, FastAPI endpoint tests. |

---

## Installation

```bash
# Next.js 15 project (if starting fresh)
npx create-next-app@latest aria-mvp --typescript --tailwind --app

# Or upgrade existing 14 to 15
npx @next/codemod@canary upgrade latest

# Core Next.js dependencies
npm install next@latest react@latest react-dom@latest

# Supabase (use @supabase/ssr, NOT deprecated auth-helpers)
npm install @supabase/supabase-js @supabase/ssr

# Integrations
npm install twilio googleapis node-ical pdf-parse zod

# Anthropic TypeScript SDK
npm install @anthropic-ai/sdk

# Dev dependencies
npm install -D @types/node @types/react @types/react-dom typescript eslint eslint-config-next jest @types/jest ts-jest
```

```bash
# Python / FastAPI requirements.txt
fastapi==0.115.*
uvicorn[standard]==0.34.*
celery[redis]==5.4.*
anthropic==0.86.*
supabase==2.*
pydantic==2.*
httpx==0.27.*
python-dotenv==1.*
google-api-python-client==2.*
google-auth-httplib2==0.2.*
google-auth-oauthlib==1.*
```

---

## Alternatives Considered

### Background Job Queue

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Celery + Redis | Inngest | If the entire stack were TypeScript and you wanted durable functions with retries and observability built in. Inngest is TypeScript-native; it cannot natively run Python Celery workers. Switching to Inngest would mean rewriting all AI jobs in TypeScript — wrong for a Python AI workload. |
| Celery + Redis | BullMQ | If there were no Python layer at all (pure Next.js monolith). BullMQ is a Redis-backed queue for Node.js. It is excellent but requires all workers to be JavaScript/TypeScript. For Aria, the AI jobs (Celery) are in Python, so BullMQ would split the queue across two brokers. |
| Celery + Redis | pg-boss | If you want to eliminate the Redis dependency and run jobs from PostgreSQL. Supabase already provides PostgreSQL. The tradeoff: pg-boss is Node.js only (same language problem as BullMQ), and job throughput is lower than Redis-backed queues. Worth reconsidering in Phase 2 if Redis cost becomes a concern. |
| Celery + Redis | Temporal | If this were a multi-year enterprise workflow engine. Temporal is exceptional for long-running workflows but requires a separate Temporal server, significant operational overhead, and has a steep learning curve. Overkill for 50-user MVP. |

### Frontend Framework

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Next.js 15 (App Router) | Next.js 14 | Never for a new project in March 2026. 14 is feature-frozen; 15 is stable with significant DX improvements. |
| Next.js 15 (App Router) | Remix | If server-side data loading patterns were more complex and nested routing was critical. Next.js is the right choice here given Vercel deployment and the full-stack pattern (API routes + frontend in one repo). |

### Database

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Supabase | Firebase/Firestore | If the data model were document-oriented (it is not). Aria's data is relational: users → integrations → deadlines → syllabi. Supabase's PostgreSQL with RLS is the correct choice. |
| Supabase | PlanetScale / Neon | If you needed serverless PostgreSQL with branching. Supabase provides Auth + Storage + Realtime on top of PostgreSQL — replacing it with PlanetScale would require separate auth. Supabase is the right integrated choice. |

### Vector Database

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Chroma (CLAUDE.md) | pgvector (Supabase extension) | **Reconsider Chroma.** Supabase now supports the `pgvector` extension natively. For 50-user MVP with syllabus embeddings, storing vectors directly in Supabase eliminates a separate infrastructure dependency. Chroma requires a separate running server (Railway service). Use pgvector unless you need Chroma's advanced similarity search features. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@supabase/auth-helpers-nextjs` | Deprecated. Does not support Next.js App Router cookie handling correctly. | `@supabase/ssr` |
| Next.js 14 | Feature-frozen. New projects should start on 15. Async Request API patterns differ, causing confusion when reading 15 docs while running 14. | Next.js 15.2 |
| Flask | Synchronous WSGI framework. Cannot pair with Celery's async task patterns correctly. Will block under load. | FastAPI (ASGI, async-native) |
| `requests` library in Celery tasks | Synchronous. Blocks the Celery worker thread during iCal fetches. | `httpx` with async task patterns |
| Chroma (for MVP) | Requires a separate server process on Railway. For syllabus embeddings at 50-user scale, this is unnecessary complexity. | Supabase pgvector extension |
| LangChain | Heavy abstraction layer that obscures what Claude is doing, makes debugging harder, and adds dependency drift risk. For direct Anthropic API calls (briefings, replies, parsing), the Anthropic SDK is sufficient. | `anthropic` SDK directly |
| `node-fetch` | Polyfill-era package. Next.js 15 runs on Node.js 18.18+ which has native `fetch`. | Native `fetch` or `httpx` |
| Sendblue (MVP) | iMessage API, explicitly deferred to Phase 2 in CLAUDE.md. Do not introduce it during MVP. | Twilio SMS |

---

## Stack Patterns by Variant

**For Canvas iCal sync (background job):**
- Celery beat schedules the job every 60 minutes
- Celery worker (FastAPI service on Railway) fetches iCal via `httpx`
- Diff is computed against last-synced Supabase records
- On change: insert to `deadlines` table, publish diff event
- Do NOT hit iCal more than once per hour — Railway Celery worker handles rate discipline

**For Twilio inbound webhook:**
- Route Handler: `src/app/api/sms/webhook/route.ts` — POST handler
- Next.js 15 GET handlers are uncached by default; POST handlers were never cached — no config needed
- Validate Twilio signature using `twilio` npm package before processing
- Trigger Claude (Sonnet) reply via `@anthropic-ai/sdk` from the Next.js layer (low latency required for SMS replies)
- Do NOT route SMS reply generation through Celery — the round-trip to Python is too slow for conversational responses

**For syllabus PDF parsing (heavy AI job):**
- Upload via `src/app/api/upload/syllabus/route.ts`
- Store raw PDF in Supabase Storage
- Dispatch Celery task to FastAPI worker
- Worker extracts text with `pdfplumber` or `pymupdf`, sends to Claude Opus via `anthropic` Python SDK
- Store structured JSON result in `syllabi` table
- Never re-parse — once stored, use the `parsed_json`

**For daily briefing (scheduled job):**
- Celery beat fires at 8am in user's timezone (store timezone in `users.preferences_json`)
- Worker assembles last 14 days of deadlines + 7 days of calendar from Supabase
- Sends to Claude Sonnet via `anthropic` Python SDK
- Posts result to Twilio via `twilio` Python SDK (or calls Next.js internal API)

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| Next.js 15.x | Node.js >= 18.18.0 | Minimum version. Railway supports Node.js 20 LTS by default — use that. |
| Next.js 15.x | React 19.x | Required for App Router. 15.x also supports React 18 on Pages Router but Aria uses App Router. |
| `@supabase/ssr` | Next.js 15.x | The SSR package handles App Router cookie patterns correctly. |
| Celery 5.4.x | Python 3.9+ | Python 3.11 or 3.12 recommended for Railway — better async performance. |
| `anthropic` 0.86.0 | Python 3.8+ | Use Python 3.11+ for performance. |
| FastAPI 0.115.x | Pydantic v2 | FastAPI dropped Pydantic v1 support. Use Pydantic v2 throughout. |
| `zod` 3.25+ | `@anthropic-ai/sdk` 0.79+ | SDK 0.79 fixed a Zod v3.25 import path issue. Versions match correctly. |

---

## CLAUDE.md Flags — Decisions That Need Revisiting

The following items in CLAUDE.md/PROJECT.md differ from current best practices:

| CLAUDE.md Decision | Current Reality | Recommendation |
|--------------------|-----------------|----------------|
| "Next.js 14 (App Router)" | Next.js 15.2 is stable and current | Start on 15.2. Use the codemod if CLAUDE.md was already used to scaffold. |
| "Chroma (syllabus embeddings)" | Supabase now has native pgvector | Replace Chroma with `pgvector` extension. Eliminates one Railway service. Only revisit Chroma if similarity search performance becomes a bottleneck beyond 50 users. |
| Model ID `claude-haiku-4-5-20251001` | Verify this model ID is correct | The Anthropic SDK release notes reference `claude-haiku` variants — verify exact model string before first API call. Use `anthropic.models.list()` to confirm available models. |
| No mention of `@supabase/ssr` | `@supabase/auth-helpers-nextjs` is deprecated | Use `@supabase/ssr` package for all Next.js App Router + Supabase Auth integration. |

---

## Sources

- Next.js 15 blog post — https://nextjs.org/blog/next-15 (published October 2024) — HIGH confidence
- Next.js 15.1 blog post — https://nextjs.org/blog/next-15-1 (published December 2024) — HIGH confidence
- Next.js 15.2 blog post — https://nextjs.org/blog/next-15-2 (published February 2025) — HIGH confidence
- Next.js upgrade guide (v14→v15) — https://nextjs.org/docs/app/building-your-application/upgrading/version-15 (last updated 2026-03-13) — HIGH confidence
- Next.js Route Handlers docs — https://nextjs.org/docs/app/api-reference/file-conventions/route (version 16.2.0, last updated 2026-03-03) — HIGH confidence
- Next.js deploying docs — https://nextjs.org/docs/app/getting-started/deploying (last updated 2026-02-27) — HIGH confidence
- Anthropic Python SDK releases — https://github.com/anthropics/anthropic-sdk-python/releases (v0.86.0, 2026-03-18) — HIGH confidence
- Anthropic TypeScript SDK releases — https://github.com/anthropics/anthropic-sdk-typescript/releases (v0.80.0, 2026-03-18) — HIGH confidence
- FastAPI docs — https://fastapi.tiangolo.com — MEDIUM confidence (version number not confirmed from official source)
- Celery 5.4.x, Redis 7.x, Supabase JS 2.x — MEDIUM confidence (training data; official sources blocked during research session)
- BullMQ, pg-boss, Inngest comparison — MEDIUM confidence (architecture reasoning + training data; recommend verifying Inngest TypeScript-only claim before finalizing)

---

*Stack research for: Aria — proactive AI student assistant*
*Researched: 2026-03-18*
