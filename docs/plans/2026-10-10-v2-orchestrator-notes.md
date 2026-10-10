# Aria V2 — Orchestrator Notes (binding for every wave task)

> Running log of decisions made while executing `2026-10-10-v2-master-plan.md`. Read after the master plan. Newest at the bottom of each section.

## Environment

- Live V2 Supabase project `onrurwsourjlgfmitezh` has migrations 001–003 applied. Types in `src/server/db/types.ts` are current.
- A **local Supabase stack** is running (Docker): API `http://127.0.0.1:54321`, DB `127.0.0.1:54322`; get keys with `supabase status`. Smoke tests may target either; prefer **local** for anything that writes many rows. Always delete throwaway rows.
- Deps installed (master plan §3). `npm test`, `npm run smoke`, `npx tsc --noEmit`, `npm run lint` work. Do not run `npm run build` (orchestrator does it at the gate).
- Nothing is committed yet (Daniel approves commits). Don't use git to stash/reset/checkout anything.

## Decisions (defaults from master plan §6, in force unless Daniel overrides)

D1 debounce in the jobs row · D2 new V2 "a" icon · D3 Cloud Run parser · D4 try vercel.app first · D5 minimal /privacy + /terms · D6 separate parser Anthropic key · D7 Sonnet for syllabus · D8 urgent alerts don't break quiet hours · D9 988 crisis rule included · D10 reconstructed few-shots · D11 shared Supabase for now (tick is a no-op until Vault secrets) · D12 Sendblue settings as stated.

## Wave 0 hand-off notes

- **Stub gate:** tool stubs return `stubToolResult(...)`, so the wave-4 gate greps for `@/server/_stub` imports (count was 76 after Wave 0), not `notImplemented(`. When you implement a stubbed file, remove its `_stub` import.
- `NotImplementedError extends PermanentJobError` → a job hitting a stub dead-letters immediately. Only `noop` and `timeline_changes` return done.
- `OutboxItem` + `OutboxItemSchema` live in `src/server/channels/types.ts` (frozen); `channels/plan.ts` (1.2) re-exports them.
- Type-only stubs created for files 1.4 owns: `src/shared/canvas-url.ts`, `src/shared/canvas-guide.ts`, `src/server/integrations/canvas/fetch-feed.ts`, `src/server/integrations/canvas/parse.ts`. **1.4 fills them and must keep the exported type names.**
- Types 0.2 had to invent (now part of the contract): `ReminderView`, `CreateReminderInput` (takes a resolved `itemId`, not an alias), `IntakeOutcome`, `AccountExport`, `OpenAction`, `PendingActionView` (`result: Record<string, JsonValue>`), `syllabus/contract.ts` (mirrors V2-08 §8.1). `JsonValue` comes from `timeline/types.ts`.
- Tools are named exports `xxxTool`; inputs are `z.strictObject`; aliases are 8–10 hex.
- `agent/tools/define.ts` strips `$schema` before the SDK transform (otherwise `zodOutputFormat` leaks it into descriptions). 1.3 must keep this.
- `src/server/llm/index.ts` lacks `import "server-only"` — 1.3 adds it.
- `agent/types.ts` re-exports `UntrustedSource` from `agent/untrusted.ts` (0.3's file). 1.3 may remove the `TODO(0.2)` comment in `untrusted.ts`.
- Time formatting (0.3): `formatForChat` says "today 9pm", "tmrw", "yesterday"; NY spring-forward gap 02:30 → 03:30 EDT (V2-06 rule).
- **Change request for 1.5:** Python `course_key` takes ONE input (mirrors TS `courseKey(input)` and `tests/fixtures/contract/course_key_vectors.json`) and returns `None` where TS returns `null`.
- 003 fixes made in 0.1: `advance_gmail_cursor` uses CASE (no numeric cast on non-numeric); added `jobs_dedupe_active_idx` on (dedupe_key) for pending+running.

## Wave 1 hand-off notes

- **Gate result:** build, tsc, lint green; unit 901/903 (the 2 failures are the stale stub assertions in `tests/unit/contracts/registry.test.ts`, fixed in the Wave 2 gate task); smoke 19/19; parser pytest 187/187. `@/server/_stub` importers: 74.
- **Running scripts outside Next:** `server-only` throws outside the Next runtime. Run TS scripts with `npx tsx --conditions=react-server --env-file=.env.local <script>` (1.3). `scripts/dev-tick.ts` POSTs to `/api/jobs/dispatch` every 2s, so it needs `npm run dev` running (1.1).
- **Jobs (1.1):** `runDueJobs`/`runClaimed`/`deadLetterUnknownKinds` take an optional `deps` (store, registry, clocks, rng) for tests. `cancelJobs` refuses an empty filter. Dispatch accepts HMAC POST (pg_net) and `Authorization: Bearer $CRON_SECRET` GET (Vercel Cron). The HMAC has a pgcrypto-computed test vector.
- **Channels (1.2):** dev webhook payload carries `replyToProviderId` (not `messages.id`) — **2.1's `/api/channels/dev` route maps it**. Guards also export `earliestAllowedSend`, `outboxRunAt`, `capDayStart`, `isWindowOpen` — 2.1 and 2.6 should use these rather than re-deriving quiet-hour math. `commandReply(cmd, ctx?)`. `validatePlan` replaces disallowed URLs in bubble text with "[link removed]" and allows media-only plans. Rejected inline reply → `errorKey "reply_to_rejected"` → `execute` resends once without reply_to. 422 `unsupported_on_this_line` narrows `capabilities()`. Inbound tapback parsing is OFF by default until the Sendblue sandbox confirms the shape.
- **LLM (1.3):** `PRICING` has `cacheWrite1h`; `LlmRequest.maxTokens`; `resolvePlan(…, opts)` 5th arg (user message aliases + newest); `AliasTable.resolveAttachment`. Sonnet 5.5 rejects `thinking:{type:"disabled"}` — a "disabled" route maps to `between_tools` on Sonnet. Haiku >100K-token prompts are priced 5×. `recordLlmCall` gives up after 1.5s.
- **Canvas (1.4):** extra exports `isAcceptableFeedSource`, `createHttpsTransport`, `pinnedLookup`, `TransportError`, `shortCourseLabel`, cap constants; `decideAfterFailure(…, rand?)`. A 400 without `x-canvas-meta n=public_feed` is `slow_transient` (never revokes); 200 HTML → `not_calendar`. NYU redirects to /login → `feed_not_found`. Salvage of `mobile/lib/universities.ts`, Canvas guide copy, and `celery_worker/canvas` logic is DONE.
- **Parser (1.5) → requests for 3.5 (TS client):** re-sign every retry with a fresh timestamp (replay protection keys on the signature); don't retry a 503 `overloaded` that took > ~150s; accept attempt model `fake-llm` (zero tokens) and fallback model ids; `issue.path` is always a string (`""` when none); the secret is raw UTF-8 bytes; price ~5k input tokens of schema overhead. Goldens: `services/parser/tests/fixtures/contract/*.json` (incl. `signing_vectors.json`) — the TS client must pass them. The model-facing schema differs from V2-08 §8.1 (grammar size) but the HTTP response contract is unchanged.
- **Web (1.6):** pages live under the `src/app/(app)/` route group. Session-level guards in `src/server/web/guard.ts`; shared UI copy in `src/shared/copy.ts`; `src/shared/{week,safe-url,schedule-prefs,persona-prefs,action-result}.ts` exist. Each `/setup` section component renders its own section (owners edit only their component). CSP is static with `form-action 'self'` (Google connect = GET `<a>`). Bricolage font now actually renders.
- **Minor (not fixed):** 003's `aria-retention-enqueue` cron omits `max_attempts` (retention rows get 5 attempts, not 3). Harmless.

## Wave 2 hand-off notes

- **Gate result:** build, tsc, lint green; unit 1417/1417; smoke 85/85 (local stack); parser 187/187. `@/server/_stub` importers: 54. `tests/unit/contracts/registry.test.ts` now polices only files that still import `_stub` (it auto-skips implemented ones).
- **Session paused here at Daniel's request** (save progress after Wave 2). Resume with Wave 3.
- **Delivery (2.1):** non-proactive bubble idempotency keys are `d:<userId>:<dedupeKey>:<i>`. `deferMode:"return"` yields `deferred` only for real guard deferrals; bundling / the 30s live-conversation wait still return `queued`. Commands apply state in the webhook and confirm in `after()`. A tapback on an Aria message is stored and kicks a debounced turn. `devRouteEnabled`/`respondToWebhook` live in `pipeline/ingest.ts`. `deliver` `reason` is any string ≤64 chars (e.g. `google_revoked`).
- **For 3.1 (turn handler):** the `conversation_turn` kind is still a stub → kicked turns dead-letter until 3.1. It must handle reaction-only turns (no new messages). Use `kickJob`/`drainUserTurn`, `withHeartbeat`, `closeWithoutAgent`, and the fakes in `tests/helpers/memory-store.ts`.
- **Memory/context (2.2):** static prompt = 8,058 tokens system + tools = 22,603 tokens (Haiku count_tokens), byte-stable (tested). 24 few-shots validated against real tool schemas. Summary tag is `<aria_summary>`. Extra exports for 3.2/3.3: `saveExplicitPreference`, `retirePreferences`, `expireStaleQuestions`, `insertFact`/`updateFact`/`deleteFacts`, `askedInCurrentConversation`; `BuiltContext` has `ack`, `needsSummary`, `PreflightSignals`. **Change request for the agent layer:** `estimateTokens` (chars/3, 1.3's `agent/context/budget.ts`) undercounts ~30% — switch to ~chars/2.3 (3.2 may make this one-line change; record it).
- **Timeline (2.3):** for 3.3's `get_agenda`, pass `timezone: ctx.timezone` and `ref: v => ctx.aliases.mint("t", v.id)` to `renderTimelineForModel`. Explicit date ranges have inclusive `to`; weeks start Monday. Enqueue retries 3× then logs (write already committed). Status subscribers fire only on real status changes.
- **Google core (2.4):** extra exports for 3.6: `beginGoogleOAuth`, `checkGoogleCallback`, `clearedOAuthCookie`, `OAUTH_COOKIE_NAME`. **3.6's callback must enqueue `google_post_connect` itself.** `markGoogleUnavailable(…, {expectEncRefreshToken})`. [verify] PKCE for web clients (`GOOGLE_PKCE=off` fallback), admin-block error shape, refresh token on `prompt=consent`.
- **Gmail (2.5):** route logic in `gmail/push.ts#handleGmailPush`. `startGmailWatch` already schedules renew + periodic sync — **3.6 just calls it**. `stopGmailWatch` clears the cursor and cancels Gmail jobs. **4.3's `alertHighImportance` must NOT filter on `source='push'`** — ingest already passes only eligible items. `sendRaw` guard is a source-scan test in `tests/unit/google/mime.test.ts`; suggested eslint `no-restricted-imports` rule is in the 2.5 report (orchestrator may add at the Wave 4 gate). Change request for 2.4's `completeConnect`: null `gmail_history_id` when the account email changes (fold into 3.6 or a gate fix).
- **Reminders (2.6):** `fireReminder` returns `FireResult`. Extra exports: `resolveWhen`, `armReminder`, `reminderJobKey`, `loadUserSchedule`, `NotificationSettingsError`, `normalizeNudgeMinutes`, `briefingPrepKey`. `onUserScheduleSettingsChanged` always calls `rebaseTimeline` (idempotent). Auto nudges only for non-all-day assignments/exams. V2-06 smoke step 3's alert half waits for 4.1 (`handleTimelineChanges`).
- **Env note:** `.env.local`'s `APP_ENCRYPTION_KEY` is valid (32 bytes); smoke failures about `parseKey` come from Jest not loading `.env.local`.
