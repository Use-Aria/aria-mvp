# Aria — Active Work State

> **This file is the traffic light for the repo.**
> Read it before touching any code. Update it when you start and when you finish.
> Both developers (Josh + Seb) run separate Claude Code sessions — this file prevents collisions.

---

## 🔒 Currently In Progress

*Nothing claimed yet. Run `/project:start` to claim a task.*

| Developer | Task (Feature ID) | Branch | Claimed At |
|-----------|-------------------|--------|------------|
| — | — | — | — |

---

## 🎯 Up Next (Priority Order)

Work through these in order. Claim one at a time. Do not start a task already claimed above.

### Phase 0 — Foundation (start here)
- [ ] **F-01** — Next.js 14 scaffold (App Router, TypeScript, Tailwind) → **Josh**
- [ ] **F-02** — Supabase project setup + schema migrations → **Josh**
- [ ] **F-03** — Shared types defined (Task, CalendarEvent, Message) in `src/types/index.ts` → **Josh**
- [ ] **F-04** — `.env.local` template + environment variable setup → **Josh**
- [ ] **F-05** — ESLint + Prettier config → **Josh**
- [ ] **F-06** — Google Cloud project created, Gmail + Calendar APIs enabled → **Josh**
- [ ] **F-07** — Vercel project connected to repo → **Josh**

### Phase 1 — Auth & Integrations Core
- [ ] **F-10** — Supabase Auth setup → **Josh**
- [ ] **F-11** — Google OAuth 2.0 flow (Calendar + Gmail scopes) → **Josh**
- [ ] **F-12** — Token storage + refresh rotation in Supabase → **Josh**
- [ ] **F-13** — User onboarding web form (phone, Canvas iCal URL) → **Josh**
- [ ] **F-14** — SMS phone number verification via Twilio → **Josh**
- [ ] **F-15** — User preferences schema + defaults → **Josh**
- [ ] **F-16** — Canvas iCal URL validation on onboarding → **Josh**

### Phase 2 — Canvas Integration
- [ ] **F-20** — Fetch + parse Canvas iCal feed → **Josh**
- [ ] **F-21** — Normalize Canvas events to Task type → **Josh**
- [ ] **F-22** — Store deadlines in Supabase with synced_at → **Josh**
- [ ] **F-23** — Background sync job (every 60 min via Celery) → **Josh**
- [ ] **F-24** — Diff engine — detect added/changed/removed deadlines → **Josh**
- [ ] **F-25** — Trigger deadline change alert on diff → **Josh**
- [ ] **F-26** — Canvas API rate limit handling + exponential backoff → **Josh**

### Phase 3 — Gmail Integration (MVP)
- [ ] **F-30** — Gmail OAuth connection → **Josh**
- [ ] **F-31** — Fetch emails from course-related senders → **Josh**
- [ ] **F-32** — Keyword detection (deadline moved, exam cancelled, etc.) → **Josh**
- [ ] **F-33** — Normalize to Message type → **Josh**
- [ ] **F-34** — Cross-reference Gmail changes with Canvas state → **Josh**
- [ ] **F-35** — Alert student if email contradicts Canvas deadline → **Josh**

### Phase 4 — Google Calendar Integration
- [ ] **F-40** — Google Calendar OAuth → **Josh**
- [ ] **F-41** — Fetch all calendar events (7-day window) → **Josh**
- [ ] **F-42** — Normalize to CalendarEvent type → **Josh**
- [ ] **F-43** — Write study blocks to calendar on student request → **Josh**
- [ ] **F-44** — Real-time push notifications for calendar changes → **Josh**

### Phase 5 — SMS Interface (Twilio)
- [ ] **F-50** — Twilio account + phone number setup → **Josh**
- [ ] **F-51** — Outbound SMS sending function → **Josh**
- [ ] **F-52** — Inbound SMS webhook handler → **Josh**
- [ ] **F-53** — Route inbound SMS to Claude for conversational reply → **Josh**
- [ ] **F-54** — Anti-spam rules (max 3 unsolicited/day, quiet hours) → **Josh**
- [ ] **F-55** — STOP / PAUSE command handling (TCPA compliance) → **Josh**

### Phase 6 — AI Layer
- [ ] **F-60** — Syllabus PDF upload endpoint → **Josh**
- [ ] **F-61** — Claude Opus syllabus parser → **Josh**
- [ ] **F-62** — Store parsed syllabus JSON in Supabase → **Josh**
- [ ] **F-63** — Daily briefing generator (Claude Sonnet) → **Josh**
- [ ] **F-64** — Briefing scheduled job (daily 7am generation, 8am send) → **Josh**
- [ ] **F-65** — Conversational reply handler (Claude Sonnet) → **Josh**

### Phase 7 — Sync Engine
- [ ] **F-70** — Celery + Redis setup for background jobs → **Josh**
- [ ] **F-71** — Canvas iCal sync job (every 60 min) → **Josh**
- [ ] **F-72** — Google Calendar sync job (real-time via push) → **Josh**
- [ ] **F-74** — Briefing generation job (daily) → **Josh**
- [ ] **F-75** — Exam countdown check job (daily 7am) → **Josh**

### Phase 8 — Frontend UI (Seb owns this entire phase)
- [ ] **F-80** — Onboarding flow UI → **Seb** *(start after F-13 is done)*
- [ ] **F-81** — Syllabus upload UI → **Seb** *(start after F-60 is done)*
- [ ] **F-82** — Preferences setup UI → **Seb** *(start after F-15 is done)*
- [ ] **F-83** — Connection status page → **Seb** *(start after F-11 is done)*
- [ ] **F-84** — First briefing preview UI → **Seb** *(start after F-63 is done)*

---

## ✅ Completed

| Feature ID | Description | Completed By | Date | Branch / PR |
|------------|-------------|--------------|------|-------------|
| F-00 | Repo setup, CLAUDE.md, FEATURES.md, slash commands | Josh | 2026-03-18 | main |

---

## 📋 Handoff Notes

*Posted here when a developer finishes a task. Read the latest before starting.*

### 2026-03-18 — Josh
**Done:** F-00 — Project foundation
**Files changed:** `CLAUDE.md`, `FEATURES.md`, `WORK.md`, `.claude/commands/`, `.claude/settings.json`
**Gotchas:** None yet — no app code exists. Next person starts with F-01 (Next.js scaffold).
**Next up:** F-01 → F-02 → F-03 in that order. Do not skip schema setup.

---

## ⚠️ Collision Rules

1. **Never start a task that's already claimed** in the "Currently In Progress" table above
2. **Always `git pull origin main` before claiming** — another dev may have finished and pushed
3. **One task at a time per developer** — finish and push before claiming a second
4. **Seb: do not touch `src/lib/`, `src/app/api/`, or `supabase/`** — Josh owns these
5. **Josh: do not touch `src/app/(pages)/` or `src/components/`** — Seb owns these
6. **Both: never modify `src/types/index.ts` without telling the other person first**
