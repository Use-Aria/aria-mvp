# Aria V2 — Free Testing Plan (what we build first)

> **Status:** Approved direction (Daniel, 2026-10-09). This is the thing we execute against.
> **Goal:** Aria V2 running for Daniel + 3 friends, at ~$2–7/month total (all of it LLM).
> **Full architecture and rationale:** `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md`.
> **Production path (paid, scaled, verified):** `docs/plans/2026-10-09-aria-v2-production-plan.md`.
> **What changed from V1 and why:** `docs/v1-to-v2-changes.md`.

---

## Locked decisions (2026-10-09)

| Question | Decision |
|---|---|
| WhatsApp | **Deferred.** iMessage only, with SMS/RCS fallback for Android. |
| Language | **Both.** TypeScript is the primary app (web, webhooks, agent, LLM). A small Python service handles syllabus/PDF parsing (and the ported Canvas iCal parse), called over HTTP. |
| Beta audience | **Open ("anyone").** For this stage that means Daniel + 3 friends he knows. Age-gate (13+) is a production item before truly public signup. |
| Canvas (free tier) | **iCal feed + notification emails only.** The encrypted NetID credential path is a *production* decision, documented separately, and not built here. |
| Compliance process | **Deferred** for the private test (no CASA, no formal TCPA flow, no ToS/age-gate). |
| Friend-protection safeguards | **Kept:** confirm-before-send on email; only user-authored chat text can write memory or trigger actions; ask each friend before connecting their accounts. |

---

## The free stack

| Piece | Free option | Catch we accept |
|---|---|---|
| iMessage | **Sendblue sandbox** (2026-10-09): one shared number, ≤10 verified contacts. Matches the production pick (Sendblue AI Agent line) so there's no migration when we outgrow it. | Shared number; sandbox terms unverified for ongoing use — confirm the ≤10-contact cap in the dashboard at signup. ≤10 contacts caps this test at ~you + 9 friends. |
| Hosting | Vercel Hobby | Non-commercial only — don't charge anyone. |
| Database | Supabase Free | No backups (nightly `pg_dump` to your own storage); pauses after a week idle (a daily cron keeps it awake). |
| Google (Gmail + Calendar) | Our own OAuth client, consent screen set to **"In production", unverified** | Each friend clicks through Google's "unverified app" warning. ≤100 users lifetime. **Test with one Yale friend first** — EliApps may block unverified apps. Never use "Testing" status (7-day refresh-token expiry). |
| Canvas | iCal feed + Canvas/Gradescope notification emails via Gmail | None. |
| Domain | Free `*.vercel.app` URL | None. OG preview cards still work. |
| LLM | Claude Haiku 5.5 (chat), Sonnet 5.5 (drafting/escalation), background on Haiku | The only real cost: ~$2–7/mo for four heavy users. |
| Monitoring | Sentry free + our own `llm_calls` cost table | None. |
| Secrets/token encryption | App-level AES-256-GCM, key in a Vercel env var + password-manager backup | None. |

**Not Gemini free tier** (trains on data, and the agent reads friends' email). **Not free open-model tiers** (weaker tool use/tone).

**Jobs / Redis / Docker (2026-10-09 decision):** Keep Docker (the Python parser service + a local `docker-compose` for dev) and keep Redis — **Upstash free tier, serverless**, used for the per-user debounce window, the conversation run-lease, and rate-limiting (what Redis is actually good at). The Postgres `jobs` table + Supabase Cron handles scheduled/delayed work (reminders, briefings). **Celery is dropped** for V2 (needs an always-on worker+beat box, not free and not on Vercel; reintroduces the TS↔Python queue that silently failed in V1; weak at arbitrary-time reminders) and **reconsidered for V3/production** — see the production plan. All three stay $0: Upstash Redis free, Docker runs in CI/the parser host.

---

## Build order

Each milestone is runnable before the next starts.

**F0 — Accounts (no code).** Anthropic key (Daniel's org); Supabase free project (`aria-test`); Google Cloud OAuth client (Gmail readonly + calendar, "In production"); iMessage provider account; Vercel Hobby project; Sentry. Put every secret in Vercel env + password manager.

**F1 — Skeleton.** Next.js 16 app on `main`. Supabase baseline migration (trimmed §5 schema: `users`, `channels`, `signups`, `messages`, `jobs`, `magic_links`, `web_sessions`, `user_profile`, `user_preferences`, `memory_facts`, `timeline_items`, `reminders`, `pending_actions`, `integrations`, `llm_calls`). Landing page + signup. Magic-link module (fragment token, JS-POST redeem) + server sessions.

**F2 — The loop.** iMessage webhook (verify signature → idempotent upsert → debounce → per-user lease). Agent loop over the `llm` module (Haiku 5.5, caching, escalation to Sonnet 5.5). Persona + 15–20 few-shot exchanges. Memory core (profile + preferences always in context; `recall` tool). Reply renderer (typing indicator, 1–3 bubbles, reactions).

**F3 — Academic spine.** Canvas iCal connect + hourly sync (ported parse, with the `[Course]` fix). `jobs` table + Supabase Cron 15s tick → `/api/jobs/dispatch`. Reminders. Daily briefing (local-time, deferred not dropped). `/week` view.

**F4 — Google.** OAuth connect. Calendar read + "Aria" calendar writes + slot finding/negotiation. Gmail push + rules prefilter + Haiku classifier + alerts. Draft email → confirm-in-chat → `gmail.send`. Syllabus via iMessage attachment → Python parser.

**Python service** (stands up alongside F4, or earlier if convenient): a small FastAPI worker exposing `POST /parse-syllabus` (Claude Sonnet 5.5 native PDF) and optionally `POST /parse-ical`. The TS app calls it over HTTPS with a shared secret — **no cross-language queue** (that's the V1 bug that silently dropped every task).

---

## Deliberately skipped vs production

CASA/verification, formal TCPA consent capture, age-gating, ToS/privacy policy, paid infra, backups/PITR, multi-line Sendblue scaling, the Canvas credential vault, WhatsApp, PWA install/pairing, nightly self-improvement consolidation. All tracked in the production plan.

---

## Résumé-keyword alignment (2026-10-09 research)

The point is that these map to things Aria *actually does* — a bullet you can't defend in an interview is worse than leaving it off. For new-grad SWE, keywords get a résumé parsed/found; referrals + a demoable project get the interview.

**Already earned by the V2 stack:** TypeScript, React/Next.js, Node, PostgreSQL, **pgvector + embeddings (RAG)**, Redis, Docker, Python/FastAPI, REST/webhooks, OAuth 2.0, Google Pub/Sub, **LLM tool-calling agent + memory + prompt caching**, Anthropic + OpenAI APIs, Sentry, Vercel. V1 history (truthful): Celery, Twilio, Expo/React Native, Docker Compose.

**Cheap V2 adds (ranked):** (1) GitHub Actions CI/CD — fold in; (2) Jest + Playwright unit/e2e — fold in; (3) name the RAG pipeline explicitly — fold in; (4) LLM evals harness — already planned (spec §4.11); (5) MCP server exposing Aria's tools — opt-in; (6) OpenTelemetry tracing — opt-in.

**Save for V3:** Kubernetes, Prometheus/Grafana, Terraform/IaC, a targeted AWS component (S3 for syllabus PDFs closes the cloud gap), WebSockets, Redis Streams.

**Don't chase (stuffing / declining):** Kafka, GraphQL, gRPC, Elasticsearch/OpenSearch, RabbitMQ, LangChain, jQuery/Angular/Selenium.

Source caveat: no 2026 Stack Overflow survey yet; much "2026 keyword" content is vendor SEO. Firm signals (ITJobsWatch to 2026-10-09, Grafana observability survey, LinkedIn Jobs-on-the-Rise naming AI Engineer the #1 fastest-growing US role) agree directionally; treat exact percentages as rough.

## Blocking items before coding starts

1. iMessage provider pick (F0).
2. Confirm repo strategy (build on `main` in this repo; tag `v1-final`; remove `mobile/` + `celery_worker/` after salvage).
3. Anthropic key + Supabase project exist (needed to run anything).
4. Whether Gmail is in from the start or added after the core loop works.
