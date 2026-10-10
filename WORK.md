# Aria — Active Work State

> **This file is the traffic light for the repo.**
> Read it before touching any code. Update it when you start and when you finish (say "wrap up"; see `CLAUDE.md` → Session Protocol).
> Keep it short: live state + the 3 latest handoff notes. History lives in `docs/history/`.
> Both developers (Josh + Seb) run separate Claude Code sessions — this file prevents collisions.

---

## 🔒 Currently In Progress

**Aria V2 build — Daniel (sole engineer; Josh/Seb no longer active).** Pivot to iMessage-first V2, shipping as a free private test. Spec + plans written; scaffolding started (LLM gateway + V2 schema). See the latest handoff note and `docs/plans/2026-10-09-aria-v2-free-testing-plan.md`.

| Developer | Task | Branch | Claimed At |
| --------- | ---- | ------ | ---------- |
| Daniel    | V2 free-test build — master plan Waves 0–3 done; **resume at Wave 4** | main | 2026-10-09 |

---

## 🎯 Up Next (Priority Order)

### 🚀 Aria V2 (free private test) — ACTIVE

Build order — see `docs/plans/2026-10-09-aria-v2-free-testing-plan.md`:

- [x] **V2-00** ✅ 2026-10-09 — Spec + 3 plan docs, LLM gateway (`src/server/llm/`), V2 baseline migration, V1 tagged `v1-final`, V1 migrations archived
- [x] **V2-01** ✅ 2026-10-10 — CLI linked to `onrurwsourjlgfmitezh`; migrations `001`, `002` (pg_cron, pg_net), `003_v2_build` (consolidated build schema) applied; types in `src/server/db/types.ts`
- [x] **V2-02** ✅ 2026-10-10 — landing + signup, magic links, sessions, web shell (`(app)/` route group, PWA manifest, icons, OG cards, CSP, /privacy, /terms)
- [x] **V2-PLAN** ✅ 2026-10-10 — 7 deep branch plans + master plan + build brief + orchestrator notes in `docs/plans/2026-10-10-v2-*.md`
- [x] **V2-W0** ✅ Wave 0 — migration 003, deps (ical.js, jose, server-only, tsx, playwright), contract stubs, shared tz/course-key/register/untrusted
- [x] **V2-W1** ✅ Wave 1 — jobs runtime + dispatch, channels core (Sendblue + dev providers), LLM layer, Canvas pure modules (salvage done), Python parser service (Docker), web shell
- [x] **V2-W2** ✅ Wave 2 — delivery + ingest + webhooks, memory/context/persona, timeline, Google core (OAuth/tokens), Gmail base, reminders + schedule core
- [x] **V2-W3** ✅ 2026-10-10 Wave 3 — turn orchestration + dev loop (3.1), agent loop (3.2), V2-04 tools + pending actions + memory jobs (3.3), Canvas sync/connect (3.4), syllabus TS (3.5), Google OAuth routes + calendar read (3.6); gate fixes: `propose_preference` non-strict (grammar 400), name few-shots, `toView` syllabus weight
- [ ] **V2-W4** Wave 4 — briefing + change alerts (4.1), scheduling + Aria calendar (4.2), Gmail intelligence + email tools (4.3), web setup/week (4.4), web integrations + email draft (4.5), web settings/export/delete (4.6)
- [ ] **V2-W5** Wave 5 — evals (5.1), salvage cleanup + V2 docs rewrite (5.2), end-to-end dev-channel conversation test (5.3), Playwright QA (5.4), code review (5.5)
- [ ] **V2-CREDS** Daniel creates: Sendblue sandbox, Google Cloud project (OAuth client + Pub/Sub), Upstash Redis, Cloud Run (billing), Vercel project — see master plan §7

> **The V1 backlog below (Onboarding / AUD / PH) is SUPERSEDED by V2** — V2 drops the app, Twilio, and Celery and rewrites the identity/schema, so most of it no longer applies. Kept for reference only.

### Onboarding — COMPLETE ✅ (merged to `main` 2026-04-14)

- [x] **OB-C1** ✅ 2026-04-11
- ~~**OB-C2**~~ **CANCELLED** — Apple auth removed
- [x] **OB-P0** ✅ 2026-04-12 — Supabase phone auth + Twilio Messaging Service configured
- [x] **OB-P1** ✅ 2026-04-12 — All 10 code tasks committed
- [x] **OB-C3** ✅ 2026-04-12 — Full redesign: 51-university system, school-agnostic UI, Canvas guide, 23/23 tests
- [x] **OB-C4** ✅ 2026-04-14 — Code review complete, all critical + important findings fixed
- [x] **OB-C5** ✅ 2026-04-14 — Merged `onboarding` → `main`, pushed, branch deleted
- [ ] **OB-D1** — `mobile/app/(home)/preferences.tsx` — logout + integration management UI → **Daniel**

### Audit Follow-ups (logged 2026-09-24 — session 9 audit, see Handoff Notes)

**Must fix before launch**

- [ ] **AUD-01** 🔴 Gmail webhook fan-out — `src/app/api/gmail/webhook/route.ts` dispatches every notification to every Google user with another mailbox's `historyId` (corrupts their cursor), and has no Pub/Sub auth. Fix: store `google_email` on `integrations` at OAuth time (**migration — sync with Josh**), match on `emailAddress`; verify Pub/Sub OIDC JWT or a shared secret in the push URL
- [ ] **AUD-02** 🔴 Unsigned user IDs in OAuth/webhooks — `/api/auth/google?user_id=` (tools.tsx), Todoist `state=user.id` (preferences.tsx → `auth/todoist/callback`), and GCal `x-goog-channel-token` (`gcal/webhook`) all trust a raw UUID → anyone with a UUID can link their Google/Todoist account to a victim or trigger unlimited syncs. Fix: short-lived HMAC-signed state issued from the JWT; GCal: look up by `channel_id` and compare token
- [ ] **AUD-03** Todoist `access_token` stored plaintext (`auth/todoist/callback`) — route through the Fernet encrypt task like Google (use `enqueueCeleryTask`)
- [ ] **AUD-04** Gmail watch lapses after 7 days — Gmail + GCal share `integrations.watch_expires_at`; GCal renewal runs first and hides Gmail rows. Fix: `gmail_watch_expires_at` column (**migration — sync with Josh**)
- [ ] **AUD-05** End-to-end test with real Redis + Celery worker + Twilio SMS (fixes were verified against Celery's in-memory broker only)
- [ ] **AUD-06** Add env vars now required by `/api/health` to Vercel: `TWILIO_WEBHOOK_URL`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- [ ] **AUD-07** Confirm Supabase `auth.users.phone` format (digits-only expected) — `users.phone` now normalized to `+E.164`

**Product / design needed**

- [ ] **AUD-08** Priority engine rarely surfaces deadlines — `canvas_sync_user` never re-scores as due dates approach; digest rows marked `sent` before SMS even if suppressed; ≥80 tier unreachable (no `grade_weight`); deletes/"done" not mirrored to `canonical_events`
- [ ] **AUD-09** Home dashboard always empty — `/api/deadlines`, `/api/chat`, `/api/briefing/preview` don't exist (`mobile/lib/api.ts`, `hooks/useCards.ts`); Home never renders `error` → decide owner (Seb/Josh)
- [ ] **AUD-10** Hidden cards can't be restored — `useCards` stores in AsyncStorage, Preferences reads `preferences_json.hidden_cards` → unify on one store

**Mobile robustness**

- [ ] **AUD-11** Android Google connect — `WebBrowser.openBrowserAsync` resolves immediately so the 12s poll expires mid-consent; use `openAuthSessionAsync` or re-check on AppState `active` (`tools.tsx`)
- [ ] **AUD-12** Root `_layout.tsx` unmounts `<Stack>` (spinner) right after OTP verify while `verify-phone` navigates — render Stack always, spinner as overlay
- [ ] **AUD-13** `success.tsx` — on `completeOnboarding()` failure show Retry instead of proceeding
- [ ] **AUD-14** `ChatBar.handleVoiceResult` discards transcribed text; Canvas empty feed (422) shows "Couldn't reach" instead of 0 deadlines
- [ ] **AUD-15** Set up mobile ESLint (`npx expo lint` scaffolds config; `eslint` not in mobile deps)
- [ ] **AUD-16** Verify on device: iOS SMS OTP autofill (enabled in `PinInput`), Android Google OAuth

**Worker leftovers (low)**

- [ ] **AUD-17** `welcome_briefing` check-then-write race on concurrent calls; welcome SMS never retried if blocked by quiet hours
- [ ] **AUD-18** `gcal/writeback.schedule_study_block` uses UTC-day bounds (same bug fixed in `sms/schedule.py`)
- [ ] **AUD-19** Gmail at-least-once: a failed run can re-insert `gmail_flags` and re-alert on next notification
- [ ] **AUD-20** GCal/Gmail `Credentials` built without `expiry` → proactive refresh never runs; refreshed token never persisted
- [x] **AUD-21** ✅ 2026-10-09 — Git remote updated → `https://github.com/Use-Aria/aria-mvp.git` (Daniel's machine; Josh + Seb run the command in the handoff note)

### v1.1 App Store Launch

- [ ] **PH10-02** — Fill Apple Developer credentials (`APPLE_ID`, `ASC_APP_ID`, team ID), run `eas build --platform ios --profile preview`, verify TestFlight install → **Josh**
- [ ] **PH11-01** — Plan + execute Phase 11: Deploy Next.js to Vercel, Celery workers to Railway, configure all production env vars → **Josh**
- [ ] **PH12-01** — Plan + execute Phase 12: Privacy Policy, Terms of Service, App Store Connect listing, screenshots, submit for review → **Josh + Seb**

---

## ✅ Completed

### v1.0 MVP — Shipped 2026-03-21

| Phase                                 | What shipped                                                                                                                  | Date       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Phase 1 — Infrastructure              | Next.js 15.2, Supabase schema+Auth+RLS, Celery+Redis+Docker                                                                   | 2026-03-18 |
| Phase 2 — Canvas Sync                 | iCal fetch, diff engine, Celery Beat 60-min sync                                                                              | 2026-03-18 |
| Phase 3 — Twilio SMS + TCPA           | send/receive SMS, TCPA guards, keyword dispatch, Twilio webhook                                                               | 2026-03-19 |
| Phase 4 — Claude AI + Daily Briefing  | Claude Sonnet briefings, conversational replies, exam countdowns                                                              | 2026-03-19 |
| Phase 5 — Priority Engine             | canonical_events table, priority scoring (0–100), send_priority_alert                                                         | 2026-03-19 |
| Phase 6 — Google OAuth + GCal + Gmail | Fernet-encrypted tokens, GCal sync + push, Gmail pipeline (Haiku classify), conflict detection, study blocks, SMS batch queue | 2026-03-20 |
| Phase 7 — Syllabus + Study Gap        | Claude Opus PDF parsing, never-re-parse guard, gap analysis Beat (T-5), briefing enrichment                                   | 2026-03-21 |
| Phase 8 — iOS App + Onboarding        | Expo React Native app, 4-zone dashboard, in-app chat, Google OAuth, onboarding flow                                           | 2026-03-20 |
| Phase 9 — Todoist Integration         | Todoist OAuth, task sync, SMS CRUD, briefing integration                                                                      | 2026-03-20 |
| Phase 10-01 — iOS Build Config        | `eas.json` + `app.json` fixes written (Apple credentials still needed)                                                        | 2026-03-21 |
| SCH-01 — On-Demand Scheduling         | `sms/schedule.py` created, `replies.py` updated, 34 new tests, 306 total passing                                              | 2026-03-22 |

---

## 📋 Handoff Notes

### 2026-10-10 — Daniel (V2 build: Wave 3, orchestrated by sub-agents)

**Where to resume:** master plan §5 **Wave 4** (tasks 4.1–4.6). Read `docs/plans/2026-10-10-v2-orchestrator-notes.md` → **Wave 3 hand-off notes** first. They hold the exports and deviations that Wave 4 builds on, and the rules for tool schemas.

**Done this session:**
- **Six parallel sub-agents built Wave 3:**
  - turn orchestration + `scripts/dev-chat.ts` REPL (3.1)
  - agent loop + escalation + run stats (3.2)
  - 16 core tools, pending actions (chat + web path), memory extraction/summary, account purge (3.3)
  - Canvas connect/sync + tools (3.4)
  - syllabus TS client/intake/upload (3.5)
  - Google OAuth GET start/callback, calendar read/watch/push, disconnect (3.6)
- **Gate is green:**
  - build, tsc and lint pass;
  - unit 1773/1773 (was 1417), smoke 130/130 on the local stack, parser 187/187;
  - `_stub` importers 54 → 17.
- **Live gate check** (real Haiku on the local stack, ~$0.04 total):
  - welcome → name → agenda works;
  - dev-channel PDF → syllabus parsed (fake-LLM parser) → confirmation bubbles;
  - the agent writes every stat onto the pipeline's `agent_runs` rows.
- **Gate fixes:**
  - **Blocker:** every real-agent call 400'd with "compiled grammar is too large". `propose_preference` is now non-strict, and an opt-in `SMOKE_LLM=1` grammar smoke test guards against a repeat.
  - Name capture after the welcome went from ~50% to 10/12 (two few-shots).
  - Syllabus grade weight now reaches the Canvas twin (`toView`).

**Open / needs Daniel:**
- Commit approval for Wave 3.
- Credentials (Sendblue, Google, Upstash, Cloud Run, Vercel).
- A contact email for `/privacy`.

**Know before you start:**
- Run `SMOKE_LLM=1 npm run smoke -- tests/smoke/llm-grammar.smoke.test.ts` (export `ANTHROPIC_API_KEY`) after any tool-schema change. Don't make nested-schema tools strict.
- `npm run dev:chat -- --local` gives a local REPL against the stack (`ARIA_AGENT=real` for the real agent).
- `recoverStuckActions` needs a timer; 4.1's reconcile should call it.
- Google connect needs Safari ≥ 16.4: a missing `Sec-Fetch-Site` header gets a 403.

### 2026-10-10 — Daniel (V2 build: plan + Waves 0–2, orchestrated by sub-agents)

**Where to resume:** `docs/plans/2026-10-10-v2-master-plan.md` §5 **Wave 3** (tasks 3.1–3.6). Read the master plan (it overrides the branch plans), then `docs/plans/2026-10-10-v2-orchestrator-notes.md` (binding hand-off notes per wave), then the cited branch-plan sections. Every task is one sub-agent with exclusive file ownership; the orchestrator runs the wave gate (build, tsc, lint, `npm test`, `npm run smoke`, parser pytest) and checks `grep -rln '@/server/_stub' src | wc -l` (54 now; 0 required after Wave 4).

**Done this session:**
- V2-01 applied (001+002+003 live on `onrurwsourjlgfmitezh`); V1 TS code removed; Next 15.5 → **16.4.0**, React 19.2.8, Jest 30.
- Deep analysis: 7 branch plans (V2-03…08 + web) → reconciled master plan (final contracts, 45-item conflict log, waves, decisions D1–D12, runbooks) + consolidated migration `003_v2_build.sql` (validated on a local Supabase stack first).
- Waves 0–2 implemented by sub-agents: ~1,417 unit tests, 85 smoke tests (local Supabase), 187 parser pytest — all green; build/tsc/lint green.
- Python parser service (`services/parser/`, FastAPI, Docker, HMAC auth) passed a live Sonnet 5.5 parse (~$0.03). docker-compose now has only `parser`.

**Decisions taken with defaults (Daniel can override — master plan §6):** D1 debounce in the Postgres jobs row (deviation from "Redis for debounce"; Upstash keeps the run lease + rate limits) · D2 new V2 "a" icon · D3 Cloud Run for the parser (needs billing) · D4 try vercel.app before buying a domain · D5 minimal /privacy + /terms · D6 separate parser API key · D7 Sonnet for syllabi · D8 urgent alerts don't break quiet hours · D9 988 crisis rule · D10 reconstructed few-shots (paste the original example conversations if you have them) · D11 shared Supabase for dev+prod for now · D12 Sendblue settings.

**Open / needs Daniel:** commit approval (nothing committed — migrations changed); credentials (Sendblue, Google, Upstash, Cloud Run, Vercel); a contact email for `/privacy`.

**Know before you start:**
- A local Supabase stack runs in Docker (`supabase start`; API :54321, DB :54322) — smoke tests use it. Docker Desktop must be running.
- Run TS scripts with `npx tsx --conditions=react-server --env-file=.env.local …` (`server-only` throws outside Next). Jest does NOT load `.env.local`.
- Sendblue/Google facts still marked [verify] are listed in master plan §7.3 + orchestrator notes; tapback parsing is off until the sandbox confirms the shape.

### 2026-10-09 — Daniel (V2 pivot: spec + scaffold start)

**Big shift:** Aria is pivoting to **V2** — iMessage-first (no app), magic-link web/PWA, a real tool-using agent with memory. Shipping first as a **free private test** (Daniel + ≤9 friends via the Sendblue sandbox; ~$0 infra; LLM covered by the Max plan's $100/mo API credits). Daniel is now the **sole engineer** — the Josh/Seb ownership + collision rules in this file are historical.

**Read first (canonical V2 docs):**
- `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md` — full architecture + rationale (every choice: options → pick → why; §5 schema, §8 decision log).
- `docs/plans/2026-10-09-aria-v2-free-testing-plan.md` — what we build now (and the stack table).
- `docs/plans/2026-10-09-aria-v2-production-plan.md` — deferred/paid path (incl. the Canvas NetID-vault decision + risks).
- `docs/v1-to-v2-changes.md` — what changed and why.

**Locked decisions:** WhatsApp deferred · iMessage = Sendblue sandbox · language = TS app + small Python parser (HTTP, never a cross-lang queue) · keep Docker + Redis (Upstash), drop Celery (revisit V3) · Gmail in from day one · Canvas = iCal for the test (encrypted NetID vault is a **production-only** decision with risks recorded — do NOT build it in the test) · beta open to anyone · LLM = Claude Haiku 5.5 + Sonnet 5.5 escalation · repo on `main`, V1 tagged `v1-final`. "Ignore safeguards" → dropped the compliance *process* but KEPT three cheap friend-protections: confirm-before-send on email, memory only from user-authored text, ask before connecting a friend's accounts.

**Sub-decisions (confirmed by Daniel 2026-10-10):** calendar writes → a dedicated "Aria" calendar · persona → mirror the user's register · history retention → 180d · Sonnet escalation cap → 10% · domain → stay on `*.vercel.app` for the test.

**Done this session:** spec + 3 plan docs; `.env` reset to V2 vars (old → `.env.local.v1.bak`, gitignored; app secrets auto-generated — **back up `APP_ENCRYPTION_KEY`**); Anthropic key verified (Haiku/Sonnet 5.5 available, $100/mo Max credits cover it); installed `@anthropic-ai/sdk` `openai` `@upstash/redis` `zod`; wrote `src/server/llm/index.ts` (provider-agnostic gateway, type-clean); archived V1 migrations → `docs/history/v1-migrations/`; wrote `supabase/migrations/001_v2_baseline.sql`. **lint + build pass.**

**Blockers for next session:**
- **Supabase:** the new project (ref `onrurwsourjlgfmitezh`) still 401s on even no-key endpoints → not Active / wrong URL. Get it Active, re-copy URL, re-link CLI, `supabase db push`. (`supabase/.temp` still points at the OLD project.)
- Create the **Sendblue sandbox** account (number + webhook) and the **Google OAuth client** (Gmail + Calendar) when ready.

**Gotcha learned:** new Supabase projects issue new-style keys (`sb_publishable_…` / `sb_secret_…`) and the legacy anon JWT may be disabled — use the publishable key for `NEXT_PUBLIC_SUPABASE_ANON_KEY` and the secret key for `SUPABASE_SERVICE_ROLE_KEY`.

**Not committed:** all V2 scaffolding is uncommitted, pending Daniel's approval (he approves before commit/push to `main`). `supabase/migrations/` changed, so per the Session Protocol this needs his explicit go.

---

_Older notes: `docs/history/handoffs.md`._

---

## ⚠️ Collision Rules

1. **Never start a task that's already claimed** in the "Currently In Progress" table
2. **Always `git pull origin main` before claiming** — another dev may have finished and pushed
3. **One task at a time per developer** — finish and push before claiming a second
4. **Seb: do not touch `src/lib/`, `src/app/api/`, `celery_worker/`, or `supabase/`** — Josh owns these
5. **Josh: do not touch `mobile/src/app/(pages)/` or `mobile/src/components/`** — Seb owns these
6. **Both: never modify `src/types/index.ts` without telling the other person first**
