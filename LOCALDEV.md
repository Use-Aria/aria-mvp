# Aria — Local Development

> How to run Aria V2 on your machine: the local Supabase stack, the Next dev server, the jobs tick, the syllabus parser and the dev chat channel. No Sendblue, Google, Upstash or Vercel account is needed for any of it.
> Deploying: `DEPLOYMENT.md`. Architecture and rules: `CLAUDE.md`.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 (22 works, with an engines warning) | `brew install node@24` |
| Docker Desktop | recent | Runs the local Supabase stack and the parser container |
| Supabase CLI | recent | `brew install supabase/tap/supabase` |
| Python | 3.13 | Only for running the parser tests outside Docker |

```bash
npm install
```

---

## 1. Environment

```bash
cp .env.example .env.local     # never commit .env.local
```

Every variable is listed in `.env.example`, and master plan §4 explains them. For local work you need:

| Var | Local value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | The hosted project's keys. For the local stack, override them per shell (step 2). |
| `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `JOBS_DISPATCH_SECRET` | Generate each with `openssl rand -base64 32`. `APP_ENCRYPTION_KEY` must decode to exactly 32 bytes. |
| `ANTHROPIC_API_KEY` | Needed only for the real agent (`ARIA_AGENT=real`), evals and the grammar smoke |
| `ARIA_AGENT` | Unset or `stub` gives a canned agent and no LLM spend. `real` gives Haiku 5.5. |
| `CHANNEL_PROVIDER` | `dev` |
| `DEV_CHANNEL_SECRET` | Any random string. Needed for `/api/channels/dev` and HTTP-mode dev chat. |
| `PARSER_SERVICE_URL`, `PARSER_SHARED_SECRET` | `http://localhost:8000`, and the same secret as `services/parser/.env.local` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Leave empty. Dev falls back to the DB lease (`user_runtime`) and skips the Upstash rate limits (`rateLimit` allows everything outside production). |
| `APP_BASE_URL` | Optional. It defaults to `http://localhost:3000` outside production. |

Google, Sendblue and Pub/Sub vars stay empty locally. Google features show as "not connected", and Gmail falls back to polling.

---

## 2. Local Supabase stack

```bash
supabase start                 # Docker; applies supabase/migrations/001–003 on first start
supabase status                # API http://127.0.0.1:54321, DB postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

Point a shell at the local stack. Exported variables win over `.env.local`:

```bash
eval "$(supabase status -o env | sed -n \
  -e 's/^API_URL=/export NEXT_PUBLIC_SUPABASE_URL=/p' \
  -e 's/^ANON_KEY=/export NEXT_PUBLIC_SUPABASE_ANON_KEY=/p' \
  -e 's/^SERVICE_ROLE_KEY=/export SUPABASE_SERVICE_ROLE_KEY=/p')"
export CHANNEL_PROVIDER=dev UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN=
```

Prefer the local stack for anything that writes rows. Until the separate `aria-dev` project exists (D11), `.env.local` and production share one hosted project.

The pg_cron tick (`aria-jobs-tick`) runs locally too, but it does nothing until Vault holds the dispatch secrets. Use `npm run dev:tick` instead (step 3).

---

## 3. Run the app

Use three terminals, all from the repo root and all with the step-2 exports when you target the local stack:

```bash
npm run dev                    # 1. Next dev server, http://localhost:3000
npm run dev:tick               # 2. POSTs /api/jobs/dispatch every 2s (reads JOBS_DISPATCH_SECRET from .env.local)
npm run dev:chat -- --local    # 3. chat REPL as a fictional 555-01xx handle
```

- `dev:tick` makes the dev server claim **every** due job in the target database, using whatever agent `ARIA_AGENT` selects.
- `dev:chat` runs in-process by default and doesn't need the dev server for a single turn. Keep `dev:tick` running anyway so that reminders, retries and follow-up jobs fire.
- `dev:chat` REPL commands: `/burst a | b | c` sends three messages that become one debounced turn. `/react 1 love` sends a tapback. `/proactive test` delivers a test proactive item. `/reset` deletes the dev user and every row that cascades from it. `/quit` exits.
- HTTP mode (`npm run dev:chat -- --local --http`) goes through `/api/channels/dev` on the dev server and needs `DEV_CHANNEL_SECRET`.
- Web pages open through magic links that Aria texts. In the REPL, ask for "settings" or "my week" and open the printed link.

---

## 4. Syllabus parser

```bash
cp services/parser/.env.example services/parser/.env.local
# set PARSER_SHARED_SECRET (same value as the app's) and PARSER_FAKE_LLM=1 for a canned extraction (no Anthropic spend)
docker compose up --build parser          # http://localhost:8000/healthz
```

`docker-compose.yml` defines only this service. The container never sees the app's `.env.local`.

Parser tests (offline):

```bash
cd services/parser && python3.13 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # once
(cd services/parser && .venv/bin/pytest -q)
```

---

## 5. Tests

| What | Command | Needs |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | — |
| Lint | `npm run lint` | — |
| Unit | `npm test` | — |
| DB smoke | `env -u ANTHROPIC_API_KEY npm run smoke` (one file: `npm run smoke -- tests/smoke/jobs.smoke.test.ts`) | Local stack (found through `supabase status`). `SMOKE_TARGET=env` uses the exported Supabase vars instead. |
| Strict-tool grammar | `SMOKE_LLM=1 npm run smoke -- tests/smoke/llm-grammar.smoke.test.ts` | `ANTHROPIC_API_KEY` exported. Costs about $0.005. Run it after any change to tool schemas, few-shots or the style guide. |
| Agent evals | `npm run evals` | Real Supabase and Anthropic. Prints a cost report. |
| Web e2e | `npm run e2e` | `npm run dev` |
| Chat e2e | `npm run e2e:chat` | `npm run dev`, `npm run dev:tick`, the parser (`PARSER_FAKE_LLM=1`), `ARIA_AGENT=real` and a key |
| Parser | `(cd services/parser && .venv/bin/pytest -q)` | The venv from step 4 |

Smoke, evals and e2e create throwaway rows and delete them afterwards. `llm_calls` rows survive user deletion with `user_id` nulled, so any cleanup must delete them explicitly.

---

## 6. Running a TS script outside Next

`import "server-only"` throws outside the Next runtime, so run scripts with the react-server condition:

```bash
npx tsx --conditions=react-server --env-file=.env.local scripts/check-llm-cache.ts
```

---

## 7. Migrations

Migrations live in `supabase/migrations/`.
- **Local stack:** `supabase start` applies them on first start.
- **Hosted project:** `supabase db push` applies them to the linked project, and only with Daniel's go-ahead.
- **Types:** regenerate after a schema change with `supabase gen types typescript --linked --schema public > src/server/db/types.ts`.
