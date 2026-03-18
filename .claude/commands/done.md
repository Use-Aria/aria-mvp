# /project:done

Run this when a feature is complete and ready to push.

## Steps

1. **Lint check** — run `npm run lint`. Fix any errors before continuing.
2. **Build check** — run `npm run build`. Fix any TypeScript or build errors.
3. **Test** — run `npm test`. All tests must pass.
4. **Update FEATURES.md** — mark the completed feature(s) as ✅ Done. Add any relevant notes.
5. **Update the Push Log** in FEATURES.md:
   - Add a new entry at the top of the Push Log
   - Include: branch name, features touched (F-XX), what was done, build status, next up
6. **Stage changes** — use `git add -p` to review and stage each change. Never `git add .`
7. **Commit** with a clear message:
   ```
   feat: [description of what was built]

   - [bullet of specific change 1]
   - [bullet of specific change 2]
   ```
8. **Push** — `git push origin feature/[branch-name]`
9. **Remind the developer** to open a PR on GitHub and tag the other developer for review.
10. **Post a handoff note** — summarize what was built, what's left, and any gotchas the other developer needs to know.

## Handoff note format
```
✅ Done: [feature name]
📁 Files changed: [list key files]
⚠️ Gotchas: [anything the other dev needs to know]
➡️ Next: [what should be built next, with feature ID]
```
