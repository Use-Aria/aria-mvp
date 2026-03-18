# Aria — Feature Checklist

> Updated after every `git push`. This is the live build status.
> Legend: ✅ Done | 🔄 In Progress | ⬜ Not Started | ⏳ Deferred

---

## Phase 0 — Foundation

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-00 | Repo created, CLAUDE.md, FEATURES.md, slash commands | Josh + Seb | ✅ Done | |
| F-01 | Next.js 14 scaffold (App Router, TypeScript, Tailwind) | Josh | ⬜ | |
| F-02 | Supabase project setup + schema migrations | Josh | ⬜ | |
| F-03 | Shared types defined (Task, CalendarEvent, Message) | Josh | ⬜ | `src/types/index.ts` |
| F-04 | `.env.local` template + environment variable setup | Josh | ⬜ | |
| F-05 | ESLint + Prettier config | Josh | ⬜ | |
| F-06 | Google Cloud project created, Gmail + Calendar APIs enabled | Josh | ⬜ | |
| F-07 | Vercel project connected to repo | Josh | ⬜ | |

---

## Phase 1 — Auth & Integrations Core

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-10 | Supabase Auth setup | Josh | ⬜ | |
| F-11 | Google OAuth 2.0 flow (Calendar + Gmail scopes) | Josh | ⬜ | |
| F-12 | Token storage + refresh rotation in Supabase | Josh | ⬜ | |
| F-13 | User onboarding web form (phone, Canvas iCal URL) | Josh | ⬜ | |
| F-14 | SMS phone number verification via Twilio | Josh | ⬜ | |
| F-15 | User preferences schema + defaults | Josh | ⬜ | |
| F-16 | Canvas iCal URL validation on onboarding | Josh | ⬜ | |

---

## Phase 2 — Canvas Integration

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-20 | Fetch + parse Canvas iCal feed | Josh | ⬜ | `src/lib/integrations/canvas.ts` |
| F-21 | Normalize Canvas events to Task type | Josh | ⬜ | |
| F-22 | Store deadlines in Supabase with synced_at | Josh | ⬜ | |
| F-23 | Background sync job (every 60 min via Celery) | Josh | ⬜ | |
| F-24 | Diff engine — detect added/changed/removed deadlines | Josh | ⬜ | |
| F-25 | Trigger deadline change alert on diff | Josh | ⬜ | |
| F-26 | Canvas API rate limit handling + exponential backoff | Josh | ⬜ | |

---

## Phase 3 — Gmail Integration (Phase 2 Product)

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-30 | Gmail OAuth connection | Josh | ⬜ | Shares Google OAuth client with Calendar |
| F-31 | Fetch emails from course-related senders | Josh | ⬜ | |
| F-32 | Keyword detection (deadline moved, exam cancelled, etc.) | Josh | ⬜ | |
| F-33 | Normalize to Message type | Josh | ⬜ | |
| F-34 | Cross-reference Gmail changes with Canvas state | Josh | ⬜ | |
| F-35 | Alert student if email contradicts Canvas deadline | Josh | ⬜ | |

---

## Phase 4 — Google Calendar Integration

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-40 | Google Calendar OAuth (shares Google app with Gmail) | Josh | ⬜ | |
| F-41 | Fetch all calendar events (7-day window) | Josh | ⬜ | |
| F-42 | Normalize to CalendarEvent type | Josh | ⬜ | |
| F-43 | Write study blocks to calendar on student request | Josh | ⬜ | |
| F-44 | Real-time push notifications for calendar changes | Josh | ⬜ | |

---

## Phase 5 — SMS Interface (Twilio)

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-50 | Twilio account + phone number setup | Josh | ⬜ | |
| F-51 | Outbound SMS sending function | Josh | ⬜ | `src/lib/sms/twilio.ts` |
| F-52 | Inbound SMS webhook handler | Josh | ⬜ | `src/app/api/sms/webhook/route.ts` |
| F-53 | Route inbound SMS to Claude for conversational reply | Josh | ⬜ | |
| F-54 | Anti-spam rules (max 3 unsolicited/day, quiet hours) | Josh | ⬜ | |
| F-55 | STOP / PAUSE command handling (TCPA compliance) | Josh | ⬜ | |

---

## Phase 6 — AI Layer

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-60 | Syllabus PDF upload endpoint | Josh | ⬜ | `src/app/api/upload/syllabus/route.ts` |
| F-61 | Claude Opus syllabus parser — extract exams, assignments, topics | Josh | ⬜ | `src/lib/ai/syllabus.ts` |
| F-62 | Store parsed syllabus JSON in Supabase | Josh | ⬜ | |
| F-63 | Weekly briefing generator (Claude Sonnet) | Josh | ⬜ | `src/lib/ai/briefing.ts` |
| F-64 | Briefing scheduled job (Monday 6am generation, 8am send) | Josh | ⬜ | |
| F-65 | Conversational reply handler (Claude Sonnet) | Josh | ⬜ | `src/lib/ai/replies.ts` |

---

## Phase 7 — Sync Engine

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-70 | Celery + Redis setup for background jobs | Josh | ⬜ | |
| F-71 | Canvas iCal sync job (every 60 min) | Josh | ⬜ | |
| F-72 | Google Calendar sync job (real-time via push) | Josh | ⬜ | |
| F-73 | Todoist sync job (every 2 hours) | Josh | ⬜ | Phase 2 |
| F-74 | Briefing generation job (weekly) | Josh | ⬜ | |
| F-75 | Exam countdown check job (daily 7am) | Josh | ⬜ | |

---

## Phase 8 — Frontend UI (Seb)

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-80 | Onboarding flow UI (phone, Canvas URL, Google OAuth) | Seb | ⏳ | After backend |
| F-81 | Syllabus upload UI | Seb | ⏳ | |
| F-82 | Preferences setup UI | Seb | ⏳ | |
| F-83 | Connection status page (show linked integrations) | Seb | ⏳ | |
| F-84 | First briefing preview UI | Seb | ⏳ | |

---

## Phase 9 — v2 Features (Post-MVP)

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-90 | Todoist OAuth + task read/write | Josh | ⏳ | v2 |
| F-91 | Spotify OAuth + focus session automation | Josh | ⏳ | v2 |
| F-92 | Study gap detection (syllabus vs. coverage) | Josh | ⏳ | v2 |
| F-93 | Exam countdown + preparation scheduling | Josh | ⏳ | v2 |
| F-94 | Conflict detection (Canvas vs. GCal) | Josh | ⏳ | v2 |
| F-95 | Sendblue iMessage integration | Josh | ⏳ | v2 |
| F-96 | Slack integration | Josh | ⏳ | v2 |

---

## Phase 10 — Scale (Phase 3)

| ID | Feature | Owner | Status | Notes |
|---|---|---|---|---|
| F-100 | Web dashboard (visual calendar + settings) | Seb | ⏳ | Phase 3 |
| F-101 | iOS app shell | Josh | ⏳ | Phase 3 |
| F-102 | Multi-university support | Josh | ⏳ | Phase 3 |
| F-103 | Referral system | Josh + Seb | ⏳ | Phase 3 |

---

## Push Log

*Most recent push at the top. Updated by Claude after every `git push`.*

---

### ✅ Push #1 — March 18, 2026

**Branch:** `main`
**Features:** F-00
**What was done:**
- Repo connected to GitHub (`aria-mvp`)
- `CLAUDE.md` written — full project constitution with stack, architecture, ownership, git workflow, data model, file structure, and Claude prompting guidelines
- `FEATURES.md` written — 40+ feature checklist across 10 phases
- `.claude/commands/start.md` — `/project:start` slash command
- `.claude/commands/done.md` — `/project:done` slash command
- `.claude/settings.json` — safety guardrails

**Next up:** F-01 (Next.js scaffold) → F-02 (Supabase) → F-03 (shared types)
