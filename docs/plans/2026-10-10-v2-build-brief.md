# Aria V2 — Build Brief for Sub-agents (2026-10-10)

> Every planning and implementation agent reads this first. It pins the shared contracts so parallel work fits together.
> Canonical docs: `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md` (spec), `docs/plans/2026-10-09-aria-v2-free-testing-plan.md` (what we build now), `docs/v1-to-v2-changes.md`.

## Where things stand

- **V2-01 done.** New Supabase project `onrurwsourjlgfmitezh` (CLI linked). Applied: `supabase/migrations/001_v2_baseline.sql` (25 tables, RLS deny-all, no policies) and `002_jobs_extensions.sql` (pg_cron, pg_net). Generated types: `src/server/db/types.ts` (regenerate with `supabase gen types typescript --linked --schema public > src/server/db/types.ts`).
- **V2-02 mostly done.** `src/server/{env,phone,ratelimit,viewer}.ts`, `src/server/db/index.ts` (service-role client `db()`), `src/server/security/{crypto,link-policy,magic-links,sessions}.ts`, `src/shared/sms-link.ts`, pages `/` `/m` `/link-expired` `/week` `/setup`, routes `/api/signup` `/api/session/redeem`. `src/server/llm/index.ts` = LLM gateway (`runModel`, routes chat/escalate/classify/memory/briefing/syllabus).
- **Being done in parallel (foundation agent):** V1 TS app code removed (`src/app/api/*` V1 routes, `src/lib`, `src/middleware.ts`), Next.js 15.5 → **16.4.0**, Jest set up. `mobile/` and `celery_worker/` stay until salvage is ported (V2-05 Canvas parse, university list), then get deleted at the end.

## Locked decisions

- iMessage via **Sendblue sandbox** (≤10 contacts, shared number). No credentials yet → build against Sendblue docs + a **dev channel provider** so the whole loop runs locally without Sendblue.
- **TypeScript app** (Next.js 16 on Vercel Hobby) + a **small Python FastAPI parser service** called over HTTPS with a shared secret. **Never a cross-language queue. No Celery.**
- **Redis = Upstash** (REST, serverless) for the per-user debounce window, conversation run-lease, and rate limits. Postgres `jobs` table + Supabase Cron (pg_cron → pg_net → `/api/jobs/dispatch`, HMAC) for scheduled/delayed work. Local dev must work without Upstash (fallback documented per use).
- LLM: **Claude Haiku 5.5** main (`claude-haiku-5-5`), **Sonnet 5.5** escalation (`claude-sonnet-5-5`), **escalation capped at 10% of turns**. All calls through `src/server/llm`. Log every call to `llm_calls`.
- Calendar writes go to a dedicated **"Aria" calendar**. Persona **mirrors the user's register**. Message history retention **180 days**. Domain: `*.vercel.app`.
- Canvas: **iCal only** (no NetID vault). Gmail in from day one (own OAuth client, "In production", unverified).
- **Friend-protections (must hold):** (1) email is sent only by deterministic code after the user confirms a `pending_actions` row — the model never has a send tool; (2) only user-authored chat text can create memories or trigger actions — email/Canvas/calendar text is wrapped as untrusted data; (3) ask before connecting a friend's accounts (Aria offers links; never auto-connects).
- **Skipped for the free test:** CASA/verification, formal TCPA flow, age gate, ToS/privacy, backups, PWA install/pairing, nightly consolidation, WhatsApp, Canvas vault.

## Shared contracts (all branches code against these)

| Module | Contract |
|---|---|
| `src/server/db` | `db()` service-role client; `Tables<"name">` row types. Never import from client components. |
| `src/server/env` | `requireEnv`, `optionalEnv`, `appBaseUrl()`, `appOrigin()`, `isProduction`. |
| `src/server/security` | `encryptSecret/decryptSecret(value, parseKey(APP_ENCRYPTION_KEY))` for anything secret at rest (OAuth tokens, iCal URL). `mintMagicLink({userId,purpose,target?,preview?})` returns URL or null (rate-limited). Sessions: `currentSession()`, `canChangeIntegrations(session)`, `revokeAllSessions(userId)`. |
| `src/server/jobs` | `enqueueJob({kind, userId?, runAt?, payload?, dedupeKey?})` (upsert on pending dedupe_key; debounce pushes `run_at`). Handlers registered per kind in `src/server/jobs/kinds/index.ts` (`Record<JobKind, JobHandler>`). Dispatch route `/api/jobs/dispatch` claims with `FOR UPDATE SKIP LOCKED` (SQL function via RPC), retries with backoff, dead-letters. **V2-03 owns this module**; others only add a kind file + one registry line. |
| `src/server/channels` | `ChannelProvider` interface (send text, react, typing, media, parse+verify webhook). Adapters: `sendblue`, `dev`. `deliver(userId, plan: ReplyPlan, opts: {proactive: boolean, reason: string})` applies guards (opt-out, pause, quiet hours, daily proactive cap) — proactive messages that are suppressed are **deferred, not dropped**. **V2-03 owns.** |
| `src/server/agent` | Tool registry: each tool is a file in `src/server/agent/tools/` exporting `defineTool({name, description, input: zodSchema, run(ctx, input)})`; registry `tools/index.ts` exports a deterministic array (stable order → prompt cache). `ctx` = `{userId, runId, now, timezone, channel}`. **V2-04 owns** the loop/registry; other branches add tool files + one registry line. |
| `src/server/memory` | profile, preferences (propose → confirm), facts (FTS recall), extraction from user-authored text only. **V2-04 owns.** |
| `src/server/timeline` | Upsert/read `timeline_items` keyed by `(user_id, source, external_id)`; urgency computed at read time. **V2-05 owns**; V2-07 (gcal) and V2-08 (syllabus) write through it. |
| `src/server/integrations/{canvas,google,syllabus}` | Per-integration clients. Owners: V2-05, V2-07, V2-08. |
| `services/parser/` | Python FastAPI service (`POST /parse-syllabus`, optionally `/parse-ical`), Dockerfile, pytest. **V2-08 owns.** |
| Schema | Branch plans list their **schema delta** (SQL). The orchestrator consolidates all deltas into **one** migration `003_v2_build.sql`, pushed once, before implementation. Implementation agents never write migrations. Any table added must `enable row level security`. |
| Dependencies | Branch plans list npm/pip deps with exact versions (prefer releases ≥2 weeks old). The orchestrator installs them once. Implementation agents never run `npm install`. |

## Conventions

- TypeScript strict, **no `any`**, JSDoc on every exported function (input/output), `camelCase` vars, `PascalCase` types, `snake_case` DB columns. `try/catch` around external calls; log with handles masked (`maskHandle`), never message bodies or tokens.
- Server code under `src/server/`; it must never be imported from a `"use client"` file. Shared pure code under `src/shared/`.
- Pure logic in pure modules with unit tests (Jest, `tests/unit/**`). No `MagicMock`-style call-chain tests — test real logic (parse/diff, slot finding, DST, debounce/lease, guards, renderer). DB-touching code gets a smoke script against the real project with throwaway rows that are deleted afterwards.
- Implementation agents: do not `git commit/push`, do not run `next build` concurrently (use `npx tsc --noEmit`, `npx eslint <files>`, `npm test`); the orchestrator runs the full build.
- Timezones: store UTC, compute in the user's IANA zone (`users.timezone`), DST-safe. Use `Intl` (no moment). Display local times in messages.

## Missing credentials (build against docs; verify later)

Sendblue (API key/secret, signing secret, number), Google OAuth client + Pub/Sub topic, Upstash Redis, OpenAI (fallback), Sentry, deployed `APP_BASE_URL`. Each plan lists the exact env vars it needs and the "verify when creds arrive" checks.
