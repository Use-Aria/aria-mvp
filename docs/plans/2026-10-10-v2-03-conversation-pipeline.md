# V2-03: Sendblue webhook, per-user conversation pipeline, and jobs infrastructure

> **Status:** Plan only. Nothing here has been built yet.
> **Date:** 2026-10-10
> **Binding inputs:**
> - `docs/plans/2026-10-10-v2-build-brief.md` (shared contracts)
> - `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md`: §3.2, §3.3, §3.5, §3.11, §3.12, §3.15, §3.22, §4.4, §4.5, §5
> - `docs/plans/2026-10-09-aria-v2-free-testing-plan.md`
> - `supabase/migrations/001_v2_baseline.sql` and `002_jobs_extensions.sql`
>
> **Who owns what:** V2-03 owns `src/server/channels/`, `src/server/pipeline/`, `src/server/jobs/` (other branches add only kind files and registry lines), `src/shared/tz.ts`, and the routes listed in §7.
>
> **Marking convention:** Anything not confirmed from a primary source is marked **[verify]**.

---

## 1. Scope and spec references

### In scope

| # | Deliverable | Spec |
|---|---|---|
| 1 | `ChannelProvider` interface, plus two adapters:<br>• **Sendblue:** text, typing, tapbacks, inline reply-to, media, vCard, webhook parse and verify<br>• **dev:** works with no credentials | §3.3, §4.12 |
| 2 | `ReplyPlan` type, validator, and renderer. The renderer emits reactions, then typing, then a pause proportional to length (0.8–4s), then each bubble. On SMS/RCS it degrades. | §3.11, §3.12, §3.5 |
| 3 | `deliver(userId, plan, opts)` with these guards:<br>• per-channel opt-out and pause<br>• quiet hours<br>• proactive cap of 3/day, with urgent messages on top<br>• 10-minute bundling<br>• Sendblue 24h-window and follow-up quota<br>Suppressed proactive messages are **deferred, not dropped**. | §3.14, §3.15, §3.22 |
| 4 | **Identity.** An inbound handle maps to `channels`, which maps to `users`. An unexpired signup is matched by phone so Aria greets the user by name and timezone; with no match, onboarding happens in chat.<br>**Commands.** Opt-out, resume, help, and pause are handled deterministically, per channel, before the agent sees the message. | §3.2, §3.22 |
| 5 | **Webhook** `/api/channels/sendblue`:<br>• verify, then do an idempotent insert<br>• record inbound tapbacks if Sendblue sends them<br>• start typing<br>• debounce<br>• return in under 1s | §4.5 |
| 6 | **Pipeline:**<br>• debounce plus a per-user run lease (Upstash, with a DB fallback)<br>• a `conversation_turn` job<br>• the agent boundary `runAgentTurn` (signature defined here; V2-04 implements it)<br>• deliver, then a mid-run re-check that loops once<br>• an 8s watchdog that sends one interim bubble | §3.11, §3.12, §4.5 |
| 7 | **Jobs infrastructure:**<br>• `enqueueJob` and the kinds registry<br>• a claim SQL function using `SKIP LOCKED`<br>• `/api/jobs/dispatch` with HMAC auth<br>• retries, backoff, and dead-letter<br>• recovery of expired locks<br>• a pg_cron tick every 15s that fires only when work is due<br>• a daily retention purge | §4.4 |
| 8 | **Dev loop:**<br>• `scripts/dev-chat.ts` REPL<br>• `/api/channels/dev` route<br>• `scripts/dev-tick.ts`<br>• a DB smoke script | free-testing plan F2 |

### Out of scope

These belong to other branches:
- the agent loop, prompts, and memory (V2-04)
- reminder and briefing *producers* (V2-06; they call `deliver` and `enqueueJob`)
- Canvas and Google producers (V2-05, V2-07)
- syllabus parsing of inbound PDFs (V2-08 reads `messages.media`)

---

## 2. Analysis: options, choices, and risks

### 2.1 Where debounce state lives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| A. **Postgres `jobs` row is the debounce.** Each inbound upserts a `conversation_turn` job with `dedupe_key = turn:<userId>` in `debounce` mode, which pushes `run_at` to `now()+2.5s`, capped at 8s after the first pending enqueue. The webhook's `after()` sleeps until that `run_at`, using the DB clock, and then tries to claim *that job id*. Only the last inbound's sleeper finds it due. | One source of truth, and durable: if the function dies, the 15s tick picks the job up. No clock skew, because both `run_at` and `db_now` come from Postgres. Strongly consistent. | Two extra RPCs per inbound (enqueue, claim). | ✅ **Choice** |
| B. Upstash key `dbx:<userId>` holds the latest inbound id with PX; the sleeper compares on wake. | Fast. | Still needs a durable job as a crash backstop, so there are two mechanisms. Upstash is **eventually consistent** for reads across invocations (strong mode is deprecated), so a stale `GET` could make two sleepers both think they're last, or neither. | ❌ |
| C. Rely only on the 15s pg_cron tick. | Simple. | Adds 0–15s of latency on every turn, which breaks the p95 under ~12s target. | ❌ (it's only the backstop) |

**Proposed deviation from the brief.** The brief says "Upstash for the debounce window". This plan uses Upstash for the **run lease** (and the existing rate limits) but keeps **debounce in the `jobs` row** (option A), for the reasons above. If the orchestrator insists on Redis debounce, only `pipeline/ingest.ts` changes.

### 2.2 Per-user run lease

| Option | Verdict |
|---|---|
| **Upstash `SET lease:<userId> <token> NX PX 60000`**, with a heartbeat every 20s (Lua: compare-and-`PEXPIRE`) and release by Lua compare-and-`DEL`. | ✅ **Choice** (decided in the brief). `SET NX` and Lua run atomically on the primary, so mutual exclusion doesn't depend on read consistency. |
| DB lease (`user_runtime.lease_until` + `lease_owner`, acquired with `acquire_user_lease` RPC) | ✅ **Local and dev fallback.** It's selected statically, when `UPSTASH_REDIS_REST_URL` is absent and we're not in production. **Never mix the two stores at runtime.** If Redis errors in production, treat it as "lease not acquired" and reschedule the job +3s (fail closed). |

Supporting decisions:

- **The token is a random UUID per run.** Release and extend only succeed for the owner, so a run whose lease expired can't release a newer run's lease.
- **Heartbeat.** The lease TTL is 60s and the heartbeat runs every 20s. A run that crashes frees the user within ≤60s.
- **Hard run deadline** is invocation start + 270s, under Hobby's 300s `maxDuration`. The agent's `AbortSignal` fires at deadline − 30s.
- **Orphan recovery without a global sweeper.** Runs only execute while holding the lease. So right after acquiring it, any `agent_runs` row for this user still `status='running'` is an orphan from a crashed invocation.
  - If it produced **no** outbound rows (`messages.run_id`): un-consume its inbound (`consumed_by_run = null`) and mark it `failed`.
  - If it already sent something: mark it `failed` and **don't** replay. A partial reply beats a double-send.

### 2.3 How a turn gets executed (latency path)

1. The webhook (Node runtime, `maxDuration = 300`) verifies, ingests, and enqueues (debounce), then returns 200 in about 150ms.
2. In `after()`:
   - Send typing `start` (`max_duration_ms` 120000).
   - Sleep `job_run_at − db_now + 50ms`.
   - `claim_jobs(p_job_id = <id>)`. If nothing comes back, a newer inbound or the tick took it, so exit.
   - Otherwise run the handler inline in this same invocation.
3. **Backstop:** if the invocation dies, the job's lock (330s) expires, `jobs_tick` sees a due or expired row, `/api/jobs/dispatch` reclaims it, and the handler recovers the orphan run (§2.2).
4. **Lease held** (a run is already active for this user): reschedule +3s without consuming an attempt.
   - The active run drains at the end: after releasing, it claims any due `turn:<userId>` job inline (`claim_jobs(p_dedupe_key)`). That way messages arriving at the tail end of a run don't wait for the 15s tick.

Latency budget (Sendblue's auto-typing makes "…" appear instantly):

| Step | Time |
|---|---|
| Debounce | 2.5s |
| Ingest and claim | ~0.2s |
| Agent (Haiku 5.5, 1–2 tool iterations) | ~3–8s **[verify in bake-off]** |
| First bubble's pause | ≥0.8s |
| **Expected p50 / p95** | **~7–8s / ~12s** |

### 2.4 Mid-run messages and out-of-order bursts

- **Consume.** `consume` is a single `UPDATE … SET consumed_by_run = $run WHERE user_id = $u AND direction = 'in' AND consumed_by_run IS NULL RETURNING *`. It's atomic, and the lease guarantees a single consumer. Rows are sorted by `created_at`.
- **Inbound `created_at` = provider `date_sent`**, clamped to `[now − 10 min, now + 1 min]`. This orders out-of-order webhook deliveries (Sendblue retries, attachment parts arriving as separate webhooks) by when the user actually sent them.
- **After delivering pass 1,** re-consume. If new rows arrived, run the agent once more with `isFollowUpPass: true` (spec: "loop once"). Anything after that is left for the pending job, which the drain handles.
- **Duplicates.**
  - `unique (provider, provider_message_id)` makes a Sendblue retry (up to 3× on 5xx, or after a 45s timeout) a no-op.
  - A duplicate doesn't re-enqueue, so it can't push the debounce.

### 2.5 Double-send prevention (the Phase-1 exit gate "no duplicate sends")

| Threat | Guard |
|---|---|
| Duplicate webhook | Unique `(provider, provider_message_id)`; the duplicate returns 200 with no side effects |
| Two runs for one user | Lease |
| Job reclaimed while the original still runs | Lock 330s > invocation max 300s, so it can't happen while alive. A reclaim after a kill hits orphan recovery. |
| Retry after a partial send | Every outbound bubble row is inserted **before** sending, with `idempotency_key` = `<runId>:<i>` (reply), `<jobId>:<i>` (outbox flush), `welcome:<channelId>:<i>`, and so on. A conflict means it was already attempted, so skip it. This is at-most-once. |
| Ambiguous provider failure (timeout after the request left) | **No automatic resend** of `send-message`. Retry only on 429/503 or a connection error *before* the request was written. Typing and reactions are best-effort, with one retry. |
| A producer (reminder or briefing job) retried after `deliver` already queued its item | `proactive_dedupe(user_id, dedupe_key)` is claimed at flush (`insert … on conflict do nothing`), and `deliver` skips items whose key already exists |

### 2.6 Guards (`deliver`)

The **delivery class** comes from `opts.proactive` plus an optional `opts.priority`. This is an additive extension to the brief's contract.

| Class | Opt-out | Pause | Quiet hours | Daily cap (3) | 10-min bundling | Follow-up quota |
|---|---|---|---|---|---|---|
| Reply (`proactive: false`) | **drop** | — | — | — | — | — (in-window by definition) |
| `routine` (briefing, FYI alert) | **drop** | defer | defer | defer to next local day | yes | defer 1h |
| `urgent` (deadline moved ≤7d, important email) | **drop** | defer | defer **[open Q 3]** | not counted | flush now | defer 1h |
| `requested` (user-set reminder) | **drop** | defer | bypass (the user asked for that time) | not counted | flush now | defer 1h |

- **Opt-out drops** rather than defers. It's the one legally required drop: CTIA/TCPA allow no further messages after STOP except the one confirmation.
- **Expired items.** A producer may set `expiresAt` (for example, a briefing for one day only). An item past its expiry is dropped as `expired` and logged.
- **Quiet hours** are per user: `users.quiet_start` / `quiet_end`, default 22:00–08:00 local, DST-safe via `src/shared/tz.ts`.
  - On SMS/RCS channels, the effective window is widened to at least 21:00–08:00. §3.22 says "quiet hours 8am–9pm minimum" once SMS brings TCPA into scope.
  - The deferred `run_at` is quiet-end plus 0–5 minutes of jitter.
- **Daily cap.** `count(distinct delivery_id)` over outbound rows with `proactive_class = 'routine'` since local midnight. Urgent and requested messages are "+ urgent" and don't count.
- **Bundling via a per-user outbox.** `deliver(proactive)` appends the item to one pending `proactive_flush` job (`dedupe_key = outbox:<userId>`, `append` mode).
  - Its `run_at` is: routine → `max(now + 30s, lastProactiveSentAt + 10min)`; urgent or requested → `now`.
  - The flush re-checks every guard at send time. It merges items (≤3 bubbles: if there are more, join texts into the last bubble; the first link wins) and sends.
  - If a conversation run holds the lease, the flush defers 30s so a briefing never interleaves with a live reply.
- **Sendblue follow-up quota** (AI Agent plan: 200 contacts per line per rolling 24h outside the window).
  - A proactive send to a channel with `last_inbound_at < now − 24h` is flagged `outside_window`.
  - The flush counts distinct `user_id` with `outside_window` sends on this line in the last 24h. At or above **180** (a safety margin), it defers 1h.
  - At 4 users this never fires, but the guard and its test exist so it holds at scale.

### 2.7 Identity and onboarding

- **One RPC** `ingest_inbound_message` (§4) runs in one transaction under `pg_advisory_xact_lock(hash(kind:handle))`. That serializes a burst of 3 bubbles from a brand-new handle, so we get exactly one user and one channel. It:
  1. finds or creates the channel and user
  2. matches an unexpired `signups.phone_e164 = handle` when the user has no name, and copies name and timezone (`timezone_source = 'signup'`)
  3. sets `signups.matched_user_id`
  4. writes a `consents` row (`source = 'signup'`, the signup's `consent_version`)
  5. resolves `reply_to` (provider handle to our `messages.id`)
  6. inserts the message idempotently
  7. touches `last_inbound_at` and `last_service`
  8. mirrors Sendblue's `opted_out = true`
- **Channel modelling decision.** Every Sendblue handle is `channels.kind = 'imessage'` (it's the Sendblue thread). The actual transport for each message goes in the new `channels.last_service` (`imessage | sms | rcs`) and `messages.service`.
  - Otherwise an iPhone user who briefly falls back to SMS would create a second `(kind='sms', handle)` row, and with it a second user.
  - `kind = 'sms'` stays reserved for a future non-Sendblue SMS provider.
- **First contact** happens in the turn, not the webhook. When the channel has no outbound rows yet:
  - Send a deterministic welcome, idempotency key `welcome:<channelId>:<i>`. It carries the AI disclosure required by §3.22 and asks for the name when it's unknown. Then send the vCard (`/aria.vcf`) as its own media bubble.
  - If the user's first text was only a greeting (`/^(hey|hi|hello|yo|sup|hii+)\b[^?]{0,20}$/i`), stop there. Otherwise run the agent too, with `identity.isNewUser = true` so it doesn't re-introduce itself.
- **Timezone.** It comes from the signup if there was one. Otherwise `America/New_York` with `timezone_source = 'default'`; the agent sees that and asks once ("you on east coast time?"), then records the answer with the `set_identity` tool (§9).
- **Apple ID email handles.**
  - Sendblue "can receive inbound messages from iCloud email addresses … cannot be associated with a phone number" (FAQ).
  - Which payload field carries the email is **[verify]**. The parser takes `from_number ?? number` through `normalizeHandle`.
  - Email handles never match signups, so they always get in-chat onboarding.
  - Typing and reactions on email handles are **[verify]**; failures there are best-effort and tolerated.

### 2.8 Deterministic commands (before the agent, per channel)

`detectCommand(text)` (pure) normalizes the text: lowercase, NFKC, strip surrounding punctuation and emoji, collapse whitespace. Then it matches the **whole message**:

| Command | Matches | Effect |
|---|---|---|
| `opt_out` | Sendblue's built-in set (`stop`, `unsubscribe`, `cancel`, `opt out`, `revoke`, `end`, `quit`), plus `stop all`, `stopall`, `optout`, `leave me alone`, `stop texting me`, `stop messaging me`, `dont text me`, `don't text me`, `no more texts`, and `(please )?(stop|quit) (texting|messaging|contacting) me( please)?` | `channels.opted_out_at = now()`, a `consents` row (granted false, `source = 'keyword'`), one confirmation sent with guards bypassed ("ok, I'll stop texting you. text START anytime to turn me back on."). Sendblue may already have opted the contact out and may decline or replace our confirmation **[verify]**; that's fine. |
| `opt_in` | `start`, `unstop`, `resume`, `unpause` | Clear `opted_out_at` and `paused_until`, write a consent row, confirm |
| `help` | `help`, `info` | Fixed help text: what Aria is, STOP and START, the `/settings` link later |
| `pause` | `pause`, `mute`, `snooze`, `quiet`, optionally followed by `for N (hours\|days)`, `till/until tomorrow`, `for today` | `channels.paused_until` is set (default 24h; "today" means local midnight). Proactive messages only. |

**Not commands:** "stop reminding me about cpsc" and "end of the week?" These don't match the whole message, so they go to the agent. The agent also has `pause_messages` (§9) for softer phrasings.

**While opted out:** inbound messages are stored but get **no reply and no agent run**, except `opt_in`. Sendblue's own START keyword re-enables at their end; if a user opted out with a phrase Sendblue doesn't know, only our flag is set.

### 2.9 Watchdog and interim bubble

- **Trigger:** 8s after the run starts with no bubble sent. Exactly one interim per run.
- **Text:** from `channels/interim.ts`, which picks from two pools (casual or neutral) by a simple register heuristic over the user's last texts: share of lowercase, emoji, slang tokens. Examples: "one sec 👀", "ok lemme check", "give me a sec".
- **Cap:** the interim counts toward the 3-bubble cap, so the plan is cut to 2 (the 3rd is merged into the 2nd).
- **No double interim:** the agent's `send_interim` tool is a no-op if the watchdog already fired, and vice versa.

### 2.10 Renderer

`renderPlan(plan, caps, {elapsedMs})` turns a `ReplyPlan` into `RenderStep[]`. It's pure.

1. **Reactions first,** immediately (a tapback reads as "seen").
2. **Then for each bubble:** typing, then a pause of `clamp(len / 35 * 1000, 800, 4000)` ms, then send. Typing is skipped if the capability is missing.
   - First bubble: the pause is `max(800, computed − elapsedMs)`, because the LLM latency was already "typing" time.
3. **Then the link** (if not already inside a bubble) as its own bubble, counted in the cap.
4. **Media** (`media[]`) goes as separate sends, outside the cap. Only the vCard and our own files are allowed.
5. **Degradation** when there are no reactions, or no inline replies (SMS/RCS):
   - Reactions are dropped, unless the reaction has `fallbackText`; that text is sent as a bubble.
   - `replyTo` is dropped. When the plan answers **more than one** distinct target, the bubble gets a prefix: `“<first 24 chars of target>…” → `.
6. **Empty plan** (no reactions and no bubbles): send typing `stop` only.

**Executor:** `executeSteps(steps, io)` runs with an injected `sleep` and `now`, so tests use fake time.
- If a reaction send returns `unsupported_on_this_line` (422), it disables reactions for this provider instance and logs once.
- If an inline reply is rejected (400), the text is resent once without `reply_to`.

### 2.11 Jobs infrastructure

| Piece | Choice and why |
|---|---|
| **Enqueue** | One RPC `enqueue_job(kind, user_id, run_at, payload, dedupe_key, mode, max_delay_ms, max_attempts)`. supabase-js can't target the **partial** unique index (`on conflict (dedupe_key) where status = 'pending' …`), so this has to be SQL. Modes:<br>• `replace` (default with a dedupe key): latest wins, `run_at` may move earlier, which suits reminders whose due date moved<br>• `keep`: idempotent<br>• `debounce`: `run_at = least(greatest(old, new), created_at + max_delay)`<br>• `append`: `payload.items` concatenated, `run_at = least(old, new)`<br>Returns `job_id, job_run_at, db_now, created`. |
| **Claim** | `claim_jobs(token, kinds[], limit, lock_seconds, job_id?, dedupe_key?)`. It runs `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)` over `(pending and run_at <= now()) or (running and locked_until < now())`.<br>• Expired locks are reclaimed **by the claim itself**, so there's no separate sweeper job.<br>• It increments `attempts`, sets `locked_by`, `locked_until`, `started_at`.<br>• It first dead-letters expired rows that have used up their attempts.<br>• It filters by `kinds[]` = the registry keys of the running deploy. A newer kind never gets run by old code, and smoke-test kinds are never claimed by production. |
| **Finish** | `finish_job(id, token, outcome, run_at, error)`. Outcomes are `done`, `retry`, `reschedule` (gives the attempt back), and `dead`.<br>• Only the claim-token owner can finish; anyone else gets `'lost'`.<br>• Turning a row back to `pending` can collide with a newer pending row on the same `dedupe_key`. On that `unique_violation`, the old row becomes `done` with `superseded`, because the newer job already covers it. |
| **Backoff** | `min(15s × 2^(attempt − 1), 1h)` ± 20% jitter. `max_attempts` defaults to 5 and is set per kind at enqueue. After that the row is `dead`: kept 30 days, logged with `console.error` (Sentry once configured). |
| **Handler contract** | A handler returns `JobOutcome` or void (meaning done). A **throw** means retry with backoff. Payload is parsed with zod at enqueue (fail fast) and again at run; an invalid payload goes straight to `dead`. |
| **Dispatch** | `POST /api/jobs/dispatch` (and `GET` for Vercel Cron):<br>• verify the HMAC<br>• respond `202` immediately (pg_net's timeout is short)<br>• in `after()`: `runDueJobs({budgetMs: 270_000, concurrency: 4})` claims up to the number of free slots and keeps claiming while slots free, until claims come back empty or <60s of budget is left |
| **Tick** | pg_cron `aria-jobs-tick` every `'15 seconds'` runs `private.jobs_tick()`. It POSTs only when due or expired-lock rows exist. The URL and secret come from **Vault** (`aria_dispatch_url`, `aria_dispatch_secret`); if either is missing it's a **no-op**. So the schedule can ship in the migration before the URL is known, and a runbook SQL sets the secrets after deploy (§11 T9). |
| **HMAC** | Signs `"v1." + ts` (epoch seconds) only. Headers: `x-aria-ts`, `x-aria-sig` = hex HMAC-SHA256 via pgcrypto. The route accepts \|now − ts\| ≤ 60s and compares in constant time. The body is ignored.<br>Why not sign the body: it carries nothing actionable, and this rules out any jsonb-serialization mismatch. A replay inside 60s only causes an extra claim attempt, which is idempotent.<br>Why HMAC rather than a raw bearer secret: pg_net keeps request rows (headers included) in its queue table, so a leaked row is worth at most 60s of replay. |
| **Daily backstop and keep-alive** | `vercel.json` cron at `0 12 * * *` sends a `GET` to `/api/jobs/dispatch` with `Authorization: Bearer $CRON_SECRET` (Vercel convention; Hobby allows daily crons). It catches anything pg_cron or pg_net missed. It also generates real daily API traffic against Supabase Free, which pauses after 7 days "without sufficient user database activity". Whether pg_cron alone counts is **[verify]**. |
| **Retention** | pg_cron `aria-retention-enqueue` at `17 8 * * *` UTC enqueues `retention_purge` (`keep` mode). The handler deletes:<br>• `messages` older than 180 days, in batches of 5k via `purge_messages_before` (reactions cascade)<br>• `done` and `dead` jobs older than 30 days<br>• `agent_runs` older than 180 days<br>• expired `magic_links` and `web_sessions` older than 7 days<br>• unmatched or expired `signups` older than 7 days (phone and IP are PII)<br>• `proactive_dedupe` rows older than 30 days<br>It stops at 240s and re-enqueues itself if there's more. A separate pg_cron job purges `cron.job_run_details` older than 2 days (the 15s tick writes 5,760 rows a day and nothing cleans them up automatically). |
| **Vercel limits** | Hobby: `maxDuration` default **and** max are 300s; 2 GB / 1 vCPU; 4 CPU-hrs, 360 GB-hrs, and 1M invocations a month; 4.5 MB body; crons once a day. Routes set `export const maxDuration = 300`. All jobs are bounded by the invocation, which is why `lock_seconds` is 330. Long work (V2-07 triage) must chain chunk jobs of ≤ ~240s. |

### 2.12 Security summary

- **Sendblue webhook.** The `sb-signing-secret` header carries a *static shared secret*. There is no HMAC and no timestamp (Sendblue Security doc), so we compare it in constant time (`safeEqual`).
  - **Rotation:** `SENDBLUE_SIGNING_SECRET` holds a comma-separated list.
  - **Replay** is harmless because the insert is idempotent on `message_handle`.
  - Missing or wrong secret → 401 and no DB access.
  - JSON is parsed only after verifying, from the raw `req.text()`.
- **Dispatch.** HMAC plus a timestamp window (above). `CRON_SECRET` bearer is accepted only on `GET`.
- **Dev route `/api/channels/dev`.** Returns 404 when `isProduction`. It also requires `x-dev-secret = DEV_CHANNEL_SECRET`. `getProvider()` throws if `CHANNEL_PROVIDER = dev` in production.
- **SQL functions.** All are `security definer set search_path = ''`.
  - Supabase grants execute on `public` functions to `anon` and `authenticated` by default, so each new function gets `revoke execute … from public, anon, authenticated` plus `grant execute … to service_role`.
  - The tick lives in schema `private`, which PostgREST doesn't expose.
- **Logs:** handles only through `maskHandle`; never bodies, tokens, or secrets.
- **Abuse and cost.**
  - Upstash `rateLimit('inbound:<channelId>', 30, 60)`: over the limit, the message is stored but no turn is kicked; the next allowed inbound picks up the backlog.
  - A daily turn cap per user (200) ends with a single "I need a breather, back tomorrow" bubble.
- **Link and media allowlist.** Outbound links only to `appOrigin()` or `https://mail.google.com/` (§3.22). Media only from `appOrigin()`.

### 2.13 Cost (free test: 4 users, ~30 turns a day each)

| Item | Monthly use | Free allowance | Cost |
|---|---|---|---|
| Upstash commands (~6 per turn: lease, heartbeats, release, rate limit) | ~22k | 500k | $0 |
| Vercel invocations (webhooks ~5k, dispatch ticks only when due ~3k, flushes) | ~10k | 1M | $0 |
| Vercel provisioned memory (~20s wall per turn × 2 GB × 3.6k turns) | ~40 GB-hrs | 360 | $0 |
| Supabase (rows, pg_cron, pg_net) | tiny | Free plan | $0 |
| Sendblue sandbox | ≤10 contacts | free | $0 |

**Recommendation:** don't subscribe to Sendblue's `outbound` status webhook for now. Every bubble would trigger several status POSTs, and declines already come back synchronously as HTTP 400 with `error_key`. Opt-outs also arrive on inbound as `opted_out`.

### 2.14 Failure-mode table

| Failure | Behaviour |
|---|---|
| Duplicate webhook | No-op (unique index) |
| Webhook DB error before the insert | 500, and Sendblue retries (up to 3×) |
| Function killed during debounce sleep | The job is still pending; the tick runs it within ≤15s |
| Function killed mid-run | The lease expires in ≤60s and the job lock in 330s. The tick reclaims the job, and the handler recovers the orphan run: un-consume if nothing was sent, otherwise give up silently. |
| Lease expires while the run is alive (heartbeat failed) | The heartbeat failure aborts the run's `AbortSignal`, so no further sends. Bubble idempotency keys stop duplicates if a second run starts. |
| Clock skew | All schedule decisions use Postgres `now()`. The Redis PX is relative. Dispatch's ±60s window tolerates NTP drift. |
| Agent throws | Un-consume, then `retry` (`conversation_turn` max_attempts is 3). On the last attempt, send one fallback bubble ("ugh my brain glitched 😵 say that again?") and mark the messages consumed. |
| Sendblue 5xx or timeout on send | The row is marked `failed` with no resend. The next user message proceeds normally. |
| Sendblue 400 `DECLINED` with `error_key = OPTED_OUT` | Mirror it into `channels.opted_out_at` |
| pg_cron or pg_net down | The webhook fast path still serves conversations. Scheduled work is late until the daily Vercel cron backstop. |
| Supabase Free paused | Everything stops. The daily Vercel cron hit keeps it awake. Upgrading to Pro is the production fix. |
| Unknown job kind (claimed by nothing) | The dispatcher dead-letters pending rows of unregistered kinds older than 1h, so the tick doesn't fire forever. |

---

## 3. External API facts (fetched 2026-10-10)

### Sendblue

All URLs are under docs.sendblue.com.

**Authentication**
- Headers: `sb-api-key-id` and `sb-api-secret-key`. `x-` prefixed variants are also accepted. Calls from a browser frontend are blocked. Sources: `/getting-started/credentials`, `/security`.
- Base URL: `https://api.sendblue.com`. The official TS SDK defaults to `https://api.sendblue.co` **[verify which is canonical]**. We use an env override (`SENDBLUE_API_BASE`).

**Sending messages** (`/getting-started/sending-messages`)
- **Endpoint:** `POST /api/send-message` with body `{number, from_number, content?, media_url?, send_style?, status_callback?, reply_to?: {message_handle}, pre_reply_override?}`. `from_number` is required, and the first one used for a contact must be reused for every later message to them.
- **Message limits:** messages must be shorter than 18,996 characters.
- **Status values:** `REGISTERED`, `PENDING`, `DECLINED`, `QUEUED`, `ACCEPTED`, `SENT`, `DELIVERED`, `ERROR`. `DECLINED` returns HTTP 400 with `error_key` (for example `OPTED_OUT` or `PRE_REPLY_LIMIT_REACHED`).
- **SMS fallback:** automatic. It shows up as `service: "SMS"` and `was_downgraded: true`.
- **Response body:** the exact shape of the send response is **[verify]**. It's assumed to include `message_handle` and `status`.

**Inline replies** (`/guides/inline-replies`)
- Require a **V2 line** and iMessage.
- A rejected reply is **not** sent standalone and **not** downgraded; the API returns 400.
- The inbound webhook carries `reply_to.message_handle` and `thread_originator.message_handle`.

**Typing indicators** (`/api-v2/typing-indicators`, `/guides/typing-indicator`)
- **Endpoint:** `POST /api/send-typing-indicator` with `{number, from_number?, state: "start"|"stop", max_duration_ms (1–300000, default 60000)}`.
- **Limits:** iMessage only, 1:1 only. It needs an existing conversation, otherwise 400 "No route mapping". It's best-effort: "you will still see a 'SENT' status, but the typing indicator will not be delivered".
- **Old firmware:** a `stop` or explicit duration may return 503; retry later.
- **Auto typing:** `POST /accounts/settings/auto-typing-indicator {auto_typing_indicator: true}`, available on the Free and AI Agent plans, fires on every inbound 1:1 iMessage.
- **Typing webhook:** payload `{number, is_typing, from_number, timestamp}`.

**Reactions** (`/api-v2/reactions`)
- **Endpoint:** `POST /api/send-reaction` with `{from_number, message_handle, reaction, part_index?}`.
- **Values:**
  - `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`
  - or exactly one emoji, in emoji-picker form (`❤` is rejected)
  - prefix `-` to remove a reaction
- **Errors:**
  - 422 `unsupported_target` for SMS/RCS, outbound messages, or attachment-specific handles
  - 422 `unsupported_on_this_line`
  - 404 for an unknown handle
- **Age limit:** only messages from "the last few days" can be reacted to.

**Inbound reactions**
- **Not documented** anywhere: not on the webhooks page, the reactions page, or the Chat SDK adapter page, which lists "Tapback reactions: Add reactions only".
- **[verify in sandbox]:** whether inbound tapbacks arrive at all, and in what shape. One possibility is a `receive` event whose text is the legacy form `Loved “…”`.

**Media** (`/api-v2/media`, sending-messages)
- **Outbound:** `media_url` must be a public URL ending in the right extension, with no signed URLs. Sizes: iMessage 20 MB recommended / 100 MB max; SMS 5 MB.
- **Upload endpoints:** `POST /api/upload-file` (multipart) and `/api/upload-media-object`.
- **Inbound:** the `media_url` CDN link "expires after 30 days for inbound". Each attachment can come as its own inbound webhook with its own handle.

**Contact card** (`/guides/contact-card`)
- Sent through send-message with `media_url` pointing at a public `.vcf` or `.vcard` URL.
- The guide says it makes links expand and "drastically increases your messaging rate limits".
- Name & Photo sharing is a separate feature: `POST /api/v2/contact-sharing/profile` and `/share` (`/api-v2/contact-sharing`).

**Read receipts** (`/api-v2/read-receipts`)
- `POST /api/mark-read {number, from_number}`.
- An auto mark-read account setting exists on the Free and AI Agent plans.

**Webhooks** (`/getting-started/webhooks`)
- **Types:** `receive`, `outbound`, `typing_indicator`, `call_log`, `inbound_call`, `line_blocked`, `line_assigned`, `contact_profile`, `contact_created`.
- **Configuration:** account-level only, the same endpoints for every line. Managed at `GET`/`POST`/`PUT`/`DELETE /api/account/webhooks`, each with a per-webhook `secret` or a `globalSecret`.
- **Receive payload fields:** `accountEmail`, `content`, `is_outbound`, `status` (`"RECEIVED"`), `message_handle`, `date_sent`, `date_updated`, `from_number`, `number`, `to_number`, `was_downgraded`, `plan`, `media_url`, `message_type`, `group_id`, `participants`, `send_style`, `opted_out`, `sendblue_number`, `service` (`"iMessage"` / `"SMS"` / `"RCS"`), `group_display_name`, `reply_to?`, `thread_originator?`, `app_card?`, plus the `error_*` fields.
- **Delivery semantics:** "must send a 200-level response". Retries "up to 3 times if your endpoint returns a 5xx". Sendblue "waits 45 seconds". Deliveries may be duplicated, so dedupe on `message_handle`. A 410 removes the webhook.

**Signature**
- "Sendblue sends `sb-signing-secret` header with requests. Verify this matches your configured secret" (`/security`).
- The Chat SDK adapter "verifies the `sb-signing-secret` header by default" (`/guides/chat-sdk-adapter`).
- It is a **static secret, not an HMAC**.

**Opt-out** (`/security`)
- Built-in detection for `stop`, `unsubscribe`, `cancel`, `opt out`, `revoke`, `end`, `quit`; opt-in is `start`.
- Custom phrases can only be added by Sendblue support.

**Limits** (`/limits`)
- **AI Agent plan:**
  - 1,000 inbound contacts per day per line
  - unlimited replies within 24h of the contact's last message
  - **200 contacts per day per line** for first messages after 24h
  - burst of 10 messages per second per line; above that, 429
  - "Follow-up limit of 150 consecutive outbound messages per line without a reply". Per line or per contact is still **[verify]**.
- **Pre-reply limits:** 6 messages, 300 characters, no links or media before a contact's first reply. They don't apply to us, because users always text first.
- **Free shared-line plans:** "A recipient must be verified as a contact … `sendblue add-contact`, then have them text your Sendblue number once".

**iCloud email handles** (`/faq`)
- Supported for inbound; "cannot be associated with a phone number".
- How they appear in `from_number` is **[verify]**.

**Sandbox:** "Create a free sandbox account at dashboard.sendblue.com/company-signup" (`/faq`). The ≤10-contact cap comes from the free-testing plan and is **[verify in dashboard]**.

### Supabase (pg_cron, pg_net, Vault, pgcrypto)

**pg_cron**
- **Sub-minute schedules:** "You can use [1-59] seconds (e.g. `30 seconds`) … on Postgres version 15.1.1.61 or later" (https://supabase.com/docs/guides/cron/quickstart). Seconds can't be combined with other units (https://github.com/citusdata/pg_cron).
- **Version:** Supabase pg_cron is 1.6.4 (https://supabase.com/docs/guides/troubleshooting/pgcron-debugging-guide-n1KTaz).
- **Plan restrictions:** none documented. Free-plan sub-minute is **[verify]**.
- **Concurrency guidance:** "no more than 8 Jobs run concurrently". A second instance of a job is queued while the first is still running.
- **Run history:** `cron.job_run_details` "is never cleaned up automatically". The docs recommend deleting rows where `end_time < now() - interval '7 days'`.
- **Upserts:** calling `cron.schedule` with the same name updates the job (pg_cron source: `on conflict … do update`). `cron.unschedule(name)` errors if the name is missing.

**pg_net**
- **Signature:** `net.http_post(url, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int) returns bigint` (https://github.com/supabase/pg_net).
- **Default timeout:** documented as 2000 on Supabase but 5000 upstream, so **always pass it explicitly**.
- **Timing:** requests start only after the transaction commits.
- **Body bytes:** `convert_to(body::text,'UTF8')`.
- **Responses** sit in `net._http_response` for 6h.
- **No retries.** POST with JSON only. ~200 requests per second (https://supabase.com/docs/guides/database/extensions/pg_net).

**Vault**
- **Functions:** `vault.create_secret(secret, name, description)` and `vault.update_secret(id, secret, …)`. Read through `vault.decrypted_secrets` (https://supabase.com/docs/guides/database/vault).
- **Example pattern:** the scheduled-functions example keeps the URL and key in Vault and reads them inside `cron.schedule` (https://supabase.com/docs/guides/functions/schedule-functions).

**pgcrypto**
- `hmac(data text, key text, type text) returns bytea` (https://www.postgresql.org/docs/current/pgcrypto.html).
- Supabase installs most extensions in `extensions` (https://supabase.com/docs/guides/database/extensions). Whether pgcrypto is preinstalled is **[verify]**, so the delta runs `create extension if not exists`.

**Function permissions:** "By default, any role can run a database function". Use `security definer set search_path = ''` and the revoke pattern (https://supabase.com/docs/guides/database/functions).

**SKIP LOCKED:** "can be used to avoid lock contention with multiple consumers accessing a queue-like table" (https://www.postgresql.org/docs/current/sql-select.html).

**Free-plan pausing:** "inactive if it does not receive sufficient user database activity over the past week" (https://supabase.com/docs/guides/platform/free-project-pausing). Whether pg_cron counts is **[verify]**.

### Vercel / Next.js 16.4

**Hobby plan**
- Default and max duration are both **300s** (https://vercel.com/docs/functions/configuring-functions/duration). Past that, a 504 `FUNCTION_INVOCATION_TIMEOUT` and the function is terminated.
- 2 GB / 1 vCPU; 4.5 MB body (https://vercel.com/docs/functions/limitations).
- Monthly: 4 CPU-hrs, 360 GB-hrs, 1M invocations (https://vercel.com/docs/plans/hobby).
- Crons: "Hobby | 100 cron jobs | Once per day" (https://vercel.com/docs/cron-jobs/usage-and-pricing).
- Fluid Compute is on by default for new projects (https://vercel.com/docs/fluid-compute).

**`after()`**
- Works in Route Handlers and has been stable since 15.1.
- "will run for the platform's default or configured max duration of your route". On Vercel it's implemented with `waitUntil` (https://nextjs.org/docs/app/api-reference/functions/after; bundled at `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`).
- When the invocation is killed at the cap, the callback dies with it, and nothing retries it. Hence the job backstop.

**Route segment config:** `maxDuration` is a route segment option. `runtime` defaults to `nodejs`. Don't export `dynamic` if `cacheComponents` is enabled (route segment config docs, v16.0.0 note).

**Raw body:** read with `await request.text()`, as in the docs' webhook example (https://nextjs.org/docs/app/api-reference/file-conventions/route).

### Upstash Redis (`@upstash/redis` 1.39.0)

- **SET NX PX:** `set(key, val, { nx: true, px })` returns `"OK"` or `null`, matching Redis `SET … NX` (https://upstash.com/docs/redis/sdks/ts/commands/string/set, https://redis.io/docs/latest/commands/set/).
- **Scripts:** `eval` and `evalsha` are supported, and `createScript` tries EVALSHA first, then falls back to EVAL.
- **Lock release:** the canonical script is `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end` (redis.io).
- **Consistency:** "can provide only **Eventual Consistency**"; strong single-region mode is deprecated (https://upstash.com/docs/redis/features/consistency). Correctness therefore relies only on `SET NX` and Lua, never on a plain GET.
- **Serialization:** the SDK serializes values to JSON. Construct the client with `automaticDeserialization: false` and use plain-string tokens **[verify serialization behaviour]**.
- **Free tier:** 500k commands/month, 256 MB, 10 MB per request (https://upstash.com/docs/redis/overall/pricing).

---

## 4. Schema delta (for the orchestrator's `003_v2_build.sql`; not a migration file)

**New table:** `proactive_dedupe`, with RLS enabled.

**Altered tables:**

| Table | New columns |
|---|---|
| `users` | quiet hours, timezone provenance |
| `channels` | `last_service` |
| `messages` | run, delivery, proactive class, idempotency, service, window flag |
| `jobs` | claim token, max attempts, timestamps, status check |
| `user_runtime` | `lease_owner` |

**New functions:** `enqueue_job`, `claim_jobs`, `finish_job`, `acquire_user_lease`, `ingest_inbound_message`, `purge_messages_before`, `private.jobs_tick`.

**New cron jobs:** 3.

```sql
-- ═══ V2-03: conversation pipeline + jobs infra ═══════════════════════
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ── users: quiet hours + where the timezone came from ──────────────
alter table public.users
  add column quiet_start     time not null default '22:00',
  add column quiet_end       time not null default '08:00',
  add column timezone_source text not null default 'default'
    check (timezone_source in ('default','signup','user','inferred'));

-- ── channels: actual transport last seen (renderer degradation) ────
-- All Sendblue handles are kind='imessage' (the Sendblue thread); the
-- per-message transport lives here so an SMS fallback can't fork a user.
alter table public.channels
  add column last_service text check (last_service in ('imessage','sms','rcs'));

-- ── messages: delivery bookkeeping ─────────────────────────────────
alter table public.messages
  add column run_id          uuid references public.agent_runs(id) on delete set null, -- out: run that produced it
  add column delivery_id     uuid,          -- groups bubbles from one deliver() call
  add column proactive_class text check (proactive_class in ('routine','urgent','requested')),
  add column trigger         text,          -- 'reply'|'interim'|'welcome'|'contact_card'|'command'|<proactive reason>
  add column idempotency_key text,          -- '<runId>:<i>', '<jobId>:<i>', 'welcome:<channelId>:<i>'
  add column service         text check (service in ('imessage','sms','rcs')),
  add column outside_window  boolean not null default false; -- proactive sent >24h after last inbound
create unique index messages_idempotency_key_uidx
  on public.messages (idempotency_key) where idempotency_key is not null;
create index messages_unconsumed_idx
  on public.messages (user_id, created_at) where direction = 'in' and consumed_by_run is null;
create index messages_created_at_idx on public.messages (created_at);          -- retention purge
create index messages_proactive_idx
  on public.messages (user_id, created_at) where proactive_class is not null;    -- cap / bundling / quota

-- ── jobs: claim token, per-kind attempts, timestamps ───────────────
alter table public.jobs
  add column locked_by    uuid,
  add column max_attempts int not null default 5,
  add column started_at   timestamptz,
  add column finished_at  timestamptz,
  add constraint jobs_status_chk check (status in ('pending','running','done','dead'));
create index jobs_running_lock_idx on public.jobs (locked_until) where status = 'running';
create index jobs_finished_idx on public.jobs (finished_at) where status in ('done','dead');

-- ── user_runtime: owner token for the DB-fallback lease ────────────
alter table public.user_runtime add column lease_owner uuid;

-- ── proactive_dedupe: at-most-once for producer items (reminders, briefings) ──
create table public.proactive_dedupe (
  user_id      uuid not null references public.users(id) on delete cascade,
  dedupe_key   text not null,
  delivered_at timestamptz not null default now(),
  primary key (user_id, dedupe_key)
);
alter table public.proactive_dedupe enable row level security;

-- ═══ Functions (service_role only) ═══════════════════════════════════

-- enqueue_job: upsert on the PARTIAL unique index (supabase-js can't).
create or replace function public.enqueue_job(
  p_kind text,
  p_user_id uuid default null,
  p_run_at timestamptz default null,
  p_payload jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_mode text default 'replace',          -- keep | replace | debounce | append
  p_max_delay_ms int default null,        -- debounce cap, measured from the pending row's created_at
  p_max_attempts int default 5)
returns table (job_id uuid, job_run_at timestamptz, db_now timestamptz, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_run_at timestamptz := coalesce(p_run_at, now());
begin
  if p_mode not in ('keep','replace','debounce','append') then
    raise exception 'enqueue_job: bad mode %', p_mode;
  end if;
  if p_dedupe_key is null then
    return query
      insert into public.jobs (kind, user_id, run_at, payload, max_attempts)
      values (p_kind, p_user_id, v_run_at, coalesce(p_payload, '{}'::jsonb), p_max_attempts)
      returning jobs.id, jobs.run_at, now(), true;
    return;
  end if;
  return query
    insert into public.jobs as j (kind, user_id, run_at, payload, dedupe_key, max_attempts)
    values (p_kind, p_user_id, v_run_at, coalesce(p_payload, '{}'::jsonb), p_dedupe_key, p_max_attempts)
    on conflict (dedupe_key) where status = 'pending' and dedupe_key is not null
    do update set
      run_at = case p_mode
        when 'keep'     then j.run_at
        when 'replace'  then excluded.run_at
        when 'debounce' then least(
                               greatest(j.run_at, excluded.run_at),
                               case when p_max_delay_ms is null then 'infinity'::timestamptz
                                    else j.created_at + make_interval(secs => p_max_delay_ms / 1000.0) end)
        else least(j.run_at, excluded.run_at)                      -- append
      end,
      payload = case p_mode
        when 'keep'   then j.payload
        when 'append' then jsonb_set(
                             j.payload, '{items}',
                             coalesce(j.payload -> 'items', '[]'::jsonb)
                               || coalesce(excluded.payload -> 'items', '[]'::jsonb))
        else excluded.payload
      end
    returning j.id, j.run_at, now(), (j.xmax = 0);
end $$;

-- claim_jobs: SKIP LOCKED claim of due rows + reclaim of expired locks.
create or replace function public.claim_jobs(
  p_token uuid,
  p_kinds text[],
  p_limit int default 4,
  p_lock_seconds int default 330,
  p_job_id uuid default null,
  p_dedupe_key text default null)
returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  -- dead-letter expired runs that already used every attempt
  update public.jobs
     set status = 'dead', finished_at = now(), locked_by = null, locked_until = null,
         last_error = left(coalesce(last_error, '') || ' | lock expired after max attempts', 1000)
   where status = 'running' and locked_until < now()
     and attempts >= max_attempts and kind = any(p_kinds);

  return query
    update public.jobs j
       set status = 'running',
           attempts = j.attempts + 1,
           locked_until = now() + make_interval(secs => p_lock_seconds),
           locked_by = p_token,
           started_at = now()
     where j.id in (
       select c.id from public.jobs c
        where c.kind = any(p_kinds)
          and ((c.status = 'pending' and c.run_at <= now())
               or (c.status = 'running' and c.locked_until < now()))
          and (p_job_id is null or c.id = p_job_id)
          and (p_dedupe_key is null or c.dedupe_key = p_dedupe_key)
        order by c.run_at
        limit p_limit
        for update skip locked)
    returning j.*;
end $$;

-- finish_job: owner-checked transition; superseded on dedupe collision.
create or replace function public.finish_job(
  p_id uuid,
  p_token uuid,
  p_outcome text,                      -- done | retry | reschedule | dead
  p_run_at timestamptz default null,
  p_error text default null)
returns text                           -- 'done'|'pending'|'dead'|'superseded'|'lost'
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_exhausted boolean;
begin
  if p_outcome not in ('done','retry','reschedule','dead') then
    raise exception 'finish_job: bad outcome %', p_outcome;
  end if;
  select attempts >= max_attempts into v_exhausted
    from public.jobs where id = p_id and locked_by = p_token and status = 'running';
  if not found then return 'lost'; end if;

  if p_outcome = 'done' then
    update public.jobs set status = 'done', finished_at = now(), locked_by = null, locked_until = null
     where id = p_id returning status into v_status;
  elsif p_outcome = 'dead' or (p_outcome = 'retry' and v_exhausted) then
    update public.jobs set status = 'dead', finished_at = now(), locked_by = null, locked_until = null,
           last_error = left(p_error, 1000)
     where id = p_id returning status into v_status;
  else
    begin
      update public.jobs
         set status = 'pending', run_at = coalesce(p_run_at, now()),
             locked_by = null, locked_until = null,
             last_error = case when p_outcome = 'retry' then left(p_error, 1000) else last_error end,
             attempts = case when p_outcome = 'reschedule' then greatest(attempts - 1, 0) else attempts end
       where id = p_id returning status into v_status;
    exception when unique_violation then
      -- a newer pending row with the same dedupe_key already covers this work
      update public.jobs set status = 'done', finished_at = now(), locked_by = null, locked_until = null,
             last_error = 'superseded by newer pending job'
       where id = p_id;
      v_status := 'superseded';
    end;
  end if;
  return v_status;
end $$;

-- acquire_user_lease: DB fallback lease (dev / no Upstash). Same call extends.
create or replace function public.acquire_user_lease(p_user_id uuid, p_owner uuid, p_ttl_ms int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  insert into public.user_runtime as r (user_id, lease_until, lease_owner)
  values (p_user_id, now() + make_interval(secs => p_ttl_ms / 1000.0), p_owner)
  on conflict (user_id) do update
     set lease_until = excluded.lease_until, lease_owner = excluded.lease_owner
   where r.lease_until is null or r.lease_until < now() or r.lease_owner = p_owner
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
-- release = plain update: set lease_until=null, lease_owner=null, last_run_at=now()
--           where user_id=$1 and lease_owner=$2  (supabase-js)

-- ingest_inbound_message: identity + signup match + idempotent insert, one txn.
create or replace function public.ingest_inbound_message(
  p_provider text,
  p_provider_line text,
  p_kind text,                         -- 'imessage' for Sendblue + dev
  p_handle text,                       -- normalized (E.164 or lowercased email)
  p_handle_kind text,                  -- 'phone' | 'email'
  p_service text,                      -- 'imessage' | 'sms' | 'rcs'
  p_provider_message_id text,
  p_body text,
  p_media jsonb,
  p_reply_to_provider_id text,
  p_sent_at timestamptz,
  p_provider_opted_out boolean)
returns table (
  message_id uuid, duplicate boolean, user_id uuid, channel_id uuid, is_new_user boolean,
  user_name text, timezone text, timezone_source text,
  opted_out_at timestamptz, paused_until timestamptz, db_now timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_channel public.channels%rowtype;
  v_user    public.users%rowtype;
  v_signup  public.signups%rowtype;
  v_new     boolean := false;
  v_msg     uuid;
  v_reply   uuid;
  v_created timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('channel:' || p_kind || ':' || p_handle, 0));

  select * into v_channel from public.channels c where c.kind = p_kind and c.handle = p_handle;
  if not found then
    insert into public.users default values returning * into v_user;
    v_new := true;
    insert into public.channels (user_id, kind, handle, handle_kind, provider, provider_line,
                                 verified_at, last_service)
    values (v_user.id, p_kind, p_handle, p_handle_kind, p_provider, p_provider_line, now(), p_service)
    returning * into v_channel;
  else
    select * into v_user from public.users u where u.id = v_channel.user_id;
  end if;

  if p_handle_kind = 'phone' and v_user.name is null then
    select * into v_signup from public.signups s
     where s.phone_e164 = p_handle and s.expires_at > now() and s.matched_user_id is null
     order by s.created_at desc limit 1;
    if found then
      update public.users u
         set name = v_signup.name,
             timezone = coalesce(v_signup.timezone, u.timezone),
             timezone_source = case when v_signup.timezone is not null then 'signup' else u.timezone_source end
       where u.id = v_user.id returning * into v_user;
      update public.signups set matched_user_id = v_user.id where id = v_signup.id;
      insert into public.consents (user_id, channel_id, scope, granted, copy_version, source)
      values (v_user.id, v_channel.id, 'messaging', true, v_signup.consent_version, 'signup');
    end if;
  end if;

  if p_reply_to_provider_id is not null then
    select m.id into v_reply from public.messages m
     where m.provider = p_provider and m.provider_message_id = p_reply_to_provider_id;
  end if;

  v_created := case
    when p_sent_at between now() - interval '10 minutes' and now() + interval '1 minute' then p_sent_at
    else now() end;

  insert into public.messages (user_id, channel_id, direction, provider, provider_message_id,
                               body, media, reply_to_message_id, status, service, created_at)
  values (v_user.id, v_channel.id, 'in', p_provider, p_provider_message_id,
          p_body, p_media, v_reply, 'received', p_service, v_created)
  on conflict (provider, provider_message_id) do nothing
  returning id into v_msg;

  update public.channels c
     set last_inbound_at = greatest(coalesce(c.last_inbound_at, v_created), v_created),
         last_service    = coalesce(p_service, c.last_service),
         opted_out_at    = case when p_provider_opted_out and c.opted_out_at is null then now()
                                else c.opted_out_at end
   where c.id = v_channel.id
  returning * into v_channel;

  return query select v_msg, v_msg is null, v_user.id, v_channel.id, v_new,
                      v_user.name, v_user.timezone, v_user.timezone_source,
                      v_channel.opted_out_at, v_channel.paused_until, now();
end $$;

-- purge_messages_before: batched retention delete (reactions cascade).
create or replace function public.purge_messages_before(p_before timestamptz, p_limit int default 5000)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  with doomed as (
    select id from public.messages where created_at < p_before order by created_at limit p_limit)
  delete from public.messages m using doomed d where m.id = d.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- private.jobs_tick: POST to dispatch only when work is due. No-op until Vault is configured.
create or replace function private.jobs_tick() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'aria_dispatch_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'aria_dispatch_secret');
  v_ts  text;
begin
  if v_url is null or v_key is null then return null; end if;
  if not exists (
    select 1 from public.jobs
     where (status = 'pending' and run_at <= now())
        or (status = 'running' and locked_until < now())) then
    return null;
  end if;
  v_ts := extract(epoch from clock_timestamp())::bigint::text;
  return net.http_post(
    url := v_url,
    body := jsonb_build_object('source', 'pg_cron'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-aria-ts', v_ts,
      'x-aria-sig', encode(extensions.hmac('v1.' || v_ts, v_key, 'sha256'), 'hex')),
    timeout_milliseconds := 5000);
end $$;

-- ── grants: service_role only ──────────────────────────────────────
revoke execute on function public.enqueue_job(text,uuid,timestamptz,jsonb,text,text,int,int) from public, anon, authenticated;
revoke execute on function public.claim_jobs(uuid,text[],int,int,uuid,text)                   from public, anon, authenticated;
revoke execute on function public.finish_job(uuid,uuid,text,timestamptz,text)                 from public, anon, authenticated;
revoke execute on function public.acquire_user_lease(uuid,uuid,int)                           from public, anon, authenticated;
revoke execute on function public.ingest_inbound_message(text,text,text,text,text,text,text,text,jsonb,text,timestamptz,boolean) from public, anon, authenticated;
revoke execute on function public.purge_messages_before(timestamptz,int)                      from public, anon, authenticated;
revoke execute on function private.jobs_tick()                                                from public, anon, authenticated;
grant execute on function public.enqueue_job(text,uuid,timestamptz,jsonb,text,text,int,int) to service_role;
grant execute on function public.claim_jobs(uuid,text[],int,int,uuid,text)                   to service_role;
grant execute on function public.finish_job(uuid,uuid,text,timestamptz,text)                 to service_role;
grant execute on function public.acquire_user_lease(uuid,uuid,int)                           to service_role;
grant execute on function public.ingest_inbound_message(text,text,text,text,text,text,text,text,jsonb,text,timestamptz,boolean) to service_role;
grant execute on function public.purge_messages_before(timestamptz,int)                      to service_role;

-- ── cron (safe before deploy: tick is a no-op until Vault secrets exist) ──
select cron.schedule('aria-jobs-tick', '15 seconds', $$ select private.jobs_tick(); $$);
select cron.schedule('aria-retention-enqueue', '17 8 * * *',
  $$ select public.enqueue_job('retention_purge', null, now(), '{}'::jsonb, 'retention_purge', 'keep'); $$);
select cron.schedule('aria-cron-history-purge', '0 4 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '2 days'; $$);
```

**Notes for the orchestrator:**

1. **Supersedes the 002 comment.** 002 says "the cron.schedule call lands with V2-06". This plan **moves it into 003 as a no-op-until-configured schedule**, because V2-03 owns the jobs infrastructure. The deploy-specific part is the Vault secrets, set by the runbook in §11 T9.
2. **Regenerate types** after the push: `supabase gen types typescript --linked --schema public > src/server/db/types.ts`. The RPC argument and return types come from it.
3. **Check the Postgres version.** Run `select version();` and confirm ≥ 15.1.1.61, which sub-minute pg_cron needs **[verify]**.
4. **`xmax = 0` in RETURNING** is the standard "was inserted" trick. If the types generator rejects the boolean column name, rename it to `inserted`.

---

## 5. Dependencies

| Package | Version | Published | Kind | Why |
|---|---|---|---|---|
| `tsx` | **4.23.15** | 2026-09-20 | dev | Runs `scripts/dev-chat.ts`, `dev-tick.ts`, and the smoke script with the `@/` tsconfig paths. Node 22 `--experimental-strip-types` doesn't resolve path aliases. |

**Nothing new at runtime.** We use what's installed:
- `@upstash/redis` 1.39.0 (2026-09-21)
- `@supabase/supabase-js` ^2.99.2
- `zod` 4.6.5
- `next` 16.4.0
- `jest` 30.5.2 with `next/jest` (the foundation agent set it up)

**Rejected:**

| Package | Why not |
|---|---|
| `sendblue` 3.20.0 (official SDK) | Published 2026-10-09, so less than 2 weeks old. Eight releases since 2026-09-30. It has **no** `send-reaction` or `mark-read`. Its default base URL differs from the docs. The six endpoints we need are ~120 lines of `fetch`. |
| `chat-adapter-sendblue` + `chat` | A framework we don't need. It only *adds* reactions. |
| `standardwebhooks` / `svix` | Sendblue doesn't use them; it sends a static header secret. |
| `ts-jest` | `next/jest` already handles TypeScript transforms. |

---

## 6. Environment variables

| Var | Required | Notes |
|---|---|---|
| `CHANNEL_PROVIDER` | no | `sendblue` or `dev`. Defaults to `dev` outside production and `sendblue` in production. `dev` in production makes it throw. |
| `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET` | prod | Sent as the `sb-api-key-id` / `sb-api-secret-key` headers |
| `SENDBLUE_FROM_NUMBER` | prod | Already present. The line (E.164) used as `from_number`; also stored in `channels.provider_line`. |
| `SENDBLUE_SIGNING_SECRET` | prod | Already present; **the name stays**. Compared against the `sb-signing-secret` header. Comma-separated for rotation. Set the same value as `globalSecret` in the Sendblue dashboard. |
| `SENDBLUE_API_BASE` | no | Default `https://api.sendblue.com` **[verify vs `.co`]** |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | prod | Already present. Lease and rate limits. Absent in dev, the DB lease is used. |
| `JOBS_DISPATCH_SECRET` | prod | Already present. Must equal Vault `aria_dispatch_secret` (`openssl rand -hex 32`). |
| `CRON_SECRET` | prod | **New.** Vercel Cron bearer for the daily backstop `GET` |
| `DEV_CHANNEL_SECRET` | dev | **New.** Header secret for `/api/channels/dev` |
| `ARIA_AGENT` | no | **New.** `stub` forces `stubAgentTurn`, for tests and running without credentials |
| `APP_BASE_URL` | prod | Already present. Used for the vCard URL and the link allowlist. |

Tuning constants stay in `src/server/pipeline/config.ts`, not env:

| Constant | Value |
|---|---|
| Debounce | 2500 ms |
| Max debounce | 8000 ms |
| Watchdog | 8000 ms |
| Lease TTL | 60s |
| Heartbeat | 20s |
| Run deadline | 270s |
| Inbound rate | 30/min |
| Daily turn cap | 200 |
| Proactive cap | 3 |
| Bundle window | 10 min |
| Routine hold | 30s |
| Follow-up quota | 180 |

---

## 7. File plan

`(new)` means a new file; everything listed is V2-03-owned unless noted. Every exported function gets JSDoc.

### `src/shared/tz.ts`: DST-safe timezone math (pure, Intl only; V2-06 should reuse it)

```ts
export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
export function isValidTimeZone(tz: string): boolean;
export function localParts(at: Date, tz: string): LocalParts;
/** Local wall time → UTC instant. Gap (spring-forward) → shifted forward; overlap → earlier instant. */
export function zonedTimeToUtc(p: Omit<LocalParts, "weekday">, tz: string): Date;
export function localDateKey(at: Date, tz: string): string;           // "2026-10-10"
export function startOfLocalDay(at: Date, tz: string): Date;
/** "22:00" | "22:00:00" → minutes since midnight. */
export function parseClock(t: string): number;
```

### `src/server/channels/types.ts`: shared contract types (also used by V2-04 and V2-06)

```ts
export type ProviderName = "sendblue" | "dev";
export type Service = "imessage" | "sms" | "rcs";
export type ClassicTapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
/** Classic name or exactly one emoji (Sendblue rejects anything else). */
export type ReactionType = ClassicTapback | (string & { readonly __emoji?: never });

export interface PlanReaction {
  /** messages.id of an INBOUND message from this user. */
  targetMessageId: string;
  type: ReactionType;
  /** Sent as a bubble only when the channel can't do tapbacks (e.g. "👍" for a confirmation). */
  fallbackText?: string;
}
export interface PlanBubble {
  text: string;                    // ≤ 1200 chars after validation
  /** messages.id to thread under (inline reply on iMessage V2 lines). */
  replyToMessageId?: string;
}
export interface ReplyPlan {
  reactions?: PlanReaction[];      // ≤ 2
  bubbles: PlanBubble[];           // 0–3 (0 allowed iff reactions present)
  link?: { url: string };          // appOrigin() or https://mail.google.com/ only
  media?: { url: string; kind: "vcard" | "image" | "file" }[]; // appOrigin() only
}
export interface ChannelCapabilities {
  reactions: boolean; typing: boolean; inlineReplies: boolean; media: boolean; maxBubbleChars: number;
}
/** What tools/agent may know about the channel. Never includes the raw handle. */
export interface ChannelContext {
  channelId: string; provider: ProviderName; kind: "imessage" | "sms" | "whatsapp";
  service: Service; handleKind: "phone" | "email" | "bsuid";
  capabilities: ChannelCapabilities; windowOpen: boolean;
}
export interface OutboundTarget { handle: string; line: string | null; service: Service }
export interface SendInput { text?: string; mediaUrl?: string; replyToProviderId?: string }
export interface SendResult { providerMessageId: string | null; status: "sent" | "queued" | "declined" | "failed"; service?: Service; errorKey?: string }
export type InboundEvent =
  | { type: "message"; providerMessageId: string; handle: string; handleKind: "phone" | "email";
      line: string | null; service: Service; text: string; media: InboundMedia[];
      replyToProviderId?: string; sentAt: Date; providerOptedOut: boolean }
  | { type: "reaction"; handle: string; targetProviderId?: string; targetSnippet?: string;
      reaction: ReactionType; removed: boolean; sentAt: Date }   // [verify] shape
  | { type: "status"; providerMessageId: string; status: string; errorKey?: string; service?: Service }
  | { type: "typing"; handle: string; isTyping: boolean }
  | { type: "ignored"; reason: "group" | "outbound_echo" | "unparseable" | "unsupported" };
export interface InboundMedia { url: string; kind: "image" | "pdf" | "audio" | "video" | "vcard" | "other" }
export type WebhookParse = { ok: false; status: 401 | 400 } | { ok: true; events: InboundEvent[] };

export interface ChannelProvider {
  readonly name: ProviderName;
  capabilities(service: Service, handleKind: "phone" | "email" | "bsuid"): ChannelCapabilities;
  send(to: OutboundTarget, input: SendInput): Promise<SendResult>;
  react(to: OutboundTarget, providerMessageId: string, reaction: ReactionType): Promise<boolean>;
  typing(to: OutboundTarget, state: "start" | "stop", maxMs?: number): Promise<void>;
  markRead?(to: OutboundTarget): Promise<void>;
  parseWebhook(req: { headers: Headers; rawBody: string }): WebhookParse;
}
```

### Other channel files

| File | Purpose | Exports |
|---|---|---|
| `src/server/channels/plan.ts` | Validate and normalize plans; outbox merge (pure) | `validatePlan(plan: ReplyPlan, opts: { appOrigin: string; interimSent?: boolean }): { plan: ReplyPlan; warnings: string[] }`<br>`isAllowedLink(url: string, appOrigin: string): boolean`<br>`mergeOutboxItems(items: OutboxItem[]): ReplyPlan`<br>`type OutboxItem` |
| `src/server/channels/render.ts` | Plan to steps (pure) | `type RenderStep = {t:"react"; targetMessageId; reaction} \| {t:"typing"; state:"start"\|"stop"} \| {t:"pause"; ms} \| {t:"send"; text?; mediaUrl?; replyToMessageId?; bubbleIndex}`<br>`bubblePauseMs(text: string): number`<br>`renderPlan(plan: ReplyPlan, caps: ChannelCapabilities, opts: { elapsedMs: number; snippets: Record<string,string> }): RenderStep[]` |
| `src/server/channels/execute.ts` | Run steps against a provider, with idempotent bookkeeping | `executeSteps(steps: RenderStep[], io: ExecuteIo): Promise<ExecuteReport>`<br>`interface ExecuteIo { provider; target; sleep(ms): Promise<void>; signal?: AbortSignal; beforeSend(step): Promise<{ messageId: string } \| null /* null = already sent */>; afterSend(messageId, result: SendResult): Promise<void>; resolveProviderId(messageId): Promise<string \| null>; recordReaction(targetMessageId, reaction): Promise<void> }` |
| `src/server/channels/guards.ts` | Guard decisions (pure) | `type DeliveryClass = "reply" \| "routine" \| "urgent" \| "requested"`<br>`effectiveQuietWindow(user: {quietStart: string; quietEnd: string}, service: Service): {startMin: number; endMin: number}`<br>`isQuiet(at: Date, tz: string, w): boolean`<br>`nextQuietEnd(at: Date, tz: string, w, jitterMs: number): Date`<br>`evaluateDelivery(state: GuardState, cls: DeliveryClass, now: Date): GuardDecision`<br>where `GuardDecision = {action:"send"} \| {action:"defer"; until: Date; reason: "paused"\|"quiet_hours"\|"daily_cap"\|"bundling"\|"followup_quota"\|"conversation_active"} \| {action:"drop"; reason:"opted_out"\|"expired"}` |
| `src/server/channels/commands.ts` | Keyword commands (pure) | `type Command = {kind:"opt_out"} \| {kind:"opt_in"} \| {kind:"help"} \| {kind:"pause"; until: Date}`<br>`detectCommand(text: string, now: Date, tz: string): Command \| null`<br>`commandReply(cmd: Command): string` |
| `src/server/channels/interim.ts` | Watchdog lines (pure) | `detectRegister(recent: string[]): "casual" \| "neutral"`<br>`pickInterim(register, rng?: () => number): string` |
| `src/server/channels/vcard.ts` | vCard 3.0 text (pure) | `buildVCard(input: { name: string; phoneE164: string \| null; url: string; note: string }): string` |
| `src/server/channels/providers/sendblue-schema.ts` | zod schemas for receive, outbound, and typing payloads (lenient `passthrough`) | `SendblueMessagePayload`, `SendblueTypingPayload`, `parseTapbackText(text): {reaction; snippet; removed} \| null` (legacy `Loved “…”` form, **[verify]** gated) |
| `src/server/channels/providers/sendblue.ts` | Sendblue adapter over `fetch` (10s timeout, one retry on 429/503 only) | `createSendblueProvider(cfg: { apiKey; apiSecret; base; signingSecrets: string[] }): ChannelProvider`<br>`verifySendblueSecret(headers: Headers, secrets: string[]): boolean`<br>`parseSendblueWebhook(rawBody: string): InboundEvent[]` |
| `src/server/channels/providers/dev.ts` | No-credentials provider: logs to the console and keeps an in-memory transcript; outbound rows still go to `messages`, so the REPL can poll | `createDevProvider(): ChannelProvider & { transcript(): DevEvent[] }` |
| `src/server/channels/repo.ts` | DB access for channels and messages (service role) | `getPrimaryChannel(userId)`<br>`getChannel(channelId)`<br>`insertOutbound(row): Promise<string \| null /* null = idempotency conflict */>`<br>`markOutbound(messageId, result)`<br>`setOptOut(channelId, at: Date \| null, source)`<br>`setPause(channelId, until: Date \| null)`<br>`proactiveStats(userId, sinceLocalMidnight: Date): Promise<{routineCount; lastProactiveAt}>`<br>`followupRecipients24h(line): Promise<number>`<br>`recordReaction(...)`<br>`claimDedupe(userId, key): Promise<boolean>`<br>`dedupeExists(userId, key)` |
| `src/server/channels/deliver.ts` | **Contract.** Guards, outbox, and execute | See below |
| `src/server/channels/index.ts` | Provider selection and barrel | `getProvider(name?: ProviderName): ChannelProvider`<br>`channelContext(channelRow): ChannelContext`<br>re-exports `deliver` and the types |

`deliver.ts` exports:

```ts
export type DeliverPriority = "routine" | "urgent" | "requested";
export interface DeliverOptions {
  proactive: boolean; reason: string;              // brief contract
  priority?: DeliverPriority;                      // default "routine" when proactive
  channelId?: string;                              // default: user's primary channel
  dedupeKey?: string;                              // producer idempotency (e.g. "briefing:2026-10-10")
  notBefore?: Date;                                // e.g. pre-generated briefing
  expiresAt?: Date;                                // drop if still undelivered after this
}
export type DeliverResult =
  | { status: "sent"; deliveryId: string; messageIds: string[] }
  | { status: "queued"; jobId: string; runAt: Date }               // proactive → outbox
  | { status: "suppressed"; reason: "opted_out" | "no_channel" | "duplicate" | "expired" | "invalid_plan" }
  | { status: "failed"; error: string };
export function deliver(userId: string, plan: ReplyPlan, opts: DeliverOptions): Promise<DeliverResult>;
/** Pipeline-internal: reply delivery with run bookkeeping + pacing credit. */
export function deliverReply(input: { userId: string; channelId: string; runId: string; plan: ReplyPlan;
  elapsedMs: number; trigger: "reply" | "interim" | "welcome" | "contact_card" | "command" | "fallback";
  keyPrefix: string; signal?: AbortSignal; bypassOptOut?: boolean /* command confirmations only */ }): Promise<DeliverResult>;
/** Outbox flush (proactive_flush job handler body). */
export function flushOutbox(userId: string, jobId: string, items: OutboxItem[], now: Date): Promise<JobOutcome>;
```

### `src/server/pipeline/`

| File | Purpose | Exports |
|---|---|---|
| `types.ts` | **Agent boundary contract** (V2-04 implements it) | See below |
| `config.ts` | Constants from §6 | `PIPELINE` (as const) |
| `lease.ts` | Lease store | `interface LeaseStore { acquire(userId, owner, ttlMs): Promise<boolean>; extend(userId, owner, ttlMs): Promise<boolean>; release(userId, owner): Promise<void>; isHeld(userId): Promise<boolean> }`<br>`createRedisLeaseStore(redis): LeaseStore`<br>`createDbLeaseStore(db): LeaseStore`<br>`getLeaseStore(): LeaseStore` (static choice by env; production requires Upstash)<br>`withHeartbeat(store, userId, owner, ttlMs, everyMs, onLost: () => void): () => void` |
| `ingest.ts` | Webhook core, shared by the Sendblue route, the dev route, and `dev-chat` | `ingestEvents(provider: ChannelProvider, events: InboundEvent[]): Promise<IngestOutcome[]>`<br>`type IngestOutcome = {kind:"turn"; userId; jobId; runAt: Date; dbNow: Date; target: OutboundTarget} \| {kind:"command"; ...} \| {kind:"stored_only"; reason} \| {kind:"duplicate"} \| {kind:"ignored"}`<br>`afterIngest(outcomes, provider): Promise<void>` (typing start, sleep, kick) |
| `commands-handler.ts` | Apply commands | `applyCommand(cmd: Command, ctx: { userId; channelId; messageId }): Promise<void>` (DB update, consent row, confirmation via `deliverReply(bypassOptOut)`, marks the message consumed under a `command` agent_run) |
| `turn.ts` | **Orchestration** (§2.2–2.4) | `runConversationTurn(userId: string, job: JobContext, deps?: Partial<TurnDeps>): Promise<JobOutcome>`<br>`interface TurnDeps { lease: LeaseStore; runAgentTurn: RunAgentTurn; provider: ChannelProvider; clock; sleep }` |
| `watchdog.ts` | Timer (fake-timer testable) | `startWatchdog(ms: number, fire: () => Promise<void>): { cancel(): void; fired(): boolean }` |
| `welcome.ts` | First-contact template (pure) | `welcomePlan(input: { name: string \| null; register?: "casual" \| "neutral" }): ReplyPlan`<br>`isGreetingOnly(text: string): boolean` |
| `stub-agent.ts` | Credential-free agent | `stubAgentTurn: RunAgentTurn` (echo plus a `like` tapback on "ok/ty/bet"; used by `ARIA_AGENT=stub` and tests) |
| `agent-impl.ts` | Resolve the agent | `getRunAgentTurn(): RunAgentTurn` (stub when `ARIA_AGENT=stub`, else `runAgentTurn` from `@/server/agent`) |
| `kick.ts` | Fast-path claim | `kickJob(jobId: string, delayMs: number): Promise<void>`<br>`drainUserTurn(userId: string): Promise<void>` |

`types.ts`:

```ts
import type { ChannelContext, ReplyPlan } from "@/server/channels/types";
export interface InboundMessage {
  id: string; body: string | null; media: InboundMedia[]; replyToMessageId: string | null; createdAt: Date;
}
export interface IdentityState {
  isNewUser: boolean; name: string | null; timezone: string;
  timezoneSource: "default" | "signup" | "user" | "inferred";
}
export interface AgentTurnInput {
  userId: string;
  runId: string;                     // agent_runs.id, created by the pipeline (pass to runModel for llm_calls.run_id)
  now: Date;
  timezone: string;                  // IANA
  channel: ChannelContext;
  identity: IdentityState;
  newMessages: InboundMessage[];     // this run's consumed inbound, oldest first (≥1)
  isFollowUpPass: boolean;           // second pass for messages that arrived mid-run
  welcomeSent: boolean;              // pipeline already greeted + disclosed AI this run
  signal: AbortSignal;               // aborts at run deadline - 30s
  /** Send one interim bubble now (send_interim tool). Returns false if one was already sent this run. */
  interim: (text: string) => Promise<boolean>;
}
export interface AgentTurnResult {
  plan: ReplyPlan;                   // may be reactions-only; empty = say nothing
  model: string;                     // final model id used
  escalated: boolean;
}
/** V2-04 exports this from src/server/agent/index.ts. Throw = turn failed (pipeline retries). */
export type RunAgentTurn = (input: AgentTurnInput) => Promise<AgentTurnResult>;
```

### `src/server/jobs/`

| File | Purpose | Exports |
|---|---|---|
| `types.ts` | Handler contract | `interface JobContext { jobId; kind: string; userId: string \| null; attempt: number; maxAttempts: number; token: string; now: Date; deadline: number; signal: AbortSignal }`<br>`type JobOutcome = {type:"done"} \| {type:"retry"; error: string; delayMs?: number} \| {type:"reschedule"; runAt: Date; reason: string} \| {type:"dead"; error: string}`<br>`interface JobHandler<S extends z.ZodType> { payload: S; maxAttempts?: number; run(ctx: JobContext, payload: z.output<S>): Promise<JobOutcome \| void> }`<br>`defineJobKind<S extends z.ZodType>(h: JobHandler<S>): JobHandler<S>` |
| `kinds/index.ts` | **Registry** (other branches add an import plus one entry) | `export const JOB_KINDS = { conversation_turn, proactive_flush, retention_purge, noop } satisfies Record<string, JobHandler<z.ZodType>>`<br>`export type JobKind = keyof typeof JOB_KINDS`<br>`export type JobPayload<K extends JobKind> = z.input<(typeof JOB_KINDS)[K]["payload"]>`<br>`export const REGISTERED_KINDS: JobKind[]` |
| `kinds/conversation-turn.ts` | `payload: z.object({ userId: z.uuid() })`, `maxAttempts: 3` | Calls `runConversationTurn` |
| `kinds/proactive-flush.ts` | `payload: z.object({ items: z.array(OutboxItemSchema) })`, `maxAttempts: 5` | Calls `flushOutbox` |
| `kinds/retention-purge.ts` | `payload: z.object({})` | Purges (§2.11) and re-enqueues if it ran out of budget |
| `kinds/noop.ts` | `payload: z.object({ note: z.string().optional() })` | Health and smoke checks |
| `enqueue.ts` | **Contract** | See below |
| `runner.ts` | Claim and run loop | `runDueJobs(opts: { budgetMs: number; concurrency: number; jobId?: string; dedupeKey?: string }): Promise<RunSummary>`<br>`runClaimed(row: Tables<"jobs">, token: string, deadline: number): Promise<void>` (zod parse, handler, `finish_job`; throw → retry with `retryDelayMs`)<br>`deadLetterUnknownKinds(olderThanMs)` |
| `backoff.ts` | Pure | `retryDelayMs(attempt: number, rng?: () => number): number` |
| `auth.ts` | Dispatch auth (pure; uses `node:crypto`) | `signDispatch(tsSec: number, secret: string): string`<br>`verifyDispatch(h: { ts: string \| null; sig: string \| null }, secret: string, nowSec: number, skewSec?: number): boolean`<br>`verifyCronBearer(authz: string \| null, secret: string): boolean` |

`enqueue.ts`:

```ts
export type EnqueueMode = "keep" | "replace" | "debounce" | "append";
export interface EnqueueInput<K extends JobKind> {
  kind: K; userId?: string | null; runAt?: Date; payload?: JobPayload<K>; dedupeKey?: string;
  mode?: EnqueueMode;          // default "replace" when dedupeKey set
  maxDelayMs?: number;         // debounce cap
}
export interface EnqueueResult { id: string; runAt: Date; dbNow: Date; created: boolean }
export function enqueueJob<K extends JobKind>(input: EnqueueInput<K>): Promise<EnqueueResult>;
export function cancelJobs(filter: { dedupeKey?: string; ids?: string[] }): Promise<number>; // pending → done ('cancelled'), for V2-06 reminder edits
```

### Routes

| Path | Purpose | Details |
|---|---|---|
| `src/app/api/channels/sendblue/route.ts` | `POST` webhook | `export const maxDuration = 300;` Reads raw text, verifies, parses, then `ingestEvents` and `after(() => afterIngest(...))`.<br>Returns 401 on a bad secret, 500 if the DB failed before insert, 200 otherwise. Handles `receive` and `typing_indicator`; ignores group and outbound echoes. |
| `src/app/api/channels/dev/route.ts` | `POST {handle, text, mediaUrl?, replyToMessageId?}` | 404 in production. Requires `x-dev-secret`. Builds the dev `InboundEvent` and goes through the same path. |
| `src/app/api/jobs/dispatch/route.ts` | `POST` (pg_cron HMAC) and `GET` (Vercel Cron bearer) | `maxDuration = 300`. Returns 202, then `after(() => runDueJobs({budgetMs: 270_000, concurrency: 4}))`. |
| `src/app/aria.vcf/route.ts` | `GET` | Serves `buildVCard` with `Content-Type: text/vcard`. The path ends in `.vcf`, as Sendblue requires. Public, with a cache header. |
| `vercel.json` (new) | Cron backstop | `{ "crons": [{ "path": "/api/jobs/dispatch", "schedule": "0 12 * * *" }] }` |

### Scripts

All run with `npx tsx`.

| File | Purpose |
|---|---|
| `scripts/dev-chat.ts` | REPL. `--as +15550100001` (default, fictional 555-01xx) or `--as +1<your signup phone>` to test signup matching. `--http` posts to `/api/channels/dev` instead of running in-process.<br>In-process mode calls `ingestEvents(devProvider, …)`, then `afterIngest`, so it needs only Supabase plus `ARIA_AGENT=stub` or `ANTHROPIC_API_KEY`.<br>It prints outbound bubbles and reactions by polling `messages` and `reactions` for the channel.<br>Commands: `/burst a | b | c` sends three messages 300ms apart; `/react <n> love` simulates an inbound tapback on Aria's nth-to-last message; `/reset` deletes the dev user. |
| `scripts/dev-tick.ts` | Signs and POSTs to `http://localhost:3000/api/jobs/dispatch` every 5s. Needed in dev because pg_cron can't reach localhost. |
| `scripts/smoke/v2-03-db.ts` | DB smoke test against the real project, using throwaway rows (§10) |
| `scripts/ops/configure-jobs-tick.sql` | **Runbook, not a migration.** Run after the first deploy: `vault.create_secret('<APP_BASE_URL>/api/jobs/dispatch','aria_dispatch_url',…)` and `vault.create_secret('<JOBS_DISPATCH_SECRET>','aria_dispatch_secret',…)`. Includes a rotation snippet using `vault.update_secret` and a verification query against `net._http_response`. |

### Tests

| Path | Contents |
|---|---|
| `tests/unit/**` | §10 |
| `tests/fixtures/sendblue/*.json` | Payloads from the docs: receive, inline reply, SMS, outbound status, typing, group, email handle, media |
| `tests/helpers/memory-store.ts` | In-memory `LeaseStore`, fake provider, and fake repo for the `turn.ts` logic tests |

---

## 8. Interfaces with other branches

### Provided by V2-03

| Consumer | Contract | Notes |
|---|---|---|
| **V2-04** agent | `ReplyPlan`, `PlanReaction`, `PlanBubble`, `ChannelContext` (from `@/server/channels/types`); `AgentTurnInput`, `AgentTurnResult`, `RunAgentTurn` (from `@/server/pipeline/types`) | V2-04 must export `runAgentTurn: RunAgentTurn` from `src/server/agent/index.ts`.<br>• The agent loads its own history from `messages`: `direction`, `body`, `media`, `reply_to_message_id`, `created_at`. Proactive outbound rows have `proactive_class` and `trigger` set.<br>• It loads reactions from `reactions`.<br>• Reactions are expressed **in the plan**, not as a tool (saves a round-trip).<br>• `react(message_id, type)` from spec §3.11 maps to `plan.reactions`. |
| V2-04 tool ctx | **Proposed brief change:** `ctx = {userId, runId, now, timezone, channel: ChannelContext, interim}`. `interim` is `AgentTurnInput.interim`, forwarded by the loop. | Needed for the `send_interim` tool. `channel` is now a typed `ChannelContext` with no raw handle. |
| **V2-05/06/07** producers | `deliver(userId, plan, {proactive: true, reason, priority?, dedupeKey?, notBefore?, expiresAt?})` returns `DeliverResult` | Brief contract plus optional fields. Producers **must** pass a `dedupeKey` (e.g. `reminder:<id>`, `briefing:<localDate>`, `alert:<timelineItemId>:<dueAtISO>`). Use `priority: "requested"` for user-set reminders and `"urgent"` for alerts that meet §3.15's bar. |
| Everyone | `enqueueJob({kind, userId?, runAt?, payload?, dedupeKey?, mode?, maxDelayMs?})` returns `EnqueueResult`, plus `cancelJobs` | Brief contract plus `mode`, `maxDelayMs`, and the return value. Default mode with a dedupe key is `replace`. To add a kind: create `src/server/jobs/kinds/<kind>.ts` with `defineJobKind({...})`, then add an import line and one entry in `kinds/index.ts`. |
| V2-06 | `src/shared/tz.ts` | One DST implementation (briefing times, quiet hours) |
| V2-08 | `messages.media` = `InboundMedia[]` (`{url, kind}`) | Sendblue inbound media URLs **expire after 30 days**, so V2-08 should fetch the PDF promptly, which the syllabus job does. `kind = "pdf"` comes from the URL extension. |
| V2-02 / settings | `users.quiet_start/quiet_end`, `channels.opted_out_at/paused_until` | A future `/settings` page edits them |

### Consumed by V2-03

| From | What |
|---|---|
| V2-02 | `db()`, `requireEnv` / `optionalEnv` / `appOrigin` / `isProduction`, `normalizeHandle` / `maskHandle`, `rateLimit`, `safeEqual` (crypto), `mintMagicLink` (only in HELP text later, optional) |
| V2-04 | `runAgentTurn`, and `defineTool` for the contributed tools (§9). If V2-03 is implemented first, `agent-impl.ts` wires `stubAgentTurn`; switching it is one line in V2-04's task. |

---

## 9. Job kinds and agent tools contributed

### Job kinds (V2-03)

| Kind | Enqueued by | Dedupe | Mode | maxAttempts |
|---|---|---|---|---|
| `conversation_turn` | webhook ingest | `turn:<userId>` | `debounce` (2.5s, cap 8s) | 3 |
| `proactive_flush` | `deliver(proactive)` | `outbox:<userId>` | `append` | 5 |
| `retention_purge` | pg_cron daily, or itself | `retention_purge` | `keep` | 3 |
| `noop` | smoke and health checks | — | — | 1 |

Suggested names for other branches (they own the files):
- V2-04: `memory_extract`
- V2-05: `canvas_sync`
- V2-06: `reminder_fire`, `briefing_generate`
- V2-07: `gmail_watch_renew`, `gcal_watch_renew`, `inbox_triage_chunk`
- V2-08: `syllabus_parse`

### Agent tools

These are files under `src/server/agent/tools/`. They're written **after** V2-04's `defineTool` exists (task T8).

| Tool | Input | Effect |
|---|---|---|
| `send_interim` | `{ text: string (≤80) }` | Calls `ctx.interim(text)`. Returns `{sent: boolean}`; it's false if the watchdog already sent one. |
| `pause_messages` | `{ until?: ISO string, hours?: number (1–168) }` | Sets `channels.paused_until` for the current channel (proactive messages only). Returns the local-time confirmation string. For "leave me alone today"-style text inside a longer message. |
| `set_identity` | `{ name?: string (1–40), timezone?: IANA }` | Updates `users.name` / `timezone` and sets `timezone_source = 'user'`. Rejects an invalid IANA zone (`isValidTimeZone`). |

Full opt-out has **no tool**. It's deterministic only (§2.8), so a prompt injection can't unsubscribe or resubscribe someone.

---

## 10. Test plan

### 10.1 Jest unit tests

Pure logic, under `tests/unit/`. These are not call-chain mocks.

| File | Cases |
|---|---|
| `tz.test.ts` | • `zonedTimeToUtc` in NY on spring-forward day 02:30 (gap shifts to 03:30 EDT) and fall-back 01:30 (earlier instant)<br>• Asia/Kolkata half-hour offset<br>• `localDateKey` around UTC midnight<br>• `startOfLocalDay` on a DST day (23h and 25h days)<br>• invalid zone |
| `guards.test.ts` | • quiet window crossing midnight (21:59 not quiet; 22:00 quiet; 07:59 quiet; 08:00 not)<br>• non-crossing window; start == end means none<br>• SMS widening to 21:00<br>• `nextQuietEnd` across DST<br>• the class matrix from §2.6, row by row<br>• cap counting only routine<br>• urgent and requested bypass the cap<br>• requested bypasses quiet but not pause<br>• opt-out drops all classes<br>• expired drops<br>• follow-up quota threshold<br>• `conversation_active` defers 30s |
| `commands.test.ts` | • every opt-out phrase, with case, punctuation, and emoji variants ("STOP!!", "Stop 🛑", "leave me alone pls")<br>• **negatives**: "stop reminding me about cpsc", "end of week?", "can you pause my gym block", "quit my job lol"<br>• START/UNSTOP<br>• HELP<br>• pause durations ("pause for 2 days", "mute till tomorrow" gives local midnight + 1 day in the tz, "pause" alone gives 24h) |
| `plan.test.ts` | • cap 3 (merges the 4th)<br>• the interim reduces the cap to 2<br>• trimming and the 1200-character limit<br>• empty plan with no reactions is allowed (silence)<br>• link allowlist (our origin OK; `javascript:`, other hosts, and lookalike `appOrigin.evil.com` rejected)<br>• emoji validation (one grapheme; `❤` without VS16 rejected)<br>• `mergeOutboxItems` ordering, first link wins, duplicate dedupeKey dropped |
| `render.test.ts` | • order: reactions, then (typing, pause, send) × n<br>• `bubblePauseMs` clamps (1 char gives 800; 35 chars give 1000; 500 chars give 4000)<br>• first-bubble credit from `elapsedMs`<br>• SMS: reactions dropped, `fallbackText` becomes a bubble, `replyTo` dropped, quote prefix only when there are >1 targets<br>• reactions-only plan gives typing stop<br>• media sends are outside the cap |
| `execute.test.ts` | With a fake provider and fake sleep:<br>• the `beforeSend` null skip (idempotency)<br>• inline-reply 400 retried once without `reply_to`<br>• reaction 422 `unsupported_on_this_line` disables reactions afterward<br>• abort signal stops later sends<br>• no resend on timeout |
| `sendblue.test.ts` | • `verifySendblueSecret`: match, mismatch, missing header, rotation list, length mismatch<br>• parse fixtures: receive (iMessage), inline reply mapping, SMS service, email handle, media (`.pdf` gives pdf, `.heic` gives image), group ignored, `is_outbound` echo ignored, typing payload, garbage gives `unparseable`<br>• `parseTapbackText` (gated) |
| `backoff.test.ts` | Monotonic, capped at 1h, jitter within ±20% |
| `dispatch-auth.test.ts` | • sign/verify round trip<br>• skew 61s rejected<br>• wrong secret, malformed sig, non-numeric ts<br>• cron bearer |
| `lease.test.ts` | A contract test run against the in-memory store with an injected clock (and, behind `RUN_INTEGRATION=1`, against Redis/DB):<br>• exclusive acquire<br>• owner-only extend and release<br>• expiry hands over<br>• heartbeat `onLost` fires when extend fails |
| `turn.test.ts` | `runConversationTurn` with the `tests/helpers/memory-store.ts` fakes, the stub agent, and fake timers:<br>• lease held gives `reschedule` without consuming<br>• nothing unconsumed gives `done` with no send<br>• a message arriving mid-run gives exactly one follow-up pass<br>• the watchdog fires once at 8s for a slow agent; plan capped at 2<br>• an agent throw un-consumes and gives `retry`, and the last attempt sends the fallback<br>• an orphan run with no outbound is recovered (un-consumed)<br>• an orphan with outbound is not replayed<br>• first contact gives welcome + vCard, and a greeting-only message skips the agent<br>• opted-out channel gives no run |
| `welcome-interim.test.ts` | Greeting detection; register detection; pool picks are deterministic with a seeded rng |
| `vcard.test.ts` | CRLF line endings; escaping |

### 10.2 DB smoke script

`npx tsx scripts/smoke/v2-03-db.ts`, run against the real project after `003` is applied. Every row it creates hangs off a throwaway `users` row (deleting the user cascades) or uses kind `smoke_test`, which is unregistered so production dispatch never claims it. Everything is deleted in `finally`.

1. **`ingest_inbound_message` concurrency.** Three parallel calls for a fresh `+1555010xxxx` handle with different message ids give exactly 1 user, 1 channel, and 3 messages. A repeat call with the same id gives `duplicate = true`.
2. **Signup match.** Insert a `signups` row, ingest from that phone: the name and tz are copied, `matched_user_id` is set, and a consent row exists.
3. **`enqueue_job` debounce.** Enqueue at t, then t+1s: same id, `run_at` pushed. Cap: with `max_delay` 2s, a later enqueue doesn't go past created + 2s. Then `append` concatenates items, and `keep` doesn't change.
4. **`claim_jobs`.**
   - Two parallel claims (limit 1) on one due row: exactly one wins (SKIP LOCKED).
   - A not-yet-due row isn't claimed.
   - An expired `running` row is reclaimed with attempts incremented.
   - An exhausted expired row becomes `dead`.
5. **`finish_job`.**
   - A wrong token gives `lost`.
   - `reschedule` gives the attempt back.
   - `retry` → `pending` collides with a new pending row on the same dedupe key and gives `superseded`.
6. **`acquire_user_lease`.** Exclusive; the owner can re-acquire (extend); a short TTL expires and a second owner takes over.
7. **`purge_messages_before`.** Back-date 3 rows, purge, assert the count and that reactions cascaded.
8. **Grants.** An anon-key client calling `rpc('claim_jobs')` gets a permission error.
9. **Tick.** `select private.jobs_tick()` returns null when Vault isn't configured or nothing is due. This is informational only.

### 10.3 End-to-end without credentials (dev provider)

1. **REPL run:** `ARIA_AGENT=stub npx tsx scripts/dev-chat.ts`.
   - "hey aria" gives the welcome (AI disclosure plus a name question) and the vCard bubble, with no agent call.
   - "Dan" gives a stub echo; the real agent would call `set_identity`.
   - `/burst whats due | also gym? | nvm` gives **one** run, with all three in `newMessages`.
   - "ok" gives a reaction only.
   - "STOP" gives the confirmation, and then "hello?" gets no reply. "START" resumes.
   - "pause for 2 days" gives the pause confirmation, and `deliver(proactive)` returns `queued` with `runAt` ≥ the pause end (checked via a REPL helper `/proactive test`).
2. **HTTP mode:** `npm run dev` + `npx tsx scripts/dev-tick.ts` + `dev-chat --http`.
   - This exercises the route, the `after()` debounce sleep, and dispatch.
   - Kill `next dev` mid-run; on restart, the tick reclaims the job and recovery runs.
3. **Real agent:** same as 1 with `ANTHROPIC_API_KEY` (once V2-04 lands).

---

## 11. Ordered implementation tasks

Each task is sized for one sub-agent. Implementers **don't** run `npm install`, write migrations, commit, or run `next build`. They check their work with `npx tsc --noEmit`, `npx eslint <files>`, and `npm test`.

**Prerequisite (orchestrator):** apply the §4 delta in `003_v2_build.sql`, regenerate `src/server/db/types.ts`, and install `tsx@4.23.15` (dev).

| # | Task | Files owned | Depends on | Acceptance criteria |
|---|---|---|---|---|
| **T1** | Pure core: tz, contract types, plan, render, guards, commands, interim, welcome, vCard, backoff, dispatch auth | `src/shared/tz.ts`; `src/server/channels/{types,plan,render,guards,commands,interim,vcard}.ts`; `src/server/pipeline/{types,config,welcome}.ts`; `src/server/jobs/{backoff,auth}.ts`; matching `tests/unit/*` | — | All §10.1 pure suites pass. No DB or network imports in these files. `tsc` clean. No `any`. |
| **T2** | Jobs runtime: types, registry, enqueue, runner, dispatch route, `noop` + `retention_purge` kinds, `vercel.json`, `dev-tick` | `src/server/jobs/{types,enqueue,runner}.ts`, `src/server/jobs/kinds/{index,noop,retention-purge}.ts`, `src/app/api/jobs/dispatch/route.ts`, `vercel.json`, `scripts/dev-tick.ts` | T1, migration | • Dispatch returns 401 on a bad HMAC and 202 on a good one.<br>• A `noop` job enqueued by script runs to `done` via dev-tick within 5s.<br>• A throwing handler retries with backoff and ends `dead` after max attempts.<br>• Unknown kinds older than 1h are dead-lettered.<br>• `cancelJobs` works. |
| **T3** | Providers: Sendblue adapter and schema, dev provider, `getProvider`, `/aria.vcf` | `src/server/channels/providers/*`, `src/server/channels/index.ts`, `src/app/aria.vcf/route.ts`, `tests/fixtures/sendblue/*`, `tests/unit/sendblue.test.ts` | T1 | • Fixture parse and verify tests pass.<br>• No Sendblue SDK.<br>• 10s timeouts; retry only on 429/503 and pre-write connection errors.<br>• `CHANNEL_PROVIDER=dev` in production throws.<br>• `curl /aria.vcf` returns a valid vCard. |
| **T4** | Delivery: repo, execute, deliver (reply and proactive outbox), `proactive_flush` kind | `src/server/channels/{repo,execute,deliver}.ts`, `src/server/jobs/kinds/proactive-flush.ts`, `tests/unit/execute.test.ts` | T2, T3 | • `deliverReply` writes outbound rows *before* send, with idempotency keys; a re-run sends nothing twice.<br>• `deliver(proactive)` gives `queued`, merges items in one pending job, and defers correctly under quiet hours, pause, cap, and lease-held.<br>• Opted out gives `suppressed`.<br>• `proactive_dedupe` blocks a second item with the same key. |
| **T5** | Ingest and leases: lease stores, commands handler, ingest, kick, Sendblue and dev webhook routes | `src/server/pipeline/{lease,ingest,commands-handler,kick}.ts`, `src/app/api/channels/{sendblue,dev}/route.ts`, `tests/unit/lease.test.ts`, `tests/helpers/memory-store.ts` | T2, T3, T4 | • The webhook answers in <1s locally (log the timing).<br>• A duplicate POST is a no-op.<br>• STOP / START / HELP / pause behave per §2.8.<br>• The inbound rate limit stores without kicking.<br>• The typing webhook extends the debounce of a pending turn (bounded by the 8s cap).<br>• The production lease store requires Upstash. |
| **T6** | Turn orchestration: `turn.ts`, watchdog, stub agent, agent-impl, `conversation_turn` kind, first-contact flow | `src/server/pipeline/{turn,watchdog,stub-agent,agent-impl}.ts`, `src/server/jobs/kinds/conversation-turn.ts`, `tests/unit/turn.test.ts` | T4, T5 | All `turn.test.ts` cases pass, plus: a burst gives a single run; a mid-run message gives one follow-up pass; the drain claims a tail job inline; orphan recovery works; `agent_runs` rows are closed with model/escalated/status. |
| **T7** | Dev loop and smoke: `dev-chat` REPL, DB smoke script, ops runbook SQL | `scripts/dev-chat.ts`, `scripts/smoke/v2-03-db.ts`, `scripts/ops/configure-jobs-tick.sql` | T6 | The §10.2 smoke passes on the real project and leaves zero rows. The §10.3 REPL script passes with `ARIA_AGENT=stub`. |
| **T8** | Agent tools: `send_interim`, `pause_messages`, `set_identity`, plus switching `agent-impl.ts` to the real agent | `src/server/agent/tools/{send-interim,pause-messages,set-identity}.ts` and one registry line each in V2-04's `tools/index.ts` | V2-04 registry | Tools validate input with zod, are deterministic, and have unit tests for `set_identity` tz validation and pause-duration parsing. |
| **T9** | Deploy wiring (orchestrator or Daniel, after the first Vercel deploy) | runbook only | deploy | 1. Run `configure-jobs-tick.sql` with the real URL and secret.<br>2. Within 30s of a due `noop` job, `net._http_response` shows 202 and the job is `done`.<br>3. Set `CRON_SECRET` in Vercel. |

---

## 12. Verify-when-credentials-arrive checklist

### Sendblue sandbox

1. **Webhook signature.** Configure the `receive` webhook to `<APP_BASE_URL>/api/channels/sendblue` with `globalSecret = SENDBLUE_SIGNING_SECRET`. Confirm the header is literally `sb-signing-secret` and its value equals the secret, with no hashing.
2. **Base URL.** Confirm whether `api.sendblue.com` or `api.sendblue.co` is canonical (docs vs SDK). Set `SENDBLUE_API_BASE` if needed.
3. **Payload capture.** Log one raw inbound payload, with the body redacted, for each case and update the fixtures:
   - iMessage text
   - a photo
   - a PDF
   - a multi-attachment message
   - an inline reply
   - an SMS from an Android phone (must land on the same number)
   - an **Apple ID email** sender: which field carries the email?
4. **Inbound tapbacks.** Love, then remove, a message of Aria's. Is there a webhook? Which type? What shape (`Loved “…”` text, or structured)? Then enable or replace `parseTapbackText`.
5. **Send response.** Confirm the `send-message` response includes `message_handle` and `status`, and what `DECLINED` looks like for an opted-out contact.
6. **Typing.** Typing start, stop, and `max_duration_ms` on the sandbox line (503 firmware note). Typing to an email handle.
7. **Reactions.** Send-reaction on the sandbox/shared line: does it return `unsupported_on_this_line`? Inline replies: is the sandbox line a "V2 line"?
8. **Opt-out.** Text `STOP`:
   - Does Sendblue send its own confirmation?
   - Does it decline ours?
   - Is `opted_out: true` in later payloads?
   - Does `START` clear it?
   - Does "leave me alone" pass through untouched?
9. **vCard and links.** Send the vCard: does it render as a contact card, and do links in the following messages then expand?
10. **Account settings.** Enable auto-typing-indicator, and decide on auto mark-read (open Q 5).
11. **Sandbox limits.** Confirm the contact cap and verification flow (`sendblue add-contact`, then the contact texts once) and the "150 consecutive outbound" cap semantics.
12. **Preview fetcher.** Log the user agent and IP of the preview fetcher when a magic link is sent (shared with V2-02).

### Upstash

13. `set nx px` returns `"OK"` / `null`. The Lua release and extend work through `createScript`. With `automaticDeserialization: false`, the stored token round-trips byte-exact.

### Supabase

14. `select version()` is ≥ 15.1.1.61 and `'15 seconds'` schedules run on the Free plan (check `cron.job_run_details`).
15. pgcrypto `extensions.hmac` exists.
16. The Vault secrets are readable by the cron job's role.
17. The pg_net timeout is honoured.
18. The free project stays awake with only the daily Vercel cron and the tick: watch for 8 days, or accept Pro later.

### Vercel

19. Hobby `maxDuration = 300` takes effect on both routes.
20. `after()` continues after the 200, for at least 60s.
21. The pg_net 5s timeout vs cold start: does a request that pg_net times out still run on Vercel? Check the dispatch logs.
22. The Vercel Cron `GET` carries `Authorization: Bearer $CRON_SECRET`.

### End-to-end on a real iPhone

23. A burst of three gets one reply.
24. The "…" shows up instantly.
25. p95 reply time under 12s over 50 turns, measured from `messages.created_at` (in) to the first out.
26. Zero duplicate sends, checked with a `count(*) group by idempotency_key` sanity query.

---

## 13. Open questions (each has a default, so none block work)

| # | Question | Recommended default |
|---|---|---|
| 1 | Debounce in the `jobs` row instead of Upstash, which deviates from the brief (§2.1)? | **Yes:** jobs row for debounce, Upstash for the lease and rate limits |
| 2 | Default quiet hours: §3.15 says 22:00–08:00, §3.22 says "8am–9pm minimum" | **22:00–08:00 for iMessage; widened to 21:00–08:00 automatically on SMS/RCS channels** |
| 3 | May `urgent` alerts break quiet hours (for example, a midnight deadline moved at 10:30pm)? | **No.** Defer to quiet end. Users can later opt in with a preference (`urgent_in_quiet_hours`). |
| 4 | Do `requested` reminders ("remind me at 11pm") bypass quiet hours? | **Yes** (the user picked the time). They still respect pause and opt-out. |
| 5 | Enable Sendblue auto mark-read? | **Yes** (reads as attentive). Auto typing indicator **on**. |
| 6 | Subscribe to Sendblue `outbound` status webhooks? | **No** for now (cost and noise). Use the synchronous send response. Revisit if delivery analytics are needed. |
| 7 | Dev and prod share one Supabase project. The pg_cron tick (prod URL) could claim jobs created by local dev. | **Use a second free Supabase project or `supabase start` for dev.** Until then, a cross-claim is harmless. The provider is picked from `channels.provider`, and production refuses `dev`, so a dev channel's job fails and dead-letters instead of sending anything. Dev handles stay in the fictional `+1555-01xx` range. |
| 8 | Is the first-contact welcome a deterministic template or agent-written? | **Template** (guaranteed AI disclosure, $0), plus the agent for any real question in the same burst |
| 9 | Retention: also purge `signups` (phone, IP) 7 days after expiry, and `agent_runs` at 180 days? | **Yes to both.** Keep `llm_calls` (no PII) indefinitely. |
| 10 | Allow any inbound tapback ❤️/👍 on Aria's proposal to count as "yes"? | **Yes, if** sandbox check 4 shows tapbacks arrive. Pipeline: insert into `reactions`, then enqueue a `conversation_turn` with a synthetic inbound (`body = null`, `media = []`, plus `reactions` context) so V2-04 sees it. If they don't arrive, users just type "yes". |
| 11 | Turn handling for group chats (Aria added to a group)? | **Ignore** (log). The AI Agent plan can't create groups anyway. |
| 12 | Daily turn cap per user (cost guard)? | **200 turns a day**, then one "need a breather" bubble |
| 13 | Where the `cron.schedule` lives: migration (no-op until Vault is set) or a runbook? | **Migration** (§4) plus a runbook for the secrets only. Supersedes 002's "lands with V2-06" note. |
