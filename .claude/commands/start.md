# /project:start

Run this at the beginning of every Claude Code session.

## Steps

1. Read `CLAUDE.md` in full. Confirm you understand the project, stack, and architecture.
2. Read `FEATURES.md`. Identify what is Done, In Progress, and Not Started.
3. Run `git status` to see if there are any uncommitted changes.
4. Run `git pull origin main` to make sure you're on the latest code.
5. Ask the developer: "Which feature do you want to work on today? Here's what's next based on FEATURES.md:"
   - List the top 3 not-started features in the current phase
   - Include the feature ID (e.g. F-01) and brief description
6. Ask: "Are you Josh (backend) or Seb (frontend)? I'll stay in your ownership area."
7. Once confirmed, create a new branch: `git checkout -b feature/[feature-name]`
8. Begin work. Ask any clarifying questions before writing code.

## Rules for this session
- Never modify files outside of the developer's ownership area (see CLAUDE.md)
- Never use `git add .` — always `git add -p`
- Never push directly to `main`
- Update FEATURES.md status when a feature is complete
- Run `npm run lint` before any commit
