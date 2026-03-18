# /project:start

Run this at the beginning of every Claude Code session — no exceptions.

## Steps

1. **Pull latest**
   ```bash
   git pull origin main
   ```
   If there are merge conflicts, stop and resolve them before continuing.

2. **Read these files in full:**
   - `project_context.md` — TL;DR of entire project state (read this first, reduces context)
   - `WORK.md` — what's claimed, what's done, what's next
   - `CLAUDE.md` — full architecture, stack, ownership rules (if you need deeper detail)

3. **Check for active claims in WORK.md**
   Look at the "Currently In Progress" table. Do not touch anything already claimed by another developer.

4. **Identify the developer**
   Ask: "Are you Josh (backend) or Seb (frontend)?"
   - Josh: owns `src/lib/`, `src/app/api/`, `supabase/`
   - Seb: owns `src/app/(pages)/`, `src/components/`
   - Both: `src/types/index.ts` (sync before changing)

5. **Pick a task**
   From the "Up Next" queue in `WORK.md`, suggest the next 3 available (unclaimed) tasks for this developer. Ask which one they want.

6. **Claim the task** — update `WORK.md` "Currently In Progress" table:
   ```markdown
   | [Developer] | [Feature ID] — [Description] | feature/[branch-name] | [date + time] |
   ```

7. **Create a branch**
   ```bash
   git checkout -b feature/[feature-name]
   ```
   Branch naming: `feature/canvas-ical-sync`, `feature/twilio-webhook`, `fix/oauth-refresh`

8. **Commit the claim** so the other developer sees it immediately:
   ```bash
   git add WORK.md
   git commit -m "chore: claim [feature-id] — [short description]"
   git push origin feature/[branch-name]
   ```
   Also push a WORK.md update to main:
   ```bash
   git stash
   git checkout main
   git add WORK.md
   git commit -m "chore: [dev] claimed [feature-id]"
   git push origin main
   git checkout feature/[branch-name]
   git stash pop
   ```

9. **Begin work.** Ask any clarifying questions before writing code.

## Session rules
- Never modify files outside your ownership area
- Never use `git add .` — always `git add -p`
- Never push directly to `main` (code changes)
- WORK.md claim updates to main are the only exception to the no-push-to-main rule
- Run `npm run lint` before any commit
