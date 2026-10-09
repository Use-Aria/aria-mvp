# Retrospective: Aria

---

## Milestone: v1.0 — MVP

**Shipped:** 2026-03-21
**Phases:** 9 | **Plans:** 26 | **Timeline:** 3 days

### What Was Built

1. Infrastructure: Next.js + FastAPI/Celery + Supabase + Redis, full Docker Compose dev environment
2. Canvas iCal sync with diff engine, Celery Beat scheduling, soft-delete
3. TCPA-compliant Twilio SMS: STOP/PAUSE/HELP dispatch, quiet hours, rate caps, Redis batching
4. Claude Sonnet daily briefings: load score, exam countdown, conversational replies, task management via SMS
5. Priority Engine: canonical event store, priority formula, delivery router (immediate/digest/silent)
6. Google OAuth + GCal push + Gmail Pub/Sub: conflict detection, study block writeback, Monday briefing enrichment
7. Claude Opus syllabus parsing: grade weights, topics, T-5 study gap analysis
8. Expo SDK 55 iOS app: full onboarding flow, 4-zone card dashboard, in-app chat, two-tap voice, Preferences
9. Todoist OAuth + sync + SMS CRUD + overload detection in briefings

### What Worked

- **Backend-first order paid off**: iOS app had stable APIs to integrate against from day one of Phase 8
- **TDD pattern throughout**: every backend module (Canvas, SMS, AI, Priority, GCal, Gmail, Todoist) built test-first — caught integration issues early
- **Celery Beat for scheduling**: Celery + Redis + Beat proved reliable for all background jobs (sync, briefings, gap analysis)
- **Two-developer split (Josh backend / Seb iOS)**: clear ownership boundaries prevented conflicts; WORK.md coordination worked
- **Fernet encryption boundary**: encrypting OAuth tokens only at Supabase write (not in Redis queue) simplified the architecture without weakening security

### What Was Inefficient

- **Phase 5 (Priority Engine) completion not reflected in ROADMAP.md** — documentation drift between Josh's branch and Seb's branch caused the checkbox discrepancy seen at milestone close
- **MILESTONES.md accomplishments not captured by gsd-tools CLI** — had to fill them in manually post-archive; SUMMARY.md one_liner fields were unpopulated
- **3-day sprint is extremely fast** — some integration testing across the full stack (iOS ↔ backend ↔ SMS) was not formally verified before milestone close

### Patterns Established

- All backend integrations follow: `integrations/[service].ts` → `sync/[service]-sync.ts` → `api/sync/[service]/route.ts`
- All Celery tasks use `autoretry_for` + exponential backoff
- All outbound SMS gated through `send_sms_safe()` — single compliance checkpoint
- Canonical Store is the write target for all Phase 6+ integrations (never directly to integration tables)
- iOS OAuth via `WebBrowser.openAuthSessionAsync` with `aria://` deep link return URL

### Key Lessons

- WORK.md cross-developer coordination is essential — without it, parallel branches create merge friction
- `rapidfuzz` threshold=70 for Gmail-Canvas cross-reference is the right sensitivity; below 60 creates too many false positives
- GCal push channels and Gmail watch channels require proactive renewal (< 7 days); bake renewal into Beat from the start
- Expo's `expo-speech-recognition` two-tap model needs careful state machine design to avoid accidental sends

### Cost Observations

- Model mix: Opus for syllabus parsing + gap analysis, Sonnet for briefings + replies, Haiku for classification
- Two developers (Josh + Seb) with parallel Claude Code sessions across 3 days
- No major rework cycles — TDD and clear phase goals kept execution tight

---

## Cross-Milestone Trends

| Metric | v1.0 |
|--------|------|
| Phases | 9 |
| Plans | 26 |
| Days | 3 |
| LOC | ~16,600 |
| Requirements | 68/68 |
| Rework cycles | 0 major |
