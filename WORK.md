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
| Daniel    | V2 free-test build — master plan Waves 0–4 done; **resume at Wave 5** | main | 2026-10-09 |

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
- [x] **V2-W4** ✅ 2026-10-10 Wave 4 — briefing + change alerts (4.1), scheduling + Aria calendar (4.2), Gmail intelligence + email tools (4.3), web setup/week (4.4), web integrations + email draft (4.5), web settings/export/delete (4.6); gate fixes: deterministic timeline tie-break, gmail smoke key, keepalive anon key, `sendRaw` eslint rule
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

### 2026-10-10 — Daniel (V2 build: Wave 4, orchestrated by sub-agents)

**Where to resume:** master plan §5 **Wave 5** (5.1–5.4 in parallel, then 5.5 code review). Read `docs/plans/2026-10-10-v2-orchestrator-notes.md` → **Wave 4 hand-off notes** first. They list the exports, the deviations, and four follow-ups (cost accounting, "book it" UX, double interim, a timeline barrel helper).

**Done this session:**
- **Six parallel sub-agents built Wave 4:**
  - briefing generation + change alerts + reconcile + daily cron + GH keepalive (4.1)
  - free-slot finding + Aria calendar block tools (4.2)
  - Gmail classify/alerts/triage + `search_email`/`read_email`/`draft_email` + send executor (4.3)
  - `/setup` schedule/tone + `/week` (4.4)
  - `/setup` Canvas/Google + `/email/[id]` draft page (4.5)
  - `/settings` + export + account delete (4.6)
- **Gate is green:**
  - build, tsc and lint pass (new eslint rule: only `gmail/send.ts` may import `sendRaw`);
  - unit 2021/2021 (was 1773), smoke 188/188 + 1 opt-in skipped, parser 187/187, grammar smoke with all 31 tools;
  - `_stub` importers 17 → 1 (only `_stub.ts`; 5.2 deletes it).
- **Gate fixes:**
  - Flaky test root-caused: timeline lists broke ties by random UUID, so two all-day deadlines on one date swapped places between runs. Ties now sort by title.
  - The Gmail smoke no longer makes real Haiku calls when the key is exported.
  - Copy-deck strings; a fresh-link slot for the Canvas section.
  - The keepalive uses the anon key, not the service-role key.
- **Live gate check** (real Haiku, fake Google, local stack, ~$0.007): all four pass.
  - The briefing comes from the model, wraps untrusted text, and links via `digest`.
  - A Canvas due change sends one alert; a replay sends nothing.
  - `find_free_slots` → `create_block` lands on the Aria calendar, never primary.
  - `draft_email` → the action can't be confirmed in the same run; a web confirm sends exactly once.

**Open / needs Daniel:**
- Credentials (Sendblue, Google, Upstash, Cloud Run, Vercel), plus the new GitHub repo secrets for the keepalive.
- A contact email for `/privacy`.

**Know before you start:**
- None of the Wave 4 pages has been clicked through in a browser; that's 5.4.
- **Decided (Daniel, 2026-10-10):** "…and book it" with one fitting slot keeps asking first; leave `persona/style-guide.ts:45` as is.
- `agent_runs.cost_usd` undercounts runs whose tools call an LLM themselves (e.g. the Sonnet draft call). Fix in Wave 5.
- The [verify] list for real Google (Aria calendar CRUD, Message-ID recovery, threading) is in the Wave 4 notes.

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
