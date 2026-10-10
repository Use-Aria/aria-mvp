# Aria V1 → V2: what changed and why

> Companion to `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md`. V2 is first shipping as a **free private test** (`docs/plans/2026-10-09-aria-v2-free-testing-plan.md`).
> Dated 2026-10-09.

## One-line summary

V1 was an Expo iOS app + Twilio SMS assistant whose "AI" was a one-shot intent classifier, backed by a Python Celery/Redis worker on infra a former teammate owned — and it was never deployed. V2 drops the app, lives in iMessage, and is a real tool-using agent with memory, on infra Daniel owns.

## Product

| Area | V1 | V2 | Why |
|---|---|---|---|
| Surface | Expo iOS app (App Store) | No app — lives in iMessage; mobile web/PWA opened via texted magic links | "Everything in your messages." An app to download works against that and doubled the codebase. |
| Channel | Twilio SMS | Sendblue iMessage (+ SMS/RCS fallback) | Real tapbacks, threaded replies, typing indicators; "texting a friend", not an SMS bot. |
| WhatsApp | Planned (Sendblue v2) | Deferred | Meta's terms (2026-09-23) bar AI-first assistants from the WhatsApp Business Platform in the US; Poke was cut off. |
| Onboarding | In-app, Supabase phone OTP | Landing page → "Text Aria" → the inbound message is the proof; magic links for setup | The inbound text proves control of the handle; no OTP round-trip. Handles can be an Apple ID email, so identity = channel handle, not phone. |
| "AI" | Intent classifier + keyword intercepts + one-shot reply, no history on the intent call | Tool-using agent loop with memory, caching, and escalation | V1 couldn't resolve "move it to Friday" or hold context; it was a narrow deadline bot. |
| Memory | None (a couple of preference fields, read-modify-write) | Tiered: always-in-context profile + confirmed preferences (dated validity) + searchable facts | The spec's "self-improving memory." Behavior-changing preferences are confirmed; facts are extracted in the background. |
| Canvas | iCal (free test); encrypted NetID credential login planned for production | iCal + notification emails (free); credential vault recorded as a production decision with risks | iCal needs no auth and no institutional approval; the credential path has real policy/legal risk (see production plan). |
| Reminders | "Remind me…" misrouted to Todoist | First-class reminders, anchored to a deadline + offset so they move when the due date moves | Matches the spec's "remind me 2 hours before it's due." |
| Scheduling | Always offered the earliest 7am gap; learning needed 3 confirmations | Slot finder respects preferences/buffers/past-time; negotiates in plain language | V1 offered 7am to evening people and its learning loop was circular. |
| Todoist / Spotify | In scope | Dropped | Not in the V2 spec. |

## Architecture

| Area | V1 | V2 | Why |
|---|---|---|---|
| Language | Python worker + TypeScript API | TypeScript primary app + small Python service (syllabus/PDF parsing) over HTTP | Daniel wants both. The boundary is HTTP, not a hand-built queue — V1's cross-language Celery envelope silently dropped every enqueued task until 2026-09-24. |
| Compute | Next.js (Vercel) → Redis → Celery/Beat (Railway) | One Next.js app (Vercel) + Python parser service | Fewer moving parts for a solo dev; removes the queue that failed silently. |
| Jobs/scheduling | Celery Beat + Redis (broker) | Postgres `jobs` table + Supabase Cron for scheduled/delayed work; Redis (Upstash) kept for per-user debounce/lease + rate-limits; **Celery dropped** (reconsider V3) | Reminders become editable SQL rows that fire within ~15s and dodge Celery's ETA re-delivery bug; Redis stays for what it's good at (fast TTL locks), not as the broker; Celery needs an always-on box and reintroduced the TS↔Python queue that failed in V1. |
| Priority engine | `priority/` + `canonical_events` scoring | Deleted — urgency computed at read time over `timeline_items` | V1's "immediate" tier was mathematically unreachable (AUD-08); date changes created duplicate rows. |
| Identity/DB | `users.id` FK to Supabase `auth.users`, phone OTP, RLS on `auth.uid()` | Own sessions; `users` + `channels`; RLS deny-all, access via service role | No app and no OTP, so Supabase Auth isn't the identity source. |
| Model | Sonnet 4.6 (replies/briefing), Opus 4.6 (syllabus), no caching | Haiku 5.5 (chat, cached) + Sonnet 5.5 (drafting/escalation) | ~$1/1k turns vs ~$24; Haiku 5.5 released 2026-10-07 at $0.10/$0.50. |
| Token encryption | Fernet (AES-128), tokens through Redis in plaintext | AES-256-GCM, versioned key, never through a queue | CLAUDE.md claimed AES-256; Fernet is AES-128-CBC. |
| Hosting ownership | Railway owned by a former teammate; `TOKEN_ENCRYPTION_KEY` not in Daniel's env | Everything under Daniel's accounts; fresh accounts, no data migration (V1 never launched) | Daniel wants full control; rotate every secret a former teammate could see. |
| Mobile app | `mobile/` (5.7k LOC Expo) | Removed (salvage: university list, Canvas guide copy, design tokens, week-view ideas) | No app in V2. |

## Corrections to older repo docs

- `gmail.readonly` is a **restricted** Google scope (needs CASA), not "sensitive" as CLAUDE.md / PRODUCTION.md state.
- V1 was **never deployed** (Vercel/Railway unchecked in PRODUCTION.md), so there is no production data to migrate.
- Ownership/collision rules in CLAUDE.md and WORK.md (Josh/Seb areas) are stale — Daniel is the sole engineer as of 2026-10-09.
