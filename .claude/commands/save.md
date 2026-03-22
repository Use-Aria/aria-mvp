# /project:save

Run this mid-session before clearing context, or any time you want to checkpoint progress.

## Steps

1. **Review the current session** — scan all files touched, decisions made, and problems encountered since the last save.

2. **Update `PROGRESS.md`** — rewrite the top sections concisely:
   - **What We Accomplished This Session** — bullet list of completed work, keep each item to one line
   - **Current State** — phase/task status table, mark anything partial or blocked
   - **Next Steps** — ordered list of exactly what to do next, specific enough that a fresh context can pick up immediately with no questions
   - **Architecture Gotchas** — append any new gotchas discovered this session to the permanent table. Do not rewrite existing entries.

3. **Update `WORK.md`** if task ownership changed — update "Currently In Progress" to reflect actual state.

4. **Stay on your feature branch** — do not commit context saves to `dev` or `main`.

## Rules
- Be as concise as possible. Every line should earn its place.
- Next Steps must be specific: file names, function names, exact commands — not vague descriptions.
- Do not summarize what Claude did. Summarize what the project state is.
- Do not touch `FEATURES.md` or `CLAUDE.md` — those are for `/project:done` and permanent decisions only.
