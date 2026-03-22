# /project:done

Run this when a feature is complete and ready to merge.

---

## 1. Lint + build + test
```bash
npm run lint    # fix all errors before continuing
npm run build   # fix any TypeScript errors
npm test        # all tests must pass
```

---

## 2. Update PROGRESS.md
- "What We Accomplished" — what shipped, one line per item
- "Current State" — update phase status table
- "Next Steps" — exact next actions
- "Architecture Gotchas" — append anything new discovered this session
- Be concise — one line per item

---

## 3. Update FEATURES.md
- Mark completed features as `✅ Done`

---

## 4. Push MD files directly to main
PROGRESS.md, FEATURES.md, and WORK.md are coordination files — both devs need to see them immediately, not after a PR review.

```bash
git checkout main
git pull origin main
git add PROGRESS.md FEATURES.md
git commit -m "chore: update session docs — [short description]"
git push origin main
git checkout feature/[branch-name]
```

---

## 5. Commit and push feature branch (code only)
```bash
git add -p     # review every change — never git add .
git commit -m "feat: [description]

- [bullet 1]
- [bullet 2]"

git push origin feature/[branch-name]
```

---

## 5. Open PR: feature → dev
Open a PR from `feature/[branch-name]` → **`dev`** (not main).
Tag the other developer for review. **Do not merge without review.**

PR title format: `feat: [short description]`

---

## 7. After PR is merged to dev — update WORK.md
- Remove your row from "Currently In Progress"
- Add a row to "Completed"
- Add a Handoff Note (see format below)

```bash
git checkout main
git pull origin main
git add WORK.md
git commit -m "chore: complete [task-id] — [short description]"
git push origin main
```

---

## 8. Update Notion MVP Progress Log
⚠️ This step is mandatory. Do not skip it.
Page ID: `32729f27-120a-8196-937f-dc119584390c`

**a) Update the Feature Status table** — change the status cell for any phase that changed.

**b) Prepend a Push Log entry** above the first `---` + `###` block:

```
---

### [✅ or 🚧] Push #[N] — [Month Day, Year]
**[Phase name — one line]**
[1 sentence: what can the student do now that they couldn't before? No jargon, no file names.]
- [specific thing shipped]
- [specific thing shipped]
- [specific thing shipped]
- [specific thing shipped]
**Next:** [next task — one line]
```

Rules: plain English lead sentence, 3–5 bullets, under 12 lines total, don't reformat existing entries.

---

## Handoff note format

```markdown
### [Date] — [Josh / Seb]
**Done:** [task-id] — [feature name]
**Files changed:** [key files only]
**Gotchas:** [env vars, schema changes, API quirks the other dev needs to know]
**Next up:** [task-id] — [description] — ready to start
```

⚠️ If you changed `supabase/migrations/` or `src/types/index.ts` — call the other developer before merging.

---

## Branching reminder
```
feature/[x]  →  PR into dev  →  reviewed  →  merged
dev          →  PR into main →  milestone boundary or deployment only
main         ←  WORK.md coordination commits only (direct push allowed)
```
