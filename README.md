# Aria

A proactive AI assistant for college students that lives in iMessage. You text Aria, and it knows your Canvas deadlines, syllabus exams, calendar and important email. It answers questions, sets reminders, books study blocks on its own "Aria" calendar, drafts email (sent only after you confirm), and texts you a daily briefing. There's no app. Setup happens on mobile-web pages that open from texted links.

**Status:** V2 free private test (Daniel plus a few friends on the Sendblue sandbox). Not deployed yet. See `PRODUCTION.md`.

## Stack

- Next.js 16 on Vercel (Hobby), TypeScript
- Supabase Postgres, with a `jobs` table driven by pg_cron and pg_net
- Upstash Redis for the run lease and rate limits
- Sendblue iMessage, plus a local `dev` channel provider
- Claude Haiku 5.5 as the main model, escalating to Sonnet 5.5 (≤10% of turns)
- A Python FastAPI syllabus parser (`services/parser/`) on Google Cloud Run

## Quick start (local)

```bash
npm install
cp .env.example .env.local            # fill in; see LOCALDEV.md
supabase start                        # local Postgres stack (Docker)
npm run dev                           # http://localhost:3000
npm run dev:tick                      # second terminal: runs due jobs
npm run dev:chat -- --local           # third terminal: talk to Aria over the dev channel
```

Run the tests with `npm test`, then `env -u ANTHROPIC_API_KEY npm run smoke`, then `(cd services/parser && .venv/bin/pytest -q)`.

## Docs

| File | What |
|---|---|
| `CLAUDE.md` | Architecture, rules, commands, gotchas (read first) |
| `LOCALDEV.md` | Running everything locally |
| `DEPLOYMENT.md` | Deploying (Vercel, Cloud Run parser, Supabase) |
| `PRODUCTION.md` | Launch checklist and production dependencies |
| `WORK.md` | Live work state and handoff notes |
| `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md` | Product spec and architecture |
| `docs/plans/2026-10-10-v2-master-plan.md` | Build contracts, env vars, runbooks |
| `docs/v1-to-v2-changes.md` | What changed from V1 and why |
