# Project Research Summary

**Project:** Aria — Proactive AI SMS Assistant for College Students
**Domain:** SMS-first AI personal assistant — multi-source academic data pipeline, background jobs, conversational AI
**Researched:** 2026-03-18
**Confidence:** HIGH

## Executive Summary

Aria is a two-sided system: a data pipeline that continuously ingests academic context (Canvas deadlines, Google Calendar events, syllabus content, professor emails) and an AI delivery layer that turns that context into proactive, conversational SMS. The canonical approach for this architecture is a Next.js frontend/webhook layer on Vercel, backed by a Python FastAPI + Celery worker fleet on Railway that handles all heavy AI jobs asynchronously. This split is non-negotiable: Claude API calls (15–45 seconds for Opus) will timeout Vercel's 30-second function limit if run synchronously, and the Celery worker layer must be Python to colocate with the Anthropic Python SDK and the async job patterns the domain requires.

The recommended build order follows strict dependency constraints. The entire product is worthless without Canvas iCal sync — that data pipeline is the foundation everything else enriches. Twilio SMS is the delivery channel and must be built with TCPA opt-out compliance and Twilio signature validation from the first line of webhook code, not retrofitted. Google OAuth (Calendar + Gmail) shares one OAuth client and should be built together. Syllabus parsing (Claude Opus) is the single highest-complexity feature and the key differentiator, but briefings function without it — it belongs in a second wave after the core pipeline is validated with real users.

The top risks are all silent failures: Google OAuth refresh tokens revoked without error, GCal/Gmail watch channels expiring after 7 days with no notification, Canvas iCal timezone handling producing wrong deadline times, and Twilio webhook timeouts triggering duplicate processing. Every one of these will occur in production if not built with explicit prevention logic from the start. The research finds no ambiguity about mitigations — all are well-documented patterns with clear implementation paths.

---

## Key Findings

### Recommended Stack

The stack in CLAUDE.md is directionally correct but needs two targeted corrections before writing code. First, upgrade from Next.js 14 (specified in CLAUDE.md) to **Next.js 15.2** — the current stable release. Starting on 14 now means migrating an async Request API breaking change later; the upgrade codemod exists but the pain is avoidable. Second, replace **Chroma** with **Supabase pgvector** for syllabus embeddings. Chroma requires a separate Railway service; pgvector is a Supabase extension that eliminates that infrastructure dependency entirely at 50-user MVP scale.

The Python/FastAPI/Celery layer is the correct choice and should not be reconsidered. The AI jobs (syllabus parsing, briefing generation, deadline classification) are Python-native workloads, and Celery is the proven Redis-backed job queue for this language and scale. Switching to BullMQ or Inngest would require rewriting all AI jobs in TypeScript — wrong for this domain.

**Core technologies:**
- **Next.js 15.2** (App Router): Frontend + webhook handlers + API routes. Upgrade from 14 before writing any code. `params`/`cookies`/`headers` are now async — must `await` in route handlers.
- **FastAPI 0.115.x + Celery 5.4.x**: Python AI job layer on Railway. All Claude calls, iCal fetches, and scheduled jobs run here — never in the Next.js layer.
- **Redis 7.x**: Celery broker + result backend. Also rate-limit tracking for Canvas 120 req/min limit.
- **Supabase (PostgreSQL + Auth + Storage)**: All persistent state. Row-level security for user data isolation. pgvector for syllabus embeddings (replace Chroma).
- **Anthropic Python SDK 0.86.0** / **TypeScript SDK 0.80.0**: Current stable as of 2026-03-18. Python SDK for Celery workers; TypeScript SDK only if conversational SMS replies are handled in the Next.js layer directly (see architecture note below).
- **Twilio 5.x** (Node): Outbound briefings + inbound webhook validation.
- **googleapis 144.x** (Node): Google Calendar + Gmail OAuth + API calls from Next.js auth layer.
- **node-ical 0.18.x**: Canvas iCal parsing in TypeScript integrations layer.
- **@supabase/ssr** (not deprecated `auth-helpers-nextjs`): Required for correct cookie-based auth in App Router.

**One flag on CLAUDE.md model IDs:** Verify `claude-haiku-4-5-20251001` is a valid model string before first API call. Use `anthropic.models.list()` to confirm.

### Expected Features

The feature research identifies a clear, uncontested competitive position: no current tool combines LMS-awareness + SMS delivery + proactive AI briefings. Reclaim/Motion are calendar-only; Notion AI requires app interaction; neither touches Canvas. The gap is real as of early 2026.

**Must have for launch (P1):**
- Canvas iCal sync with accurate diff engine — without correct deadlines, all trust is destroyed
- Daily morning briefing (8am, Claude Sonnet) — this is the primary value delivery mechanism
- Deadline change alerts (Canvas diff fires SMS within 15 min) — the "rescue moment" that converts skeptics
- Conversational reply to "what's due this week?" — students text back immediately after the first briefing
- User onboarding (phone verification, Canvas iCal URL, Google OAuth) — required before any feature works
- STOP/PAUSE/HELP TCPA compliance — required by US law before the first outbound SMS
- Quiet hours (10pm–8am) + 3 msg/day cap — students churn on day 1 without this
- Gmail integration (detect professor deadline changes) — included in MVP because it upgrades alert quality meaningfully and shares the Google OAuth plumbing already being built

**Should have — add after first 10 users are active (P2):**
- Syllabus PDF parsing (Claude Opus) — grade weights + topic context; massive quality upgrade for briefings
- Grade-weighted deadline prioritization — activated by syllabus parsing
- Google Calendar read integration — lets briefings reference class schedule
- Syllabus-aware briefing generation — low additional work once parsed JSON is in Supabase
- Calendar write-back via SMS ("block 2 hours for MATH tomorrow")

**Defer to v2+:**
- Todoist integration
- Sendblue iMessage
- Exam countdown scheduling + study gap detection (requires solid syllabus parsing + session tracking)
- Spotify focus sessions

**Key anti-features to avoid:** Canvas API grade access (FERPA), real-time Canvas webhooks (not available without institutional approval), automatic calendar spam for all deadlines, notification channel proliferation (SMS-first always).

**SMS UX constraints that affect implementation:**
- Briefing must be scannable in 10 seconds; 3–5 items maximum; end with a reply prompt
- Canvas URLs must be shortened (80+ chars is unacceptable in SMS)
- Conversational replies must arrive in under 10 seconds — this constrains whether Claude is called synchronously vs. via Celery
- Alert fatigue threshold: >3 unsolicited messages/day triggers opt-outs; grade-weight filtering is the key signal reducer

### Architecture Approach

The architecture is a three-tier async pipeline: Next.js on Vercel handles synchronous I/O (webhook receipt, OAuth callbacks, file uploads) and immediately hands work to a Redis task queue. Celery workers on Railway execute all async work (Claude inference, iCal fetching, SMS sending, GCal sync). Supabase is the single source of truth that both tiers read and write. The UI (Seb's frontend) reads exclusively from Supabase — it never touches external APIs.

**Major components:**
1. **Next.js API routes (Vercel)** — receive webhooks, validate signatures, enqueue Celery tasks, return 202 immediately. No Claude calls here.
2. **Celery Beat (scheduler)** — cron jobs: Canvas sync every 60 min (with per-user jitter), daily briefing at 8am per user timezone.
3. **Celery Workers (Railway FastAPI)** — execute canvas_sync, briefing_generate, sms_reply, syllabus_parse tasks.
4. **Supabase (PostgreSQL)** — users, deadlines, calendar_events, syllabi, integrations, messages tables with RLS.
5. **Integration adapters (`lib/integrations/`)** — one file per external service, returns normalized `Task[]`/`CalendarEvent[]`/`Message[]`. No business logic.
6. **Diff engine (`lib/sync/`)** — compares fresh iCal data against Supabase state; detects changes; enqueues alerts.
7. **AI modules (`lib/ai/`)** — context window assembly + Claude calls. Briefing, syllabus, replies each have dedicated files with bounded context budgets.

**Build order (strict dependency constraints):**
- Layer 0: Supabase schema, Redis, Celery skeleton, Twilio number
- Layer 1: Canvas iCal sync (testable in isolation with any iCal URL)
- Layer 2: Twilio SMS send/receive (testable: send a text, get echo back)
- Layer 3: Claude AI integration (end-to-end: Canvas data → Claude → SMS briefing)
- Layer 4: Google OAuth + Calendar + Gmail (requires public HTTPS URL)
- Layer 5: Syllabus parsing (depends on Claude working from Layer 3)
- Layer 6: Deadline alerts with Haiku classification

### Critical Pitfalls

1. **Google OAuth refresh tokens silently revoked** — always pass `access_type=offline&prompt=consent`, store `refresh_token` + `expires_at` together, handle `invalid_grant` as a distinct error that marks the integration disconnected and sends the user an SMS. Publish the app to Production mode before beta (Testing mode tokens expire in 7 days).

2. **GCal and Gmail watch channels expire after 7 days with no notification** — store `channel_expiry` and `gmail_watch_expiry` in the `integrations` table at creation time; run a Celery periodic task daily to renew channels expiring within 48 hours. This is not optional infrastructure — build the renewal cron alongside the initial watch setup.

3. **Twilio webhook timeout causes duplicate message processing** — the webhook handler must return HTTP 200 immediately after enqueuing the Celery task. Never call Claude synchronously from a Twilio webhook. Store `MessageSid` as an idempotency key to prevent Celery retry duplicates.

4. **TCPA opt-out violation** — register STOP/START/HELP webhooks in Twilio from day one. On STOP, set `sms_opted_out: true` in the users table. Every outbound SMS function must check this flag before calling `twilio.messages.create()`. The initial onboarding SMS must include opt-out instructions.

5. **Claude context window overflow** — enforce 14-day deadline window and 7-day calendar window as hard limits before constructing any prompt. Add token estimation (1 token ≈ 4 chars) and truncate at 80% of the model's context limit. Define a JSON schema for Claude's output and validate responses.

6. **Canvas iCal floating-time timezone errors** — when `DTSTART` has no timezone suffix, treat it as the user's stored local timezone, not UTC. A deadline appearing 5 hours off is a trust-destroying bug. Use content hash `(SUMMARY + DTSTART + course)` rather than `UID` alone for diff identity — Canvas `UID` is not stable across Canvas upgrades.

7. **Cold-start UX (18-hour wait for first value)** — trigger a welcome briefing SMS within 60 seconds of completing onboarding. Do not wait for the next scheduled job.

---

## Implications for Roadmap

Based on the combined research, the architecture's Layer 0–6 build order maps directly to a 6-phase roadmap. Each phase is independently testable and delivers a usable slice of the product.

### Phase 1: Infrastructure Foundation
**Rationale:** Everything depends on this. No user data can be stored, no jobs can run, no SMS can be sent without Supabase schema, Redis, Celery skeleton, and a provisioned Twilio number. This phase has zero user-facing output but enables all subsequent testing.
**Delivers:** Supabase schema with all core tables + RLS enabled, Railway Redis instance, FastAPI + Celery worker skeleton (no tasks yet), Twilio number provisioned, Vercel project connected, environment variables documented.
**Avoids:** Building integrations before the data layer exists; RLS not being enabled from the start (security debt impossible to retrofit safely).

### Phase 2: Canvas iCal Sync
**Rationale:** Canvas data is the product's oxygen. Nothing can be briefed, alerted on, or contextualized without it. This phase is also uniquely testable in isolation — any Canvas iCal URL works, no user auth required.
**Delivers:** `canvas.ts` integration adapter, `canvas-sync.ts` diff engine with content-hash identity, `canvas_worker.py` Celery task with exponential backoff, 60-minute Celery Beat schedule with per-user jitter, deadlines stored and updated in Supabase.
**Addresses:** Canvas iCal sync (P1 table stakes)
**Avoids:** UID instability in diff, floating-time timezone errors, Canvas API scope creep (FERPA), retry storm on upstream failure.
**Research flag:** Standard, well-documented patterns. Skip research-phase.

### Phase 3: Twilio SMS + TCPA Compliance
**Rationale:** SMS is the delivery channel. Briefings and alerts are useless without it. TCPA compliance must ship with the first outbound message capability — it cannot be added later without legal exposure.
**Delivers:** `twilio.ts` send/receive, `/api/sms/webhook` with Twilio signature validation + immediate 202 response + Celery enqueue, STOP/START/HELP opt-out handling with `sms_opted_out` DB flag, quiet hours enforcement, 3 msg/day cap, basic echo reply to verify the async pipeline end-to-end.
**Addresses:** TCPA compliance (legal P1), quiet hours + message cap (churn prevention P1)
**Avoids:** Synchronous Claude calls in webhook handler (Twilio timeout + duplicate processing), missing signature validation shipping to production, TCPA violations.
**Research flag:** Standard Twilio patterns. Skip research-phase.

### Phase 4: Claude AI Integration + Daily Briefing
**Rationale:** With Canvas data in the DB and Twilio SMS working, the first end-to-end value delivery becomes possible. This phase wires them together via Claude and produces the product's core reason to sign up.
**Delivers:** `briefing.ts` context assembly (14-day window, token budgeting), `briefing_worker.py` Celery task, Celery Beat schedule at 8am per user timezone, welcome briefing triggered at onboarding completion (within 60 seconds), conversational reply handler for "what's due this week?".
**Addresses:** Daily morning briefing (P1), "what's due" conversational reply (P1), cold-start UX fix.
**Avoids:** Context window overflow, hallucinated deadlines, cold-start 18-hour wait.
**Research flag:** Claude context assembly patterns are well-documented; briefing format constraints (SMS character limits, 3–5 items) need design validation with real users. Consider a lightweight research pass on briefing message design.

### Phase 5: Google OAuth + Calendar + Gmail
**Rationale:** Google OAuth is a shared prerequisite for both Calendar and Gmail. Build both scopes on the same OAuth client in one phase to avoid building the token management layer twice. Deadline alerts with Gmail signal are already designated as P1 MVP.
**Delivers:** Google OAuth flow (`/api/auth/google`) with `access_type=offline&prompt=consent`, refresh token storage + rotation logic in `integrations` table, `gcal.ts` Calendar integration (read-only), GCal push channel registration + 7-day renewal cron, `gmail.ts` Gmail integration with `history.list` incremental fetch, Gmail watch setup + 7-day renewal cron, deadline change detection from professor emails (Haiku classification), `deadline_alert_worker.py` with deduplication via `deadline_alerts` table.
**Addresses:** Gmail deadline signal (P1), Google Calendar context in briefings (P2 activation), deadline change alerts (P1).
**Avoids:** Refresh token silent revocation, GCal watch expiry, Gmail watch expiry, duplicate alerts from competing diff sources, quiet hours violation on alerts.
**Research flag:** Google OAuth token refresh and watch channel renewal are well-documented. The Gmail `history.list` incremental fetch pattern needs a targeted research pass — it is more complex than the GCal equivalent and the cursor (`historyId`) management is easy to get wrong.

### Phase 6: Syllabus Parsing + Grade-Weighted Briefings
**Rationale:** Syllabus parsing is the deepest differentiator (no competitor does this) but also the highest complexity. It depends on Claude working correctly (Phase 4) and benefits from having real users to validate the output format. Defer until the core pipeline is validated.
**Delivers:** `/api/upload/syllabus` route, `syllabus.ts` Claude Opus integration, `syllabus_worker.py` Celery task (PDF text extraction → Opus → structured JSON), `syllabi` table with `parsed_json` (store raw PDF in Supabase Storage, not a table column), grade weights written to `deadlines.grade_weight`, syllabus-aware briefing generation (Sonnet uses `parsed_json` as additional context), Supabase pgvector setup for semantic search (replacing Chroma).
**Addresses:** Syllabus PDF parsing (P2), grade-weighted prioritization (P2), syllabus-aware briefings (P2).
**Avoids:** Re-parsing PDFs on every briefing request, storing raw PDF text as a DB column (hundreds of MB), Chroma as separate Railway service (use pgvector instead).
**Research flag:** Claude Opus prompt design for structured syllabus extraction is non-trivial. Recommend a research-phase pass on syllabus parsing prompt patterns and output schema design before implementation. The pgvector Supabase integration is well-documented.

### Phase 7: User Onboarding + Frontend (Seb)
**Rationale:** Onboarding is the user-facing entry point but does not need to be built before the backend pipeline is working. Josh can seed test users directly in Supabase during Phases 2–6. Seb builds the onboarding UI once the backend APIs are stable.
**Delivers:** Onboarding flow (phone verification, Canvas iCal URL capture, Google OAuth click-through), under-5-minute completion target, welcome briefing trigger at completion, user preferences (timezone, quiet hours), frontend pages for Seb.
**Addresses:** User onboarding (P1 table stakes — required for beta users).
**Research flag:** Onboarding flow design benefits from conversion rate research. Standard Next.js App Router + Supabase Auth patterns are well-documented. Skip deep technical research-phase; focus on UX flow validation.

### Phase Ordering Rationale

- **Phases 1–3 are serial and non-negotiable in order.** You cannot sync Canvas without a database. You cannot brief without SMS. You cannot add TCPA compliance to existing SMS code cleanly.
- **Phase 4 before Phase 5** because Gmail/GCal context enriches briefings but is not required for them. Getting a working briefing pipeline first means Phase 5 can be validated against a working baseline.
- **Phase 6 is intentionally late** because syllabus parsing is the hardest feature and the one most likely to need iteration. Shipping it to users who already trust the product (via Phases 2–5) is lower risk than shipping it first.
- **Phase 7 (onboarding/frontend) can run in parallel with Phases 5–6.** Seb can build onboarding UI against the stable APIs established in Phases 3–4 while Josh completes the Google and syllabus layers.

### Research Flags

Phases needing a `/gsd:research-phase` pass during planning:
- **Phase 4 (briefing design):** SMS message format constraints and briefing copy patterns benefit from a research pass on notification design best practices.
- **Phase 5 (Gmail `history.list`):** The incremental email fetch cursor pattern with `historyId` is complex enough to warrant a targeted research pass before implementation.
- **Phase 6 (syllabus parsing prompt design):** Claude Opus prompt engineering for structured academic document extraction is the highest-uncertainty task in the roadmap. Strongly recommend a research pass.

Phases with standard, well-documented patterns (skip research-phase):
- **Phase 1:** Standard infrastructure setup.
- **Phase 2:** Canvas iCal + Celery patterns are well-documented.
- **Phase 3:** Twilio webhook + TCPA patterns are well-documented.
- **Phase 5 (GCal OAuth + watch channels):** Well-documented, clear implementation path.
- **Phase 7:** Standard Next.js + Supabase Auth onboarding.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Next.js 15.2, Anthropic SDKs verified from official release notes (2026-03-18). FastAPI/Celery versions from training data but patterns are stable. |
| Features | MEDIUM | Competitive landscape (Reclaim, Notion AI) from training data through August 2025 — validate against current product pages before drawing public conclusions. TCPA compliance patterns are HIGH confidence (regulatory law + Twilio docs). |
| Architecture | HIGH | All components well-established. Canvas iCal (RFC 5545), Google OAuth/watch expiry, Twilio signature validation, Celery retry patterns all backed by official documentation. |
| Pitfalls | HIGH for compliance/OAuth/Twilio | MEDIUM for Canvas iCal edge cases — UID instability and floating-time behavior confirmed as known issues but recommend validating with test feeds from multiple institutions before beta. |

**Overall confidence:** HIGH

### Gaps to Address

- **Canvas iCal UID stability:** Research flags UID instability across Canvas versions. The content-hash fallback `(SUMMARY + DTSTART + course)` is the prescribed mitigation, but validate with real feeds from Yale Canvas before relying on it exclusively.
- **Chroma → pgvector migration:** CLAUDE.md specifies Chroma. Decision to use pgvector instead should be confirmed with the team before Phase 6 begins. If pgvector similarity search is insufficient for use cases beyond MVP scale, revisit.
- **Claude model ID `claude-haiku-4-5-20251001`:** Verify this is a valid model string before first API call. Use `anthropic.models.list()` to confirm. Do not hardcode unverified model IDs.
- **Google OAuth app verification timeline:** Publishing from "Testing" to "Production" in Google Cloud Console may require Google's verification process if the app requests sensitive scopes (Gmail readonly is a sensitive scope). This review can take 1–6 weeks. Start the verification request before beta, not during it.
- **Vercel function timeout on Hobby vs Pro plan:** Research notes 30s (Pro) vs 10s (Hobby) — verify the current limit at Vercel's docs before deploying. The enqueue-don't-block pattern mitigates this but the timeout affects error handling paths.

---

## Sources

### Primary (HIGH confidence)
- Next.js 15.2 blog post — https://nextjs.org/blog/next-15-2 — stack decisions, async Request API breaking changes
- Next.js upgrade guide v14→v15 — https://nextjs.org/docs/app/building-your-application/upgrading/version-15 — migration path
- Anthropic Python SDK v0.86.0 releases — https://github.com/anthropics/anthropic-sdk-python/releases — current stable version
- Anthropic TypeScript SDK v0.80.0 releases — https://github.com/anthropics/anthropic-sdk-typescript/releases — current stable version
- Google Calendar API push notifications — https://developers.google.com/calendar/api/guides/push — 7-day channel expiry
- Google OAuth 2.0 docs — https://developers.google.com/identity/protocols/oauth2 — token refresh, invalid_grant conditions
- Twilio webhook security docs — https://www.twilio.com/docs/usage/security — X-Twilio-Signature validation
- Twilio webhook timeout + retry behavior — Twilio documentation — 15-second timeout, retry intervals
- TCPA compliance — established US telecommunications law + Twilio compliance documentation
- Celery + Redis architecture — https://docs.celeryq.dev/en/stable/ — task queue patterns, backoff configuration
- FERPA educational records definition — established law + Canvas documentation

### Secondary (MEDIUM confidence)
- FastAPI 0.115.x, Celery 5.4.x, Redis 7.x version numbers — training data; official sources not confirmed during research session
- Canvas iCal edge cases (UID instability, floating-time DTSTART) — community reports + known behavior patterns; validate with test feeds
- Competitive landscape (Reclaim.ai, Motion, Notion AI feature sets) — training data through August 2025; validate before citing publicly
- Vercel function timeout limits — training data; verify current limits at Vercel docs

### Tertiary (LOW confidence)
- BullMQ vs Celery vs Inngest comparison — architecture reasoning + training data; verify Inngest TypeScript-only claim before finalizing any decision to switch

---
*Research completed: 2026-03-18*
*Ready for roadmap: yes*
