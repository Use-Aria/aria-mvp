# Context Clearing Code

> Copy-paste these prompts when Claude's context is getting full or you're starting a new session mid-task.

---

## 1. Session Start (use at every new session)

```
Read CLAUDE.md, WORK.md, and FEATURES.md. Tell me:
1. What's currently in progress (WORK.md)
2. What the next unclaimed task is
3. Any handoff notes I need to read
Don't write any code yet. Just summarize what you found.
```

---

## 2. Resume Mid-Task (context got cut, same task)

```
Read CLAUDE.md and WORK.md. I'm currently working on [FEATURE-ID] ([short description]).
The branch is [branch-name]. Read the relevant files for this task and tell me
where we left off before writing any code.
```

---

## 3. Handoff Checkpoint (before context fills)

```
Summarize everything we've done this session in 5 bullet points or less.
List every file we created or modified with the key change.
List any decisions we made that aren't captured in the code.
I'll paste this into the next session to restore context.
```

---

## 4. Restore from Handoff Summary (paste the bullets from #3)

```
Here's the context from my last session:

[PASTE BULLETS HERE]

Read CLAUDE.md and the files listed above to verify current state,
then continue from where we left off.
```

---

## 5. Quick Status Check (what's done, what's not)

```
Read WORK.md and FEATURES.md. List:
- Completed features
- In-progress tasks
- Next 3 unclaimed tasks in priority order
One sentence each. No code.
```

---

## 6. Context Compression (when mid-task context is bloated)

```
Forget all prior code outputs in this conversation.
I only need you to know:
- Feature: [FEATURE-ID]
- Files involved: [list files]
- Current problem: [one sentence]
Read those files fresh and help me continue.
```

---

## 7. Claim a Task (start of session, picking up new work)

```
Read WORK.md. I'm [Josh/Seb]. Claim [FEATURE-ID] for me by:
1. Adding my row to "Currently In Progress"
2. Creating branch name following naming conventions in CLAUDE.md
Tell me the branch name before doing anything else.
```

---

## 8. Close a Task (end of session)

```
Feature [FEATURE-ID] is done. Update WORK.md:
1. Remove my row from "Currently In Progress"
2. Add a row to "Completed" with today's date
3. Write a Handoff Note summarizing what was done, files changed, and gotchas
Also update FEATURES.md to mark [FEATURE-ID] as complete.
```
