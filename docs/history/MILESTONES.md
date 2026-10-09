# Milestones

## v1.0 MVP (Shipped: 2026-03-21)

**Phases:** 1–9 | **Plans:** 26 | **Timeline:** 3 days (2026-03-18 → 2026-03-21)
**LOC:** ~16,600 (TS/TSX/Python) | **Files:** 334 | **Requirements:** 68/68

**Delivered:** Full-stack AI personal assistant — SMS briefings + iOS app — connecting Canvas, Google Calendar, Gmail, Todoist, and syllabi through a priority-scored intelligence pipeline.

**Key accomplishments:**

1. Next.js 15 + FastAPI/Celery + Supabase + Redis full-stack infrastructure with RLS, Auth, and Docker Compose
2. Canvas iCal sync pipeline with diff engine, soft-delete, and 60-min Celery Beat job
3. Full Twilio SMS layer with TCPA compliance — STOP/PAUSE/HELP, quiet hours, 3/day cap, Redis batching
4. Claude Sonnet daily briefings with load score, exam countdown, conversation history, and task management via SMS
5. Priority Engine: canonical event store with `(grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)` scoring formula
6. Google OAuth + GCal push notifications + Gmail Pub/Sub with fuzzy deadline detection, conflict detection, and study block writeback
7. Claude Opus syllabus PDF parsing with grade weights + T-5 study gap analysis enriching briefings
8. Full Expo SDK 55 iOS app: onboarding flow, 4-zone card dashboard, in-app chat, two-tap voice input, Preferences
9. Todoist OAuth + task sync + SMS CRUD + overload detection in morning briefings

**Tech stack shipped:** Next.js 15.2, FastAPI, Celery + Redis, Supabase (PostgreSQL + pgvector), Twilio, Claude API (Opus/Sonnet/Haiku), Expo SDK 55, React Native 0.83, NativeWind v4

---
