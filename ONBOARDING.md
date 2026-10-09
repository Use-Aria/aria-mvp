# Aria — Developer Onboarding

> Paste this into Claude Code to get started immediately:
> **"Read ONBOARDING.md and help me get set up to start developing"**

---

## What You're Building

Aria is a proactive AI personal assistant for college students. It unifies Canvas deadlines, syllabus topics, personal tasks, and schedule into one SMS-based assistant — no new app, just a smart text message layer.

Read `CLAUDE.md` for full architecture, ownership rules, and code style. Read `WORK.md` before every session to see what's in progress and what's available to claim.

---

## Prerequisites

Install these before anything else:

| Tool | Version | Install |
|---|---|---|
| Node.js | 18+ | https://nodejs.org or `brew install node` |
| Python | 3.11+ | https://python.org or `brew install python` |
| Git | any | `brew install git` |
| Claude Code | latest | `npm install -g @anthropic-ai/claude-code` |

---

## Step 1 — Clone and Install Dependencies

```bash
git clone https://github.com/your-org/aria-mvp.git
cd aria-mvp
npm install
```

---

## Step 2 — Set Up Environment Variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in every value. Contact Josh (backend) or Daniel (CTO) to get the actual secrets — never commit this file.

```
NEXT_PUBLIC_SUPABASE_URL=        # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # Supabase anon key (safe for frontend)
SUPABASE_SERVICE_ROLE_KEY=       # Supabase service role key (server only)
GOOGLE_CLIENT_ID=                # Google Cloud Console OAuth client
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=             # e.g. http://localhost:3000/api/auth/callback/google
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WEBHOOK_URL=              # ngrok URL for local dev (see Step 4)
REDIS_URL=                       # redis://localhost:6379 for local dev
ANTHROPIC_API_KEY=               # Claude API key from console.anthropic.com
```

---

## Step 3 — Run the App Locally

```bash
npm run dev
```

App runs at `http://localhost:3000`.

```bash
npm run lint     # must pass before every commit
cd celery_worker && pytest   # worker tests
cd mobile && npx jest        # mobile tests
```

---

## Step 4 — Twilio Webhook (SMS dev only)

Twilio needs a public URL to send inbound SMS to. Use ngrok:

```bash
brew install ngrok
ngrok http 3000
```

Copy the `https://xxxx.ngrok.io` URL and set it as `TWILIO_WEBHOOK_URL` in `.env.local`. Also update it in your Twilio console under the phone number's webhook settings.

---

## Step 5 — Supabase Migrations

```bash
npx supabase login
npx supabase db push
```

This runs all migrations in `supabase/migrations/`. Never write SQL directly against the DB — always create a migration file.

---

## Step 6 — Read WORK.md and Claim a Task

```bash
git checkout main && git pull origin main
```

Open `WORK.md`. Read it fully:
- **Currently In Progress** — do not touch these
- **Up Next** — pick an unclaimed task
- Claim it by adding your row to "Currently In Progress" and pushing to main before you start

**Ownership rules (enforced — do not cross these):**

| Developer | Owns |
|---|---|
| Josh | `src/lib/`, `src/app/api/`, `supabase/` |
| Seb | `src/app/(pages)/`, `src/components/` |
| Both | `src/types/index.ts` (sync before every change) |

---

## Step 7 — Start Your Session in Claude Code

Claude Code reads `CLAUDE.md` automatically. Start by asking it to orient you:

```
Let's start. Where were we?
```

Claude follows the Session Protocol in `CLAUDE.md`: it pulls, reads `WORK.md`, and tells you the current task and next step. When you're done, say **"wrap up"**. Claude runs lint, build and tests, updates `WORK.md`, writes your handoff note, then commits and pushes. It stops and asks if checks fail, if there are changes it didn't make, or if migrations or shared types changed.

---

## Git Workflow

```bash
git checkout main && git pull origin main   # always start from latest
# ... do work ...
git add -p                                  # review each change individually
git commit -m "feat: descriptive message"
git push origin main
```

**Never `git add .`. Never `git push --force`.**

---

## Key Files to Know

| File | What it is |
|---|---|
| `CLAUDE.md` | Full architecture, stack, ownership, code style — read this |
| `WORK.md` | Active work state — read before every session |
| `FEATURES.md` | Feature checklist — update after every push |
| `src/types/index.ts` | Shared `Task`, `CalendarEvent`, `Message` types |
| `.env.example` | All required environment variables |
| `supabase/migrations/` | Database schema history |
| `docs/history/` | Original build history — roadmap, requirements, phase plans & summaries (Mar–Apr 2026) |

---

## Who to Contact

| Question | Ask |
|---|---|
| Backend, API, DB, infra | Josh Shin |
| Frontend, mobile, UI | Sebastian Alvaro Cuervo |
| Architecture, secrets, access | Daniel Lee (CTO) |
