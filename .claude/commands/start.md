# /project:start

Use this to resume after a **mid-session context reset** — context was cleared but you're continuing the same task.

Use `/project:begin` instead if this is a fresh session (new day, opening your laptop).

---

## 1. Pull latest
```bash
git checkout main && git pull origin main
git checkout dev && git pull origin dev
```
Stop and resolve any merge conflicts before continuing.

---

## 2. Read context files
- `PROGRESS.md` — where we left off, next steps, architecture gotchas
- `WORK.md` — confirm your task is still claimed, check for new handoff notes

Do **not** read `CLAUDE.md` unless you hit something unfamiliar.

---

## 3. Orient — output 3 lines only
> **Current task:** [task name from WORK.md]
> **Last thing done:** [one line from PROGRESS.md]
> **Next action:** [exact next step from PROGRESS.md]

---

## 4. Resume on the right branch
```bash
git checkout feature/[branch-from-WORK.md]
```

Continue work. Ask clarifying questions before writing code.

---

## Branching rules
```
main  ← never push code here directly
  └── dev  ← feature branches merge here via PR
        └── feature/[task-name]  ← all work happens here
```

## Session rules
- `git add -p` always — never `git add .`
- Never push code directly to `main` or `dev`
- Run `npm run lint` before every commit
- Run `/project:save` before clearing context again
- Run `/project:done` when the task is complete
