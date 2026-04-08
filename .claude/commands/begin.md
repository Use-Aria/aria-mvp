# /project:begin

Use this at the **very start of a new work session** — opening your laptop, starting a new day, picking up after time away.
This is the deep-context version. It reads everything, plans the session, then claims work before writing a line of code.

Use `/project:start` instead if you're resuming after a mid-session context reset.

---

## Step 1 — Pull latest

```bash
git checkout main && git pull origin main
```

If there are merge conflicts, stop and resolve before continuing.

---

## Step 2 — Read all context files (in this order)

1. `WORK.md` — read this **first**. Note every task in "Currently In Progress" — these are locked. Read all Handoff Notes carefully, they may change what you work on today.
2. `PROGRESS.md` — full current state: last session summary, next steps, architecture gotchas
3. `FEATURES.md` — skim the checklist to understand overall completion state
4. `.planning/ROADMAP.md` — skim upcoming phases to understand what comes after today's work

---

## Step 3 — Output a session briefing

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 SESSION BRIEFING — [Date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MILESTONE:    [active milestone name]
PROGRESS:     [X of Y phases complete]

COMPLETED:
  ✅ [phase] — [one line what it does]
  ✅ [phase] — [one line what it does]
  (all completed phases, one line each)

LOCKED (teammate working on this — do not touch):
  🔒 [Dev: task name and files they own]
  (or "Nothing claimed" if WORK.md is clear)

HANDOFF NOTES:
  [paste any unread notes from WORK.md, or "None"]

LAST SESSION:
  [one line from PROGRESS.md]

GOTCHAS FOR TODAY:
  [2–3 most relevant entries from the Architecture Gotchas table]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Step 4 — Identify the developer

Ask: **"Josh, Seb, or Daniel?"**

**Daniel** (CTO) owns:
- Everything — full oversight across all areas

**Josh** owns:
- `src/lib/`, `src/app/api/`, `celery_worker/`, `supabase/`

**Seb** owns:
- `mobile/`, `src/app/(pages)/`, `src/components/`

**Both Josh + Seb** (must call each other before changing):
- `src/types/index.ts`, `supabase/migrations/`

Then from `WORK.md` "Up Next", show the top 3 unclaimed tasks available for this developer:

```
AVAILABLE FOR [JOSH / SEB / DANIEL]:
  1. [task-id] — [task name] — [one line: what it involves]
  2. [task-id] — [task name] — [one line: what it involves]
  3. [task-id] — [task name] — [one line: what it involves]

Recommended: #[N] — [one sentence reason: priority, dependencies, unblocks teammate]
```

Ask: **"Which task do you want to work on, or do you have something else in mind?"**

---

## Step 5 — Plan the session

Once the developer picks a task, before claiming anything:

State clearly:
1. **Files that will be touched** — list them
2. **Gotchas** — any entries from the Architecture Gotchas table relevant to this task
3. **Definition of done** — exactly what will be true when this task is complete (tests passing, feature working, files updated)
4. **What this unblocks** — what the other developer can do next once this is merged

Ask: **"Does this match what you had in mind, or do you want to adjust scope?"**

Only proceed once the developer confirms.

---

## Step 6 — Claim the task and push to git

Update `WORK.md` "Currently In Progress":
```
| [Dev] | [task-id] — [description] | main | [date + time] |
```

Push the claim to main:
```bash
git add WORK.md
git commit -m "chore: [dev] claimed [task-id] — [short description]"
git push origin main
```

Confirm: **"Claimed. Working on main. Let's build."**

---

## Step 7 — Begin work

Ask any remaining clarifying questions before writing code.
Keep the Architecture Gotchas from PROGRESS.md in mind throughout.

---

## Session rules
- `git add -p` always — never `git add .`
- Never push `--force`
- Never touch the other developer's ownership area
- Run `npm run lint` before every commit
- Run `/project:save` before clearing context mid-session
- Run `/project:done` when the task is complete
