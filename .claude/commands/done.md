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

## 4. Commit and push to main
```bash
git add -p     # review every change — never git add .
git commit -m "feat: [description]

- [bullet 1]
- [bullet 2]"

git push origin main
```

---

## 5. Update WORK.md
- Remove your row from "Currently In Progress"
- Add a row to "Completed"
- Add a Handoff Note (see format below)

```bash
git add WORK.md
git commit -m "chore: complete [task-id] — [short description]"
git push origin main
```

---

## 8. Update Notion MVP Progress Log
🚨 **THIS STEP IS REQUIRED. THE SESSION IS NOT DONE UNTIL NOTION IS UPDATED.**
🚨 **DO NOT SKIP. DO NOT DEFER. DO NOT SUMMARIZE AND MOVE ON.**

Page ID: `32729f27-120a-8196-937f-dc119584390c`

**a) Update the Feature Status table** — change the status cell for any phase that changed.

**b) Prepend a Push Log entry** above the first `---` + `###` block:

```
---

### [✅ or 🚧] Push #[N] — [Month Day, Year] at [H:MM AM/PM] EST
**[Phase name — one line]**
[1 sentence: what can the student do now that they couldn't before? No jargon, no file names.]
- [specific thing shipped]
- [specific thing shipped]
- [specific thing shipped]
- [specific thing shipped]
**Next:** [next task — one line]
```

Rules: plain English lead sentence, 3–5 bullets, under 12 lines total, don't reformat existing entries.

✅ After updating Notion, confirm by saying: "Notion updated — Push #[N] logged at [time] EST."
**IMPORTANT: Always use current time in EST (UTC-5), not PT or any other timezone.**
If Notion update fails for any reason, report the error explicitly and retry before finishing.

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

## Git reminder
- Always `git add -p` — never `git add .`
- Never `git push --force`
- Always `git pull origin main` before pushing if you've been away
