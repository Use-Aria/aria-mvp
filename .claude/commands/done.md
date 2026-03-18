# /project:done

Run this when a feature is complete and ready to push.

## Steps

1. **Lint check**
   ```bash
   npm run lint
   ```
   Fix all errors before continuing. No exceptions.

2. **Build check**
   ```bash
   npm run build
   ```
   Fix any TypeScript or build errors.

3. **Test**
   ```bash
   npm test
   ```
   All tests must pass.

4. **Update FEATURES.md**
   - Mark completed feature(s) as `✅ Done`
   - Add any relevant notes in the Notes column

5. **Add Push Log entry to FEATURES.md**
   Add at the top of the Push Log section:
   ```markdown
   ### ✅ Push #[N] — [Date]
   **Branch:** `feature/[branch-name]`
   **Features:** [F-XX]
   **What was done:**
   - [bullet of specific change]
   - [bullet of specific change]
   **Next up:** [F-XX] — [description]
   ```

6. **Stage and commit**
   ```bash
   git add -p   # review each change — never git add .
   git commit -m "feat: [description]

   - [bullet 1]
   - [bullet 2]"
   ```

7. **Push feature branch**
   ```bash
   git push origin feature/[branch-name]
   ```

8. **Open PR on GitHub**
   Tag the other developer for review. Do not merge without review.

9. **Update WORK.md** — do this immediately after the PR is merged to main:
   - Remove your row from "Currently In Progress"
   - Add a row to "Completed" table
   - Add a Handoff Note at the top of the Handoff Notes section

10. **Push WORK.md update to main**
    ```bash
    git checkout main
    git pull origin main
    git add WORK.md FEATURES.md
    git commit -m "chore: complete [feature-id] — [short description]"
    git push origin main
    ```

## Handoff note format

Post this in the `WORK.md` Handoff Notes section:

```markdown
### [Date] — [Developer]
**Done:** [Feature ID] — [feature name]
**Files changed:** [list key files]
**Gotchas:** [anything the other dev needs to know — env vars, schema changes, API quirks]
**Next up:** [Feature ID] — [description] — ready to start
```

If you changed the database schema, **call the other developer before pushing**.
If you changed `src/types/index.ts`, **call the other developer before pushing**.
