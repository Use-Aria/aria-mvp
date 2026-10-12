# Aria — Claude Development Guide

> Read this file at the start of every session. It holds the permanent facts: architecture, rules, commands and gotchas. Live state is in `WORK.md`.

---

## Project overview

Aria is a proactive AI assistant for college students that lives in iMessage. There is no app to download. A student texts Aria, and Aria texts back. It knows their Canvas deadlines, syllabus exams, calendar and important email. It answers questions, sets reminders, books study blocks on a dedicated "Aria" calendar, drafts email (sent only after the student confirms), and sends a daily briefing. Setup and settings happen on mobile-web pages that open from texted magic links.

- **Engineer:** Daniel Lee (CTO, sole engineer since 2026-10). All accounts are under Daniel's control.
- **Stage:** V2 free private test (Daniel plus up to 9 friends on the Sendblue sandbox). V1 (Expo app + Twilio SMS + Celery) never launched and has been removed. `docs/v1-to-v2-changes.md` explains the switch.
- **Canonical docs:**
  - Spec: `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md`
  - What we build now: `docs/plans/2026-10-09-aria-v2-free-testing-plan.md`
  - Build contracts, owners, env vars, runbooks: `docs/plans/2026-10-10-v2-master-plan.md` (it wins over the branch plans `docs/plans/2026-10-10-v2-0*.md` and `…-v2-web-surfaces.md`)
  - Decisions made during the build: `docs/plans/2026-10-10-v2-orchestrator-notes.md`

---

## Architecture

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router, Turbopack) on **Vercel Hobby**, Node 24, TypeScript strict, Tailwind 4 |
| Code split | `src/server/**` is server-only (every file starts with `import "server-only";`). `src/shared/**` holds pure, client-safe code. `src/app/**` holds pages and route handlers. |
| Database | Supabase Postgres, migrations `supabase/migrations/001`–`003`. RLS is deny-all, so all access goes through the service-role client `db()` (`src/server/db`). |
| Scheduled work | Postgres `jobs` table. The pg_cron `aria-jobs-tick` (every 15s) uses pg_net to POST an HMAC-signed request to `/api/jobs/dispatch`, which claims due jobs (`FOR UPDATE SKIP LOCKED`), retries with backoff and dead-letters. The 19 job kinds are registered in `src/server/jobs/kinds/index.ts`. Vercel Cron is the daily backstop (`vercel.json`): `/api/jobs/dispatch` and `/api/cron/daily` (reconcile + heartbeat). `.github/workflows/keepalive.yml` keeps Supabase Free awake. |
| Locks and rate limits | Upstash Redis (REST) holds the per-user run lease and the rate limits. Without Upstash, dev falls back to a DB lease (`acquire_user_lease`) and skips the Upstash rate limits, while production fails closed: the lease throws and `rateLimit` denies. The debounce window lives in the jobs row (D1). |
| Channel | Sendblue iMessage (SMS fallback for Android) behind a `ChannelProvider` interface (`src/server/channels/providers/`). The `dev` provider (`POST /api/channels/dev`, which returns 404 in production) runs the whole loop locally without Sendblue. |
| Agent | A tool-using loop (`src/server/agent/`, 31 tools in a fixed order) over one LLM module (`src/server/llm/`). The main model is **Claude Haiku 5.5** (`claude-haiku-5-5`, cached static prefix). It escalates to **Sonnet 5.5** (`claude-sonnet-5-5`), capped at 10% of turns by the atomic `claim_escalation`. Every call is logged to `llm_calls`. |
| Routes (`src/server/llm/routes.ts`) | Haiku: chat, classify, memory, summary, briefing, eval_judge. Sonnet: escalate, draft, syllabus. |
| Syllabus parser | A Python 3.13 FastAPI service (`services/parser/`) on **Google Cloud Run**. The TS app calls it over HTTPS with an HMAC shared secret, never through a queue. It parses with Sonnet 5.5 native PDF input and escalates to Opus 5.5. It uses its own Anthropic key (D6). |
| Integrations | Canvas through the iCal feed only (`src/server/integrations/canvas/`, hourly sync). Google through one OAuth client: Calendar read plus the "Aria" calendar (`calendar.app.created`), Gmail read with Pub/Sub push, and Gmail send (`src/server/integrations/google/`). Syllabus PDFs arrive by chat attachment or `/setup` upload (`src/server/integrations/syllabus/`). |
| Timeline | All deadlines, events, exams and blocks live in `timeline_items` keyed by `(user_id, source, external_id)`. Urgency is computed at read time (`src/server/timeline/`). |
| Web | Mobile-first pages under `src/app/(app)/`: `/setup`, `/week`, `/email/[id]`, `/settings`. Plus `/`, `/m` (magic-link redeem), `/privacy` and `/terms`. Sessions are our own (`src/server/security/`), not Supabase Auth. |
| Secrets at rest | AES-256-GCM through `encryptSecret`/`decryptSecret` (`src/server/security/crypto.ts`) with `APP_ENCRYPTION_KEY`. This covers OAuth tokens and the Canvas feed URL. |

**Inbound message flow:**
1. Sendblue webhook → verify signature → idempotent message upsert → debounced `conversation_turn` job (`src/server/pipeline/`).
2. Per-user lease → `runAgentTurn` → `ReplyPlan`.
3. `deliver` applies the guards: opt-out, pause, quiet hours, daily proactive cap. Proactive messages that are suppressed are deferred, not dropped.
4. The provider sends 1–3 bubbles, a tapback, or a typing indicator.

### Friend-protections (must always hold)

1. **No email leaves without a confirm.** Only deterministic code sends email (`gmail/send.ts`), and only after the user confirms a `pending_actions` row in chat (from a later turn) or on the web. The model has no send tool, and eslint restricts `sendRaw` imports to `gmail/send.ts`.
2. **Only user-authored chat text can create memories or trigger actions.** Email, Canvas, calendar and syllabus text is wrapped as untrusted data.
3. **Ask before connecting a friend's accounts.** Aria offers links and never connects on its own.

### Build rules (master plan §1.0, still in force)

- **Frozen contract files** change only on purpose, with every caller updated in the same change: `src/server/{channels,pipeline,jobs,agent,timeline}/types.ts`, `jobs/kinds/index.ts`, `agent/tools/index.ts` (tool order is the prompt-cache key), `agent/pending/{types,executors/index}.ts`, `integrations/google/gmail/types.ts`, the `integrations/{canvas,google}/index.ts` barrels, `src/shared/scheduling-constraints.ts`, `src/shared/email-draft.ts`. `tests/unit/contracts/registry.test.ts` pins the kind and tool names and their order.
- **Model-facing ids are aliases.** These are a kind prefix plus 8 hex characters (`t_`, `m_`, `s_`, …) from the run's `AliasTable`. Tools resolve them with `ctx.aliases.resolve(alias, kind)`. Raw UUIDs and Gmail ids are never accepted from the model.
- **Evidence rule.** Every tool with `mutates: true` takes `evidence`, which must resolve to a user-authored inbound `m_`/`x_` alias in this run. Proactive runs therefore fail closed.
- **Untrusted rule.** All third-party text goes through `wrapUntrusted` (`src/server/agent/untrusted.ts`) before it reaches any prompt.
- **Server-only.** `import "server-only";` at the top of every `src/server/**` file. Never import server code into a `"use client"` file.

---

## Data model

- **Source of truth:** the migrations in `supabase/migrations/` (`001_v2_baseline.sql`, `002_jobs_extensions.sql`, `003_v2_build.sql`) and the generated types in `src/server/db/types.ts` (26 tables: users, channels, messages, reactions, jobs, timeline_items, reminders, pending_actions, integrations, syllabi, email_items, user_profile, user_preferences, memory_facts, agent_runs, llm_calls, and others). Regenerate the types with `supabase gen types typescript --linked --schema public > src/server/db/types.ts`.
- **Contract types** are in the frozen `types.ts` files above. The old V1 `Task`/`CalendarEvent`/`Message` model no longer exists.
- **Schema changes** go in a new numbered migration. Never edit an applied one. Every new table needs `enable row level security`.

---

## Repo map

```
src/app/              pages + route handlers (api/channels, api/jobs/dispatch, api/cron/daily, api/google/*, api/syllabus/upload, api/me/export, …)
src/server/           server-only modules (channels, pipeline, jobs, agent, llm, memory, timeline, integrations, reminders, briefing, proactive, alerts, account, security, web, db)
src/shared/           pure client-safe modules (time/tz, course-key, register, copy, universities, canvas-guide, …)
services/parser/      Python syllabus parser (FastAPI, Dockerfile, pytest)
supabase/migrations/  SQL migrations 001–003
scripts/              dev-chat.ts, dev-tick.ts, check-llm-cache.ts, ops/configure-jobs-tick.sql, assets/
tests/unit/           Jest unit tests          tests/smoke/     DB smoke tests (local stack by default)
tests/e2e/            Playwright web e2e       tests/e2e-chat/  dev-channel conversation test
evals/                agent evals (real Anthropic)
docs/                 specs, plans, history (V1 archive)
```

Environment variables: `.env.example` (names only) and master plan §4. Parser env: `services/parser/.env.example`. Local setup: `LOCALDEV.md`. Deploy: `DEPLOYMENT.md`. Launch checklist: `PRODUCTION.md`.

---

## Commands

```bash
npm run dev                                   # Next dev server, http://localhost:3000
npm run dev:tick                              # POST /api/jobs/dispatch every 2s (local stand-in for the pg_cron tick)
npm run dev:chat -- --local                   # chat REPL against the local Supabase stack (dev channel, in-process)
docker compose up --build parser              # local parser on http://localhost:8000 (PARSER_FAKE_LLM=1 for canned output)

npm run lint                                  # ESLint
npx tsc --noEmit                              # typecheck (also: npm run typecheck)
npm test                                      # Jest unit suite (tests/unit)
env -u ANTHROPIC_API_KEY npm run smoke        # all DB smoke tests, no model calls (local stack via `supabase status`)
SMOKE_LLM=1 npm run smoke -- tests/smoke/llm-grammar.smoke.test.ts   # strict-tool grammar check; needs ANTHROPIC_API_KEY exported (~$0.005)
npm run evals                                 # agent evals, real Anthropic spend
npm run e2e                                   # Playwright web e2e (needs npm run dev)
npm run e2e:chat                              # scripted dev-channel conversation (needs dev + dev:tick + parser + a real key)
(cd services/parser && .venv/bin/pytest -q)   # parser tests, offline
npm run build                                 # production build
supabase db push                              # apply migrations to the linked project (only with Daniel's go-ahead)
```

---

## Session protocol (Claude follows this automatically)

**At session start** (the first message of a session, or "let's start" / "where were we"):
1. Run `git pull origin main` so you start from the latest code.
2. Read `WORK.md`: Currently In Progress, Up Next, and the latest Handoff Notes.
3. Orient in 3 lines: **Current task**, **Last thing done**, **Next action**.

**On "wrap up"** (or "save", "done for today", "let's stop", "checkpoint", or similar), and before calling any task finished:
1. Run the checks that apply and report failures honestly:
   - always `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`
   - `env -u ANTHROPIC_API_KEY npm run smoke` if DB code changed
   - the grammar smoke if tool schemas, few-shots or `persona/style-guide.ts` changed
   - `(cd services/parser && .venv/bin/pytest -q)` if `services/parser/` changed
2. Update `WORK.md`: the In Progress table, checked-off Up Next items, and any new items you found.
3. Add a Handoff Note at the top of the notes in `WORK.md` with the date, what was done, what's open, and anything the next session must know.
4. Keep only the **3 most recent** Handoff Notes in `WORK.md`. Move older ones to the top of `docs/history/handoffs.md`.
5. If a new permanent lesson came up, add a row to *Implementation gotchas* below.
6. Update `FEATURES.md` if a feature changed status. Update `PRODUCTION.md` whenever work reveals a new production dependency.
7. **Commit and push.**
   - Stage only the files this session changed. Never `git add .`.
   - Split commits by area and use conventional messages (`feat:`, `fix:`, `docs:`, `chore:`).
   - Push to `main` and report the commit hashes.
   - **Stop and ask instead** if any check failed, if the diff contains changes this session didn't make, or if `supabase/migrations/` changed (migrations need Daniel's explicit go-ahead before `supabase db push`).

Memory lives in git: `CLAUDE.md` for permanent facts, `WORK.md` for live state, `docs/history/` for the archive. Don't create other state files.

**Ownership:** single engineer (Daniel). There are no ownership areas or collision rules. During a multi-agent build, the orchestrator assigns one owner per file for the duration of a wave (master plan §5).

---

## Git workflow

```bash
git checkout main && git pull origin main     # start of every session
git add -p <files>                            # review each change; never `git add .`
git commit -m "feat(area): descriptive message"
git push origin main                          # never `git push --force`
```

Never commit `.env.local` or `services/parser/.env.local`.

---

## Code style

- TypeScript strict mode. **No `any`**: define the type instead.
- `camelCase` for variables and functions, `PascalCase` for components and types, `snake_case` for DB columns.
- **JSDoc on every export**, describing input and output.
- Put `try/catch` around every external call. Log to the console and return a typed error.
- Logs carry masked handles only (`maskHandle`). Never log message bodies, tokens, feed URLs or secrets.
- Times are stored in UTC and computed in the user's IANA zone (`src/shared/time/tz.ts`, DST-safe, `Intl` only). Messages show local times.
- Pure logic goes in pure modules with real unit tests. DB code gets a smoke test with throwaway rows that are deleted afterwards.

---

## Implementation gotchas

> Lessons learned while building. These will bite again. Add a row during "wrap up" whenever you find a new one.

| Gotcha | Rule |
|---|---|
| Lazy import patching | Patch or mock at the SOURCE module, never the importing module (Jest `jest.mock` and the parser's pytest fakes alike) |
| Google OAuth verification | `gmail.readonly` is a **restricted** scope (full verification needs CASA). The free test runs the consent screen "In production", unverified (≤100 users lifetime, each user clicks through the warning). Never leave it on "Testing", which expires refresh tokens after 7 days. Test one Yale account first, since EliApps may block unverified apps. |
| GCal/Gmail watch expiry | Watch channels expire within 7 days. The `gcal_watch_renew` / `gmail_watch_renew` job kinds renew them, and the periodic history sync is the backstop |
| Syllabus PDF bytes | Never persisted and never logged. They live only in memory for one request. Re-sends are caught by the `pdf_sha256` hash guard before any parser or LLM call |
| V2: build orchestration | Master plan `docs/plans/2026-10-10-v2-master-plan.md` wins over branch plans; frozen contract files (§1.0) change only via the orchestrator; read `docs/plans/2026-10-10-v2-orchestrator-notes.md` before any V2 task |
| V2: scripts outside Next | `import "server-only"` throws outside the Next runtime. Run TS scripts with `npx tsx --conditions=react-server --env-file=.env.local <file>` |
| V2: Jest env | Jest does not load `.env.local`; tests needing crypto set a throwaway `APP_ENCRYPTION_KEY`. Smoke tests target the local Supabase stack (`supabase start`, Docker) |
| V2: magic-link redeem | Never set `Referrer-Policy: no-referrer` site-wide — browsers then send `Origin: null` on form POSTs and the redeem Origin check fails. Use `same-origin` |
| V2: headless screenshots | Headless Chrome enforces a 500px minimum window width — "mobile" shots at 390px are clipped artifacts; check at 500px or use device emulation |
| V2: Next 16 dev files | `next dev` rewrites `next-env.d.ts` and (re)creates `AGENTS.md` (points agents at `node_modules/next/dist/docs/`) — commit them, don't fight them |
| V2: Anthropic structured output | Very large JSON schemas are rejected ("compiled grammar is too large"); keep model-facing schemas flat (V2-08 parser) and strip `$schema` before `zodOutputFormat`. Sonnet 5.5 rejects `thinking: {type: "disabled"}` |
| V2: strict tool grammar | The API caps the *compiled grammar* of all strict tools + the reply format together; `strictBudget` (counts) can't see it. Never mark a nested-schema tool `strict` (`propose_preference` isn't). After any tool-schema change run `SMOKE_LLM=1 npm run smoke -- tests/smoke/llm-grammar.smoke.test.ts` |
| V2: llm_calls cleanup | `llm_calls.user_id` is nulled (not cascaded) on user delete — smoke/eval/live-check cleanup must delete those rows explicitly |
| V2: deterministic ordering | Never break `order()` ties on a uuid `id` alone — it's random, so same-timestamp rows (e.g. two all-day deadlines) flip between runs. Add a meaningful tie-break first (`timeline/store.ts#queryRange`: anchor, title, id) |
| V2: smoke tests + real key | Exporting `ANTHROPIC_API_KEY` (for the grammar smoke) makes every smoke that reaches a model path call real Haiku. Smoke files that assume no model `delete process.env.ANTHROPIC_API_KEY` up front; run the full suite with `env -u ANTHROPIC_API_KEY npm run smoke` |
| V2: local dev tick | `npm run dev:tick` makes the dev server claim **every** due job in the target DB with the real agent. Tests that enqueue due jobs must scope them (future `run_at`, own user) instead of calling `runDueJobs` unscoped |
| V2: shared dev/prod DB | Until the `aria-dev` project exists (D11), local dev and prod share one Supabase project. Once Vault holds the tick secrets, the prod tick can claim local-dev jobs, which dead-letter harmlessly because prod refuses the `dev` provider. Prefer the local stack (`supabase start`, `dev:chat -- --local`) |
| V2: dev channel secret | HTTP-mode `dev:chat` and the dev webhook need `DEV_CHANNEL_SECRET`, which is not in `.env.local` by default. In-process `dev:chat` doesn't need it |
| V2: "…and book it" | With one fitting slot Aria still asks before booking (Daniel's decision, 2026-10-10). Don't change `src/server/agent/persona/style-guide.ts:45` |
| V2: full smoke vs dev tick | Stop `npm run dev:tick` before `env -u ANTHROPIC_API_KEY npm run smoke`. Otherwise the dev server claims smoke jobs with the real agent (`turn.smoke` fails, and real `llm_calls` rows leak) |
| V2: Playwright vs `next dev` | Overlapping server-action responses never finish streaming under `next dev`, so e2e runs with one worker (`playwright.config.ts` default; `E2E_WORKERS` overrides). `npm run e2e` runs only the four device projects. Never run bare `playwright test`: the `assets` project rewrites the icons in `public/` |
| V2: load-sensitive suites | `npm run e2e:chat`, Playwright and the unit suite share the machine. Under heavy load (build, evals, parallel agents), turns take 100s+ and Jest hooks hit their 5s timeout. Run them one at a time before calling a failure real |
| V2: Google writes never auto-retry | Non-idempotent Google POSTs (`messages.send`, `events.insert`, `calendars.insert`) use `googleFetch({retry:"none"})`. An ambiguous failure (`isWriteOutcomeUnknown`) is resolved by looking (Sent folder `rfc822msgid:`, `findEventByAriaKey`, owned-calendar list), never by resending. Any new Google write must pick a retry policy explicitly |
| V2: turn replay | A failed or aborted turn is replayed only if `replaySafe` (`pipeline/turn.ts`): no outbound rows and no successful or timed-out mutating call. Otherwise it stays consumed and sends a fallback. New mutating tools must leave evidence (`tool_calls`, a `run_id` column) |
| V2: `npm run e2e -- --project=X` | Adds to the four pinned device projects instead of narrowing them. For one device: `npx playwright test --project=X <spec>` (never bare, never `assets`) |
| V2: action lock + claim check | Once a run reads email or `syllabus_info` text, every mutating tool except `draft_email` returns `ACTION_LOCKED` (`agent/loop.ts`), and `draft_email` then also needs a drafting request in the student's own text (`agent/draft-intent.ts`). Timeline/calendar titles don't lock (Daniel, 2026-10-10). A final answer that claims an action with no mutating call gets one `<aria_note>` re-prompt (`agent/claim-check.ts`). Keep both when changing the loop; evals cover them |

---

## Privacy and safety

- OAuth tokens and the Canvas feed URL are encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`, backed up in the password manager. Losing the key makes them unrecoverable).
- Handles are masked in logs (`maskHandle`: last 4 digits of a phone, the domain of an Apple ID; spec §3.22, Daniel confirmed 2026-10-11). Message bodies, email content and syllabus text are never logged.
- Message history is kept for 180 days (`retention_purge`). The welcome rows are the only exception: they are kept so returning users aren't re-welcomed, and their bodies are nulled. Account deletion (chat or `/settings`) runs `deleteAccount` right away, and an `account_purge` job acts as the safety net. `llm_calls` rows survive with `user_id` nulled; they hold cost accounting only, no content.
- Canvas is accessed through the iCal feed only. Never use grades, submissions or enrollment records.
- Crisis rule (D9): the persona answers self-harm cues with care and the 988 line.
