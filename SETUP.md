# Aria — Seb's Machine Setup Guide

> Complete this top to bottom before your first Claude Code session.
> Estimated time: 45–60 minutes.
> Do Part 1–3 first. Parts 4–6 can run while you work.

---

## Part 1 — Prerequisites

### Step 1 — Confirm Node.js version

```bash
node --version   # needs to be v18 or higher
npm --version
```

If not installed or outdated:
```bash
brew install node
```

### Step 2 — Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude --version   # confirm it installed
```

### Step 3 — Clone the repo

```bash
git clone https://github.com/joshlnnn/aria-mvp.git
cd aria-mvp
npm install
```

### Step 4 — Confirm git identity

```bash
git config user.name "joshlnnn"
git config user.email "alvaro.cuervo@yale.edu"
```

---

## Part 2 — GitHub Personal Access Token

You need this for the GitHub MCP and for pushing to the repo.

1. Go to **github.com/settings/tokens → Tokens (classic)**
2. Click **Generate new token (classic)**
3. Name it `aria-dev`
4. Select scopes: `repo`, `read:org`
5. Copy the token — you'll use it in Part 3

For git push auth, set your remote URL:
```bash
git remote set-url origin https://YOUR_TOKEN@github.com/joshlnnn/aria-mvp.git
```

---

## Part 3 — MCP Configuration

Create or edit `~/.claude/mcp.json` with the following. Replace placeholder values with your real keys.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_GITHUB_TOKEN"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/aria-mvp"
      ]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "YOUR_BRAVE_API_KEY"
      }
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "YOUR_SUPABASE_CONNECTION_STRING"
      ]
    }
  }
}
```

**Where to get the keys:**

| Key | Where to get it |
|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | From Step 4 above |
| `BRAVE_API_KEY` | [brave.com/search/api](https://brave.com/search/api) — free tier is fine |
| `SUPABASE_CONNECTION_STRING` | Supabase dashboard → Project Settings → Database → Connection string (URI) |

After saving, open Claude Code and run:
```
/mcp
```
You should see all 5 servers listed as connected. If any fail, check your key values.

> **Note:** Start with GitHub + Filesystem + Brave Search first. Add Memory and Postgres once Supabase is set up.

---

## Part 4 — Power Tools

### GSD (Get Shit Done)

Prevents context rot across long sessions. Spawns fresh Claude instances per task with clean 200k context windows. Essential for building 7+ integrations without degraded output.

```bash
npx get-shit-done-cc --claude --global
```

Docs: [github.com/gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done)

---

### Superpowers

Enforces TDD and structured debugging inside Claude Code. Particularly useful when wiring up OAuth flows and external APIs where bugs hide easily.

Open Claude Code in the `aria-mvp` directory and run:
```
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

Docs: [github.com/obra/superpowers](https://github.com/obra/superpowers)

---

### supermemory (Cross-Session Memory)

Persists architectural decisions across sessions — and across machines, so what Josh's Claude learns about Aria is also available to your Claude.

```bash
# In Claude Code
/plugin marketplace add supermemoryai/claude-supermemory
/plugin install supermemory@claude-supermemory
```

Docs: [github.com/supermemoryai/claude-supermemory](https://github.com/supermemoryai/claude-supermemory)

---

## Part 5 — External Service Setup

### Google Cloud (Gmail + Calendar OAuth)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project called `aria-mvp`
3. Enable these APIs:
   - **Gmail API**
   - **Google Calendar API**
4. Go to **Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
7. Download the credentials JSON — you'll need the Client ID and Secret

---

### Canvas API Token

1. Log into your Yale Canvas account
2. Go to **Account → Settings → Approved Integrations → New Access Token**
3. Name it `aria-dev`, no expiration
4. Copy and save the token

---

### Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project called `aria-mvp`
2. Choose the closest region (US East)
3. Save the database password — you won't see it again
4. From the project dashboard, grab:
   - **Project URL** (`NEXT_PUBLIC_SUPABASE_URL`)
   - **Anon/Public key** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
   - **Service role key** (`SUPABASE_SERVICE_ROLE_KEY`) — under Settings → API
   - **Connection string** (for the Postgres MCP above) — under Settings → Database

---

### Twilio (SMS for MVP)

1. Go to [twilio.com](https://twilio.com) and create an account
2. Get a phone number (free trial gives you one)
3. From the console, grab:
   - **Account SID**
   - **Auth Token**
   - **Phone Number**
4. For local webhook testing, install ngrok: `brew install ngrok/ngrok/ngrok`
5. Run `ngrok http 3000` to expose your local server for Twilio callbacks

---

### Sendblue (iMessage — for production)

1. Sign up at [sendblue.co](https://sendblue.co)
2. Get a number provisioned (takes minutes)
3. Grab your **API Key** and **API Secret** from the dashboard
4. Test by sending a message to your own number from the Sendblue dashboard before writing any code

---

## Part 6 — Environment Variables

Create `.env.local` in the root of `aria-mvp`. **Never commit this file.**

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Google OAuth
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback/google

# Twilio (SMS MVP)
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

# Sendblue (iMessage production)
SENDBLUE_API_KEY=your_key
SENDBLUE_API_SECRET=your_secret

# Claude / Anthropic
ANTHROPIC_API_KEY=your_key

# Spotify (Phase 2 — leave blank for now)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# Todoist (Phase 2 — leave blank for now)
TODOIST_CLIENT_ID=
TODOIST_CLIENT_SECRET=
```

Confirm `.env.local` is in `.gitignore`:
```bash
grep ".env.local" .gitignore   # should return a result
```

---

## Part 7 — Pre-Session Checklist

Run this every morning before starting a Claude Code session:

```bash
# 1. Pull latest
git checkout main && git pull origin main

# 2. Create your branch
git checkout -b feature/your-task-name

# 3. Start the dev server (separate terminal)
npm run dev

# 4. Open Claude Code
claude
```

Inside Claude Code:
```
/mcp                    ← verify all servers are connected
/project:start          ← run the start slash command
```

**Best opening prompt:**
```
Read CLAUDE.md. I'm Seb, working on frontend.
Today I'm building: [specific feature from FEATURES.md].
Do not touch any files in src/lib/ or src/app/api/ — those are Josh's.
Ask me clarifying questions before writing any code.
```

---

## Part 8 — Verify Everything Works

Run these checks before writing a single line of app code:

```bash
npm run dev       # should start on localhost:3000 with no errors
npm run lint      # should pass clean
npm run build     # should complete with no TypeScript errors
```

Inside Claude Code:
```
/mcp              # all 5 MCPs green
/memory           # supermemory initialized
```

Test a Sendblue message to your own phone. If it arrives as a blue bubble, you're ready.

---

## Quick Reference

| Task | Command |
|---|---|
| Start Claude Code | `claude` in project root |
| Check MCPs | `/mcp` |
| Start a session | `/project:start` |
| Finish a task | `/project:done` |
| Reset context | `/clear` |
| Check token usage | `/cost` |
| Pull latest | `git pull origin main` |
| Create branch | `git checkout -b feature/name` |
| Stage carefully | `git add -p` |
| Start dev server | `npm run dev` |

---

> **If anything in this guide is outdated or unclear, update it and push.
> This file is the source of truth for machine setup.**
