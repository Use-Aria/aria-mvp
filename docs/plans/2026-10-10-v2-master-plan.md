# Aria V2 — Master Build Plan (integration of branch plans V2-03…V2-08 + web)

> **Status:** Final integration plan, 2026-10-10. Nothing here is implemented yet.
> **Precedence:** where this document and a branch plan disagree, **this document wins**. Branch plans remain the detailed reference for everything not overridden here (§2 lists every override).
> **Inputs:** `2026-10-10-v2-build-brief.md`, `…-v2-03-conversation-pipeline.md` (V2-03), `…-v2-04-agent-memory.md` (V2-04), `…-v2-05-canvas-timeline.md` (V2-05), `…-v2-06-reminders-briefing.md` (V2-06), `…-v2-07-google.md` (V2-07), `…-v2-08-syllabus-parser.md` (V2-08), `…-v2-web-surfaces.md` (web).
> **Schema:** `supabase/migrations/003_v2_build.sql` (consolidated delta; applies on top of 001+002).
> **Section refs** like "V2-05 §2.6" point into the branch plans.

---

## §1 Final contracts

### 1.0 Rules every task follows

1. **One owner per file.** §5 lists the owner of every file. A file can change owner only between waves.
2. **Frozen contract files.** Wave 0 (task 0.2) creates these files with final types. After that, **only the orchestrator** edits them, and only on a written request from a task:
   - `src/server/channels/types.ts`
   - `src/server/pipeline/types.ts`
   - `src/server/jobs/types.ts`
   - `src/server/jobs/kinds/index.ts`
   - `src/server/agent/types.ts`
   - `src/server/agent/tools/index.ts`
   - `src/server/agent/pending/types.ts`
   - `src/server/agent/pending/executors/index.ts`
   - `src/server/timeline/types.ts`
   - `src/server/integrations/google/gmail/types.ts`
   - `src/server/integrations/{canvas,google}/index.ts` (barrels)
   - `src/shared/scheduling-constraints.ts`
   - `src/shared/email-draft.ts`
3. **Stub rule (Wave 0).** Every cross-task export below exists after Wave 0, at its final path, with its final signature, and a header comment `// OWNER: <task id>`.
   - Read-only functions return neutral values: `[]`, `null`, `{ connected: false }`, or identity.
   - Mutators throw `notImplemented("<task id>")`, from `src/server/_stub.ts`.
   - The owning task replaces the body and **must not change the exported signature**.
   - Wave 4 gate: `grep -rn "notImplemented(" src/` returns only `_stub.ts`. Task 5.2 then deletes `_stub.ts`.
4. **Model-facing ids are aliases.**
   - Every id the model sees or sends is an `AliasTable` alias: a kind prefix plus 8 hex characters (§1.4).
   - Tools resolve aliases with `ctx.aliases.resolve(alias, kind)`. An alias not shown in this run resolves to `null`, and the tool returns `is_error`.
   - Raw UUIDs, Gmail ids and `t_`-prefix DB lookups are never accepted from the model.
5. **Evidence rule.** Every tool with `mutates: true` takes `evidence: EV` (V2-04 §9.2), across **all** branches. It must resolve to a user-authored inbound `m_`/`x_` alias in this run's batch. Proactive runs therefore fail closed.
6. **Untrusted rule.** All third-party text goes through `wrapUntrusted` (§1.8) before it reaches any LLM prompt. That covers email, Canvas titles and descriptions, external calendar titles, and syllabus content. Only user-authored chat text can create memories or trigger actions.
7. **Server-only.** Every `src/server/**` file starts with `import "server-only";`. Pure, client-safe code lives in `src/shared/**`.

### 1.1 Channels (`src/server/channels/`; owners 1.2 / 2.1)

`types.ts` (frozen) is **V2-03 §7 `channels/types.ts` verbatim**, with one change: `InboundMedia` gains optional fields (V2-08 ask).

```ts
export interface InboundMedia { url: string; kind: "image"|"pdf"|"audio"|"video"|"vcard"|"other";
  contentType?: string; filename?: string; size?: number }
// ReplyPlan — the ONE plan type for every producer (agent, briefing, reminders, alerts, connect notices):
export interface PlanReaction { targetMessageId: string; type: ReactionType; fallbackText?: string }
export interface PlanBubble  { text: string; replyToMessageId?: string }
export interface ReplyPlan   { reactions?: PlanReaction[]; bubbles: PlanBubble[]; link?: { url: string };
                               media?: { url: string; kind: "vcard"|"image"|"file" }[] }
// also: ProviderName, Service, ClassicTapback, ReactionType, ChannelCapabilities, ChannelContext,
//       OutboundTarget, SendInput, SendResult, InboundEvent, WebhookParse, ChannelProvider (V2-03 §7)
```

- **Reactions are a plan field.** There is no `react` tool.
- **Links render as their own bubble** (counted in the 3-bubble cap), because a lone URL gets the richest iMessage preview. V2-04's "append to the last bubble" is superseded.

`plan.ts` (1.2):

```ts
export function textPlan(texts: string[], link?: string | null): ReplyPlan;           // producers' helper
export function validatePlan(plan: ReplyPlan, opts: { appOrigin: string; interimSent?: boolean }): { plan: ReplyPlan; warnings: string[] };
export function isAllowedLink(url: string, appOrigin: string): boolean;               // appOrigin or https://mail.google.com/
export function mergeOutboxItems(items: OutboxItem[]): ReplyPlan;
```

`deliver.ts` (2.1). This merges V2-03 §7 and V2-06 §8:

```ts
export type DeliverPriority = "routine" | "urgent" | "requested";
export interface DeliverOptions {
  proactive: boolean;
  reason: string;                 // "briefing" | "reminder" | "deadline_nudge" | "due_change" | "email_alert" |
                                  // "canvas_connected" | "google_connected" | "syllabus_parsed" | "gmail_triage_digest" | ...
  dedupeKey?: string;             // REQUIRED when proactive (at-most-once via proactive_dedupe);
                                  // when !proactive it prefixes bubble idempotency keys ("<dedupeKey>:<i>")
  priority?: DeliverPriority;     // default "routine" when proactive. urgent: bypasses cap+bundling, respects quiet;
                                  // requested: bypasses quiet+cap. All respect opt-out + pause.
  channelId?: string;             // default: primary channel
  notBefore?: Date;
  expiresAt?: Date;               // if the earliest allowed send > expiresAt → suppressed:"expired" (checked synchronously)
  deferMode?: "persist" | "return"; // persist (default): outbox job re-applies guards later; return: caller re-plans
}
export type DeliverResult =
  | { status: "sent"; deliveryId: string; messageIds: string[] }
  | { status: "queued"; jobId: string; runAt: Date }
  | { status: "deferred"; until: Date }            // deferMode "return" only; nothing persisted
  | { status: "suppressed"; reason: "opted_out" | "no_channel" | "deleted" | "duplicate" | "expired" | "invalid_plan" }
  | { status: "failed"; error: string };
export function deliver(userId: string, plan: ReplyPlan, opts: DeliverOptions): Promise<DeliverResult>;
export function deliverReply(input: { userId: string; channelId: string; runId: string; plan: ReplyPlan; elapsedMs: number;
  trigger: "reply"|"interim"|"welcome"|"contact_card"|"command"|"fallback"; keyPrefix: string; signal?: AbortSignal;
  bypassOptOut?: boolean }): Promise<DeliverResult>;                     // pipeline-internal
export function flushOutbox(userId: string, jobId: string, items: OutboxItem[], now: Date): Promise<JobOutcome>;
```

Behaviour notes:

- A proactive item with `urgent` or `requested` priority that is allowed **now** is flushed inline, so the result is `sent`.
- A routine item is `queued`, because of bundling.
- `proactive: false` skips every guard except opt-out. Use it only for direct follow-ups to something the user did in this exchange: connect confirmations, the syllabus result, the triage digest.

`repo.ts` (2.1) also exports `redactInboundBodies(userId: string, messageIds: string[], redact: (body: string) => string): Promise<number>`. Task 3.4 uses it to scrub Canvas feed URLs.

### 1.2 Pipeline ↔ agent boundary (`src/server/pipeline/types.ts`, frozen)

```ts
import type { ChannelContext, InboundMedia, ReactionType, ReplyPlan } from "@/server/channels/types";
import type { ModelId } from "@/server/llm";
export interface InboundMessage  { id: string; body: string | null; media: InboundMedia[]; replyToMessageId: string | null; createdAt: Date }
export interface InboundReaction { id: string; targetMessageId: string; type: ReactionType; removed: boolean; createdAt: Date }
export interface IdentityState   { isNewUser: boolean; name: string | null; timezone: string;
                                   timezoneSource: "default" | "signup" | "user" | "inferred" }
export type AgentTrigger =
  | { kind: "inbound" }
  | { kind: "proactive"; reason: "email_alert" | "deadline_change" | "reminder" | "followup"; event: string /* pre-wrapped */ };
export interface AgentTurnInput {
  userId: string; runId: string; now: Date; timezone: string;
  channel: ChannelContext; identity: IdentityState; trigger: AgentTrigger;
  newMessages: InboundMessage[];          // this run's consumed inbound, oldest first ([] for proactive)
  inboundReactions: InboundReaction[];    // user tapbacks on Aria messages since the last run (x_ evidence)
  isFollowUpPass: boolean; welcomeSent: boolean; isEval: boolean;
  signal: AbortSignal;                    // aborts at run deadline − 30s or on lease loss
  interim: (text: string) => Promise<boolean>;  // false if the watchdog/tool already sent one
}
export interface AgentTurnResult { plan: ReplyPlan; model: ModelId | null /* null = ack fast path */;
                                   escalated: boolean; interimSent: boolean; costUsd: number }
export type RunAgentTurn = (input: AgentTurnInput) => Promise<AgentTurnResult>;
export class AgentUnavailableError extends Error { readonly retryable = true }
```

**`agent_runs` ownership:**

| Who | What |
|---|---|
| Pipeline (3.1) | Inserts the row (`status='running'`, `trigger`, `channel_id`, `input_message_ids`, `is_eval`). Sets `status`, `finished_at` and `error` at the end. |
| Agent (3.2) | Writes `model` (when the first LLM call starts, so `claim_escalation` counts it), `escalated`, `escalation_reason`, `iterations`, `llm_call_count`, `tool_calls`, `cost_usd`, `latency_ms`, `plan`. |
| Eval driver (5.1) | Inserts its own row. |

**Interim and watchdog.**
- The 8s watchdog lives in the **pipeline** (V2-03 §2.9, `pipeline/watchdog.ts`) and calls `input.interim`.
- `runAgentTurn` has no watchdog of its own. V2-04's `persona/interim.ts` and its §2.9(c) watchdog are dropped.
- The `send_interim` tool calls `ctx.interim.send`.

### 1.3 Jobs (`src/server/jobs/`; owner 1.1, contract frozen)

`types.ts` is **V2-03 §7 `jobs/types.ts` verbatim** (`JobContext`, `JobOutcome`, `JobHandler<S>`, `defineJobKind`), plus:

```ts
/** Throw from a handler → job goes straight to `dead` (no retry). */
export class PermanentJobError extends Error {}
```

`enqueue.ts`:

```ts
export type EnqueueMode = "keep" | "replace" | "debounce" | "append";
export interface EnqueueInput<K extends JobKind> { kind: K; userId?: string | null; runAt?: Date; payload?: JobPayload<K>;
  dedupeKey?: string; mode?: EnqueueMode /* default "replace" when dedupeKey */; maxDelayMs?: number }
export interface EnqueueResult { id: string; runAt: Date; dbNow: Date; created: boolean }
export function enqueueJob<K extends JobKind>(input: EnqueueInput<K>): Promise<EnqueueResult>;
/** pending → done (last_error='cancelled'). Any combination of filters (ANDed). Returns rows cancelled. */
export function cancelJobs(f: { ids?: string[]; dedupeKey?: string; dedupeKeyPrefix?: string; userId?: string; kinds?: JobKind[] }): Promise<number>;
```

- **Lock:** a global 330s lock (invocation hard cap 300s). There are no per-kind leases.
- **Attempts:** `maxAttempts` is set per kind via `defineJobKind({ maxAttempts })`.

**Kind registry** (`kinds/index.ts`, frozen, in this order). Every kind file exists as a stub after Wave 0.

| Kind (file `kinds/<kebab>.ts`) | Owner | Payload | Dedupe key | maxAttempts |
|---|---|---|---|---|
| `conversation_turn` | 3.1 | `{userId: uuid}` | `turn:<userId>` (debounce 2.5s, cap 8s) | 3 |
| `proactive_flush` | 2.1 | `{items: OutboxItem[]}` | `outbox:<userId>` (append) | 5 |
| `retention_purge` | 1.1 | `{}` | `retention_purge` (keep) | 3 |
| `noop` | 1.1 | `{note?: string}` | — | 1 |
| `memory_extract` | 3.3 | `{}` | `memx:<userId>` (run +30 min) | 3 |
| `conversation_summary` | 3.3 | `{}` | `sum:<userId>` | 3 |
| `account_purge` | 3.3 | `{userId: uuid}` (**job `user_id` null**, so the cascade can't delete the running job) | `purge:<userId>` | 3 |
| `canvas_sync` | 3.4 | `{reason?: "scheduled"\|"manual"\|"email_hint"}` | `canvas_sync:<userId>` | 5 |
| `reminder_fire` | 2.6 | `{reminderId: uuid, dueAt: iso}` | `reminder:<reminderId>` | 5 |
| `briefing_prepare` | 4.1 | `{targetAt: iso, localDate: date}` | `briefing_prep:<userId>` | 5 |
| `briefing_send` | 4.1 | `{localDate: date, regenerate?: boolean, kind?: "catchup"}` | `briefing_send:<userId>:<localDate>` | 5 |
| `timeline_changes` | 4.1 | `TimelineChangeBatchSchema` | `tlc:<userId>:<syncRunId>` | 5 |
| `google_post_connect` | 3.6 | `{}` | `google_post_connect:<userId>` | 3 |
| `gcal_sync` | 3.6 | `{reason: "push"\|"periodic"\|"connect"\|"manual"}` | `gcal_sync:<uid>` / `gcal_sync_periodic:<uid>` | 5 |
| `gcal_watch_renew` | 3.6 | `{}` | `gcal_watch_renew:<uid>` | 5 |
| `gmail_watch_renew` | 2.5 | `{}` | `gmail_watch_renew:<uid>` | 5 |
| `gmail_history_sync` | 2.5 | `{reason: "push"\|"periodic"\|"retry"}` | `gmail_sync:<uid>` / `gmail_sync_periodic:<uid>` | 5 |
| `gmail_triage_chunk` | 4.3 | `TriagePayload` (V2-07 §7.3) | `gmail_triage:<uid>:<runId>:<phase>:<offset>` | 3 |
| `syllabus_parse` | 3.5 | V2-08 §9 (`messageId`, `mediaIndex`, `courseHint?`, `replace`) | `syllabus:<messageId>:<mediaIndex>` | 2 |

Until task 4.1 lands, `timeline_changes` is a stub whose handler returns `done`. That keeps Canvas batches from dead-lettering, as V2-05 Q16 asked.

### 1.4 Agent tools (`src/server/agent/`)

`types.ts` (frozen):

```ts
export type AliasKind = "m" | "x" | "t" | "a" | "p" | "f" | "r" | "e" | "s";
/** alias = `${kind}_` + first 8 hex (uuid without dashes, or sha256(id) for non-uuid ids like Gmail ids);
 *  +2 hex on collision. Attachments: `m_xxxxxxxx:<index>`. */
export interface AliasTable { mint(kind: AliasKind, id: string): string; resolve(alias: string, kind?: AliasKind): string | null; shown(alias: string): boolean }
export interface LinkSlots { add(url: string): string /* "L1" */; resolve(handle: string): string | null }
export type UntrustedSource = "email" | "canvas" | "calendar" | "syllabus" | "web";
export interface ToolCtx {
  userId: string; runId: string; now: Date; timezone: string;
  channel: ChannelContext; trigger: AgentTrigger;
  aliases: AliasTable;
  evidence: ReadonlySet<string>;   // m_/x_ aliases of this run's user-authored batch
  userText: string;                // concatenated user-authored inbound text of this run (V2-07 recipient check)
  taint: { readonly tainted: boolean; mark(source: UntrustedSource): void };
  links: LinkSlots;
  interim: { readonly sent: boolean; send(text: string): Promise<boolean> };
  signal: AbortSignal;
  log(event: string, data?: Record<string, string | number | boolean>): void;
}
```

`tools/define.ts` (Wave 0 writes a minimal real version; 1.3 owns it from then on) is **V2-04 §8.3 verbatim**: `ToolResult`, `ToolSpec<S>`, `AgentTool`, `defineTool`, `requireEvidence`.

**Registry `tools/index.ts`** (frozen, deterministic order). Each tool is one file, `tools/<kebab>.ts`, and exists as a stub after Wave 0. The zod inputs come from the cited plan sections, with the overrides noted.

| # | Tool | Owner | Input source | Notes |
|---|---|---|---|---|
| 1 | `send_interim` | 3.3 | V2-04 §9.2 | |
| 2 | `send_link` | 3.3 | V2-04 §9.2 | kinds: week→`view`; setup / connect_canvas→`setup`; settings→`setup` with target `/settings`; connect_google→`connect_google`; email_draft→`email_draft` with target `/email/<id>` |
| 3 | `get_agenda` | 3.3 | V2-05 §9.3 | `range` enum, `include_done` |
| 4 | `search_deadlines` | 3.3 | V2-05 §9.3 | |
| 5 | `mark_done` | 3.3 | V2-05 §9.3 | `item: t_ alias`, `status`, `evidence` |
| 6 | `connect_canvas` | 3.4 | V2-05 §9.2 | + `evidence` |
| 7 | `canvas_status` | 3.4 | V2-05 §9.2 | |
| 8 | `create_reminder` | 2.6 | V2-06 §9 | `before_item.itemId` → `item: t_ alias`; + `evidence` |
| 9 | `list_reminders` | 2.6 | V2-06 §9 | returns `r_` aliases |
| 10 | `cancel_reminder` | 2.6 | V2-06 §9 | `reminder: r_ alias`; + `evidence` |
| 11 | `update_notification_settings` | 2.6 | V2-06 §9 | owns briefing time/on-off + nudge offsets; + `evidence` |
| 12 | `find_free_slots` | 4.2 | V2-07 §9.2 | returns `s_` aliases |
| 13 | `create_block` | 4.2 | V2-07 §9.2 | accepts `slot: s_ alias` **or** explicit `start`/`end`; + `evidence` |
| 14 | `move_block` | 4.2 | V2-07 §9.2 | `block: t_ alias`; + `evidence` |
| 15 | `delete_block` | 4.2 | V2-07 §9.2 | `block: t_ alias`; + `evidence` |
| 16 | `search_email` | 4.3 | V2-07 §9.2 | returns `e_` aliases |
| 17 | `read_email` | 4.3 | V2-07 §9.2 | `email: e_ alias` |
| 18 | `draft_email` | 4.3 | V2-07 §9.2 | `email: e_ alias`; `revise: a_ alias`; + `evidence` |
| 19 | `read_syllabus` | 3.5 | V2-08 §9 | `attachment: "m_xxxxxxxx:<i>"`; + `evidence` |
| 20 | `syllabus_info` | 3.5 | V2-08 §9 | |
| 21 | `recall` | 3.3 | V2-04 §9.2 | |
| 22 | `list_memory` | 3.3 | V2-04 §9.2 | |
| 23 | `propose_preference` | 3.3 | V2-04 §9.2 | + nullable `constraint` (`ConstraintPrefSchema`, §1.17) |
| 24 | `confirm_preference` | 3.3 | V2-04 §9.2 | |
| 25 | `forget` | 3.3 | V2-04 §9.2 | facts are **hard-deleted** |
| 26 | `update_profile` | 3.3 | V2-04 §9.2 | fields `name` / `school` / `timezone` only. Timezone sets `timezone_source='user'` and calls `onUserScheduleSettingsChanged`. |
| 27 | `confirm_action` | 3.3 | V2-04 §9.2 | |
| 28 | `cancel_action` | 3.3 | V2-04 §9.2 | |
| 29 | `pause` | 3.3 | V2-04 §9.2 | sole pause tool |
| 30 | `sign_out_everywhere` | 3.3 | V2-04 §9.2 | |
| 31 | `request_account_deletion` | 3.3 | V2-04 §9.2 | |

**Registry test** (owned by 1.3) enforces:
- names and order equal this table
- deterministic schemas
- strict tools ≤ 16
- optional params across strict schemas plus the reply format ≤ 20
- every `mutates` tool has `evidence`
- descriptions ≥ 60 characters

### 1.5 Pending actions (`src/server/agent/pending/`)

`types.ts` (frozen):

```ts
export type PendingKind = "send_email" | "delete_account";
export type PendingStatus = "pending" | "executing" | "done" | "failed" | "cancelled" | "expired";
export interface ExecContext { userId: string; actionId: string; via: "chat" | "web"; now: Date }
export interface PendingActionExecutor<P extends z.ZodType = z.ZodType> {
  kind: PendingKind; payload: P; ttlMs: number;
  describe(p: z.output<P>): string;
  execute(ctx: ExecContext, p: z.output<P>): Promise<{ ok: true; summary: string; result?: Record<string, JsonValue> } | { ok: false; error: string; retryable: boolean }>;
  /** For rows stuck in `executing` > 5 min: decide whether the side effect already happened (send_email: sent-folder lookup). */
  recover?(ctx: ExecContext, p: z.output<P>): Promise<"done" | "not_done">;
}
export function definePendingAction<P extends z.ZodType>(e: PendingActionExecutor<P>): PendingActionExecutor<P>;
```

`executors/index.ts` (frozen) holds `EXECUTORS = [deleteAccountExecutor /*3.3*/, sendEmailExecutor /*4.3*/]`.

`actions.ts` (owner 3.3) is the **one path for chat and web**:

```ts
export function createPendingAction(ctx: ToolCtx, i: { kind: PendingKind; payload: unknown; summary: string; supersedes?: string }): Promise<{ id: string; alias: string }>;
export function listOpenActions(userId: string): Promise<OpenAction[]>;
export function getPendingAction(userId: string, id: string): Promise<PendingActionView | null>;   // web §8 shape; status = PendingStatus
export function revisePendingAction(userId: string, id: string, expectedVersion: number, patch: Record<string, unknown>, via: "chat" | "web"):
  Promise<{ ok: true; version: number } | { ok: false; code: "not_found" | "not_pending" | "expired" | "version_conflict" }>;
/** Atomic pending→executing (version + expiry + same-run guards), run executor, →done|failed. At-most-once. */
export function confirmPendingAction(userId: string, id: string, o: { via: "chat" | "web"; expectedVersion?: number; runId?: string }):
  Promise<{ ok: true; summary: string; result?: Record<string, JsonValue> } |
          { ok: false; code: "not_found" | "not_pending" | "expired" | "version_conflict" | "same_run" | "executor_failed" | "google_disconnected" }>;
export function cancelPendingAction(userId: string, id: string, via: "chat" | "web"): Promise<{ ok: true } | { ok: false; code: "not_found" | "not_pending" }>;
```

- `same_run`: the chat path passes `runId`, and an action created in that same run is refused.
- A web confirm posts a confirmation into the chat thread via `deliver(…, { proactive: false, reason: "action_confirmed_web", dedupeKey: "act:<id>" })`.

### 1.6 LLM module (`src/server/llm/`; owner 1.3)

```ts
export type Route = "chat" | "escalate" | "classify" | "memory" | "summary" | "briefing" | "syllabus" | "draft" | "eval_judge";
export type ModelId = "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";
export interface RouteConfig { model: ModelId; maxTokens: number; effort: "low" | "medium" | "high"; thinking: "adaptive" | "disabled"; timeoutMs: number; staticTtl: "5m" | "1h" }
export const ROUTES: Record<Route, RouteConfig>;
export const PRICING: Record<ModelId, { in: number; cacheRead: number; cacheWrite: number; out: number }>;  // + opus 4/0.2/5/20
export interface UsageSummary { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; thinkingTokens: number; costUsd: number }
export interface LlmLogMeta { userId?: string; runId?: string; jobId?: string; iteration?: number; meta?: Record<string, JsonValue> }
export interface LlmRequest { /* V2-04 §7.1 LlmRequest */ route: Route; model?: ModelId; system: string; tools?: Anthropic.Tool[];
  messages: Anthropic.MessageParam[]; outputFormat?: Anthropic.JSONOutputFormat; toolChoice?: Anthropic.ToolChoice;
  historyBreakpointIndex?: number; autoCacheTail?: boolean; log: LlmLogMeta; signal?: AbortSignal }
export interface LlmResponse { /* V2-04 §7.1 */ model: ModelId; content: Anthropic.ContentBlock[]; text: string; stopReason: Anthropic.StopReason | null;
  refusal: Anthropic.RefusalStopDetails | null; usage: UsageSummary; latencyMs: number; requestId: string | null }
export function callModel(req: LlmRequest): Promise<LlmResponse>;                       // logs llm_calls
export function runModel(input: RunInput & { log?: LlmLogMeta }): Promise<RunResult>;  // existing signature, now logs
export function runStructured<T>(i: { route: Route; system: string; user: string | Anthropic.MessageParam[];
  schema: z.ZodType<T>; log?: LlmLogMeta; signal?: AbortSignal; maxTokens?: number }): Promise<{ data: T; usage: UsageSummary; model: ModelId; stopReason: string | null }>;
export function recordLlmCall(r: { route: Route; model: string; usage: UsageSummary; latencyMs: number; provider?: string;
  stopReason?: string | null; error?: string; requestId?: string } & LlmLogMeta): Promise<void>;   // best-effort, never throws
export function costFor(model: string, u: Omit<UsageSummary, "costUsd" | "thinkingTokens">): number;  // (= V2-08's costForModel)
export class LlmUnavailableError extends Error { readonly retryable = true; status?: number }
export class LlmBadRequestError extends Error {}
export class LlmRefusalError extends Error { category: string | null }               // runStructured only
```

`ROUTES`:

| Route | Model | Effort / thinking | maxTokens | Other |
|---|---|---|---|---|
| chat | Haiku | low / adaptive | 2048 | static TTL 1h, 25s timeout |
| escalate | Sonnet | low / adaptive | 2048 | TTL 5m |
| classify | Haiku | low / **disabled** | 4096 | |
| memory | Haiku | medium | 2048 | |
| summary | Haiku | low | 512 | |
| briefing | Haiku | medium | **2048** | (accepted ruling) |
| syllabus | Sonnet | medium | 16000 | Python owns the actual calls; TS only prices them |
| draft | Sonnet | low | 1500 | outside the 10% escalation cap; soft cap 20/day |
| eval_judge | Haiku | low | 512 | |

### 1.7 Memory API (`src/server/memory/index.ts`; owner 2.2, extraction/summary 3.3)

```ts
export function renderProfileBlock(user: Tables<"users">, profile: Tables<"user_profile"> | null): string;   // pure, ≤400 tok
export function refreshProfileBlock(userId: string): Promise<void>;
export function loadProfileBlock(userId: string): Promise<string>;
export interface ClassTime { course: string; days: Weekday[]; start: string; end: string; location?: string }
export function getProfile(userId: string): Promise<{ school: string | null; courses: string[]; classTimes: ClassTime[] }>;
export interface PreferenceRow { id: string; key: string; category: string | null; statement: string; status: string; source: string | null; constraintJson: unknown | null; validFrom: Date }
export function listActivePreferences(userId: string): Promise<PreferenceRow[]>;
export function getOpenQuestion(userId: string): Promise<PreferenceRow | null>;
export function listQueuedProposals(userId: string, limit?: number): Promise<PreferenceRow[]>;   // V2-06 briefing: ≤1 per briefing
export function insertProposal(a: { userId: string; key: string; category: string; statement: string; status: "proposed" | "queued"; runId: string; evidenceMessageId: string | null; constraintJson?: unknown }): Promise<PreferenceRow>;
export function decidePreference(userId: string, prefId: string, d: "confirm" | "reject"): Promise<PreferenceRow>;   // rpc decide_preference
export function recallFacts(userId: string, query: string, limit?: number): Promise<{ id: string; content: string; createdAt: Date; score: number }[]>;
export function listRecentFacts(userId: string, limit: number): Promise<{ id: string; content: string; createdAt: Date }[]>;
// web (web §8 shapes verbatim): listMemory, editPreference, removePreference, answerProposal, editFact,
// deleteFact (HARD delete), setProfileSchool
```

Persona tone is read via `parsePersonaPrefs` (§1.17). The V2-04 `persona.tone` preference key is dropped.

### 1.8 Untrusted wrapper + register (`src/server/agent/untrusted.ts`, `src/shared/register.ts`; owner 0.3)

```ts
export function wrapUntrusted(a: { source: UntrustedSource; id?: string; body: string | Record<string, string>; maxChars?: number }): string;
// → <untrusted source="email" id="e_…">…</untrusted>; reserved tags neutralized (‹), control chars stripped, length-capped
export function neutralizeTags(text: string): string;
// src/shared/register.ts (pure)
export interface RegisterHint { avgWords: number; lowercaseShare: number; emojiRate: number; slang: string[]; formal: boolean }
export function computeRegisterHint(userTexts: string[]): RegisterHint;
export function registerClass(h: RegisterHint): "casual" | "neutral";      // interim lines + templates
```

This is the only wrapper. V2-06's `<untrusted_data>`, V2-07's `<untrusted_email>` / positional `wrapUntrusted`, and V2-08's `(label, data)` form are all superseded.

### 1.9 Timeline (`src/server/timeline/`; owner 2.3)

- `types.ts` (frozen) is **V2-05 §7.3 `types.ts` verbatim**: `TimelineSource`, `TimelineKind`, `TimelineStatus`, `TimelineItemInput`, `TimelineUpsert`, `TimelineItem`, `Urgency`, `TimelineItemView`, `TimelineChangeSchema`, `TimelineChangeBatchSchema`, `TimelineChange(Batch)`, `Delivery`, `SnapshotScope`, `ApplyResult`, `DayLoad`.
- Plus `type TimelineLike = Pick<TimelineItemView, "source" | "kind" | "title" | "course" | "dueAt" | "startsAt" | "allDay" | "allDayDate">` for V2-08's dedupe.
- `index.ts` is **V2-05 §8.1 verbatim**:

  | Group | Functions |
  |---|---|
  | Writes | `applySnapshot`, `replaceSourceWindow`, `upsertTimelineItem`, `deleteTimelineItems`, `upsertTimelineItems`, `pruneTimelineItems`, `setTimelineItemStatus`, `markItemDone`, `rebaseTimeline` |
  | Reads | `listTimeline` (both call styles), `listItems`, `listTimelineForRange`, `searchTimeline`, `getTimelineItem`, `resolveItemRef` (non-agent callers only), `getDayLoads`, `getWeekLoad`, `summarizeUpcoming`, `listCourses`, `termHintForCourse` |
  | Pure re-exports | `urgencyScore`, `computeUrgency`, `dayLoads`, `weekLoadLevel`, `renderTimelineForModel`, `resolveRange`, `toView`, `classifyDelivery` |

- **Change batch:** V2-05 §8.3 (schema, transport, `deliveryHint` table) is final. After every committed write with changes, a `timeline_changes` job is enqueued. Status changes call the subscribers synchronously.
- `hooks.ts`: `TIMELINE_STATUS_SUBSCRIBERS` is pre-wired in Wave 0 to a **lazy import**: `async (u, b, n) => (await import("@/server/alerts/timeline-changes")).handleTimelineChanges(u, b, n)`. This avoids the import cycle.
- `listTimeline` calls `collapseSyllabusDuplicates` (§1.13) once.

### 1.10 Time zones (`src/shared/time/tz.ts`; owner 0.3, real implementation in Wave 0)

It is **V2-06 §7 `tz.ts` verbatim**:
- `LocalDate`, `LocalTime`, `LocalDateTime`, `Weekday`, `DEFAULT_TIME_ZONE`
- `isValidTimeZone`, `safeTimeZone`, `offsetMinutes`, `toLocal`, `zonedToUtc`, `localDateOf`, `addLocalDays`, `weekdayOf`, `compareLocalDate`, `formatLocalDate`, `parseHHMM`, `parseLocalDateTime`, `isInDailyWindow`, `formatForChat`, `formatForTool`
- `zonedToUtc` is gap→forward, overlap→earlier, and returns `{instant, adjusted}`.

It adds:

```ts
export function parseLocalDate(s: string): LocalDate | null;                 // "YYYY-MM-DD"
export function startOfLocalDay(instant: Date, tz: string): Date;            // V2-03, V2-07
export function localDatesBetween(start: Date, end: Date, tz: string): LocalDate[];   // V2-07 slot iteration
export function formatTimeRange(start: Date, end: Date, tz: string, now: Date): string; // "Tue Oct 14, 4–5:30pm" (V2-07 formatSlot)
```

This is the **only** time-zone module. V2-03's `src/shared/tz.ts` and V2-07's `calendar/time.ts` are not built.

### 1.11 Canvas (`src/server/integrations/canvas/index.ts` barrel; owner 3.4, pure parts 1.4)

These are **V2-05 §7.2 verbatim**:
- `connectCanvas({userId, rawUrl, schoolName?, via?, now?}) → ConnectResult`
- `disconnectCanvas(userId)`
- `getCanvasStatus(userId, now?) → CanvasStatusView`
- `requestCanvasSync(userId, reason)`
- `runCanvasSync(userId, opts)`
- types `CanvasConnectError`, `ConnectResult`, `CanvasStatusView`

The web calls `connectCanvas` from a server action. **No `/api/canvas/connect` route is built.** The shared pure modules are V2-05 §7.1 (`universities.ts`, `canvas-url.ts`, `canvas-guide.ts`).

### 1.12 Google (`src/server/integrations/google/`)

Barrel `index.ts` (frozen):

```ts
export type GoogleFeature = "calendar_read" | "calendar_write" | "gmail_read" | "gmail_send";
export type GoogleConnectStatus = "connected" | "missing_scopes" | "denied" | "admin_blocked" | "stale" | "expired" | "account_in_use" | "error";
export type GoogleStatusView =
  | { connected: false; reason: "none" | "revoked" | "error" }                // revoked/error → web shows "needs reconnect"
  | { connected: true; email: string; features: GoogleFeature[]; canReadMail: boolean; canSendMail: boolean;
      canReadCalendar: boolean; canWriteAriaCalendar: boolean; connectedAt: Date; triage?: { running: boolean; total?: number } };
export { getGoogleStatus } from "./status";                                   // 2.4
export { disconnectGoogle } from "./disconnect";                              // 3.6: (userId, {reason: "user"|"account_deleted"}) => Promise<{revoked: boolean}>
export { listEmailItemsForBriefing, markEmailItemsSurfaced } from "./gmail/alerts";   // 4.3 (V2-07 §7.3)
export { readBusy } from "./calendar/busy";                                   // 4.2
```

Internal cross-task contracts. Each is stubbed in Wave 0; the signatures are V2-07 §7.1/§7.3 verbatim.

| File | Owner | Exports |
|---|---|---|
| `http.ts` | 2.4 | `googleFetch`, `googleFetchNoContent` |
| `store.ts` | 2.4 | `getGoogleIntegration`, `findIntegrationByAccountEmail`, `findIntegrationByChannelId`, `updateGoogleIntegration` |
| `tokens.ts` | 2.4 | `getGoogleAccess`, `markGoogleUnavailable` |
| `errors.ts` | 2.4 | the three error classes |
| `gmail/types.ts` | frozen | `EmailMeta`, `Address`, `PrefilterHint`, `ClassifiedEmail`, `BriefingEmailItem`, `TriagePayload` |
| `gmail/sync.ts` | 2.5 | `startGmailWatch`, `renewGmailWatch`, `stopGmailWatch(userId)` |
| `gmail/classify.ts` | 4.3 | `classifyIngested(userId, items: {id: string; meta: EmailMeta; hint: PrefilterHint}[]): Promise<ClassifiedEmail[]>`. Gmail ingest (2.5) calls it; the stub returns `[]`. |
| `gmail/alerts.ts` | 4.3 | `alertHighImportance(userId, items)` + briefing accessors. The stub is a no-op / `[]`. |
| `gmail/triage.ts` | 4.3 | `startTriage(userId)` (called by post-connect 3.6) |

**OAuth start is `GET /api/google/oauth`** (§2 C20). It requires a `fresh_setup` session and `Sec-Fetch-Site ∈ {same-origin, none}`, sets the encrypted PKCE/nonce cookie and the HMAC state (V2-07 §2.3), then 303s to Google with `Cache-Control: no-store`.
- `/setup` links to it with a plain `<a>` (no prefetch).
- The callback always 303s to `/setup?google=<GoogleConnectStatus>`.
- Disconnect is a web server action calling `disconnectGoogle`. There is no `/api/google/disconnect` route.

### 1.13 Syllabus (`src/server/integrations/syllabus/index.ts`; owner 3.5)

The **parser HTTP contract v1 is V2-08 §8.1 verbatim**: `POST /v1/parse-syllabus`, HMAC headers `x-aria-timestamp` and `x-aria-signature: v1=<hex>`, error table.

```ts
export function collapseSyllabusDuplicates<T extends TimelineLike>(items: readonly T[], timezone: string): T[]; // W0 stub: identity
export function getSyllabusSignals(userId: string): Promise<SyllabusSignals[]>;                                // W0 stub: []
export function runSyllabusIntake(input: IntakeInput): Promise<IntakeOutcome>;
export function findSyllabusByCourse(userId: string, query: string): Promise<SyllabusRow | null>;
export function listSyllabi(userId: string): Promise<SyllabusSummary[]>;
export function callParseSyllabus(req: ParseSyllabusRequest, opts?: { fetchImpl?: typeof fetch }): Promise<ParseSyllabusResponse>; // client.ts
```

`src/shared/course-key.ts` (owner 0.3): `courseKey(input)` and `sameCourse(a, b)`. The vectors live in `tests/fixtures/contract/course_key_vectors.json`, and the Python tests read the same file.

### 1.14 Reminders, briefing, alerts

| File | Owner | Exports |
|---|---|---|
| `src/server/reminders/service.ts` | 2.6 | V2-06 §7 `service.ts` verbatim: `createReminder`, `listReminders`, `cancelReminder`, `ensureAutoNudges`, `recomputeAnchored`, `cancelForItem`, `recomputeRecurring`, `reconcileReminderJobs` |
| `src/server/briefing/scheduler.ts` | **2.6** (moved from V2-06 T6) | `scheduleNextBriefing(userId, now?)`, `onUserScheduleSettingsChanged(userId, now?)` |
| `src/server/briefing/notes.ts` | **2.6** | `addBriefingNote(userId: string, kind: BriefingNoteKind, payload: Record<string, JsonValue>, o?: {itemId?: string; dedupeKey?: string}): Promise<void>` |
| `src/server/proactive/settings.ts` | 2.6 | `getNotificationSettings`, `updateNotificationSettings` (V2-06 §7) |
| `src/server/alerts/timeline-changes.ts` | 4.1 | `handleTimelineChanges(userId, batch, now): Promise<{alerted: number; noted: number}>` |

`onUserScheduleSettingsChanged` is **the** hook (web's `onSchedulePrefsChanged` and V2-04's `recomputeNextBriefing` are names for it). It does all of the following:
- recomputes `next_briefing_at` and replaces the prepare job
- calls `rebaseTimeline(userId, tz)` on a timezone change
- calls `recomputeRecurring`
- re-places auto-nudges

Its callers are `update_profile`, `update_notification_settings`, the `/setup` schedule actions, and first contact.

### 1.15 Security: links, sessions, guards

`link-policy.ts`. Wave 0.2 makes the type and table edits; 1.6 owns the file afterwards.

| Purpose | TTL | Scope | Default target |
|---|---|---|---|
| `view` | 15m | view | `/week` |
| `setup` | 30m | setup | `/setup` |
| `connect_google` | 20m | setup | `/setup` |
| `email_draft` | 60m | view | `/email/<id>` |
| **`digest`** | **12h** | view | `/week` |

- `digest` is used only by briefing links (accepted ruling).
- `MintInput.preview.kind ∈ "week" | "setup" | "email" | "settings"`.
- `RECENT_SESSION_MS = 60 min`.

`sessions.ts` (1.6 adds): `revokeSession(rawId)`, `clearedSessionCookie()`, `currentSessionRaw()`. These join the existing `currentSession`, `canChangeIntegrations` and `revokeAllSessions`.

`src/server/web/guard.ts` (1.6) is **web §7.1 verbatim**:
- `type Need = "any" | "recent" | "fresh_setup"`
- `requireViewer()`
- `requireActionViewer(need)`: requires `Origin === appOrigin()` and returns `{ok:false, code: "signed_out" | "needs_recent_link" | "needs_fresh_link" | "bad_origin"}`
- `freshUntil`, `isRecent`

The freshness matrix is web §2.3.

### 1.16 Account (`src/server/account/`; owner 4.6)

```ts
export function deleteAccount(userId: string, o: { via: "web" | "chat" | "job" }): Promise<{ ok: true; googleRevoked: boolean }>;  // web §7.6 order
export function collectAccountExport(userId: string): Promise<AccountExport>;
```

- **Chat path:** the `delete_account` executor (3.3) sets `users.deleted_at`, calls `revokeAllSessions`, and enqueues `account_purge` at +2 min. That job calls `deleteAccount(…, {via:"job"})`.
- **Web path:** calls `deleteAccount` immediately.
- The pipeline ignores users whose `deleted_at` is set.
- V2-04's `ACCOUNT_DELETION_HOOKS` list is dropped. `deleteAccount` calls `disconnectGoogle` and `disconnectCanvas` directly.

### 1.17 Shared pure modules

| File | Owner | Contents |
|---|---|---|
| `src/shared/persona-prefs.ts` | 1.6 | web §7.3: `tone: "mirror" \| "casual" \| "polished"`, default mirror, `parsePersonaPrefs`. Plus `templateRegister(prefs, recentUserTexts): "casual" \| "neutral"` (polished→neutral, casual→casual, mirror→`registerClass(computeRegisterHint(...))`). |
| `src/shared/scheduling-constraints.ts` | frozen | `WeekdaySchema`, `ConstraintSchema` (V2-07 §2.7 union), `ConstraintPrefSchema = z.object({ applies_to: z.array(z.string()).min(1), constraint: ConstraintSchema.nullable(), waking: z.object({start, end}).nullable(), signoff: z.string().nullable() })` (stored in `user_preferences.constraint_json`) |
| `src/shared/email-draft.ts` | frozen | `SendEmailPayload` = V2-07 §9.2 (snake_case, `v: 1`) plus `original_rfc822_id?: string` (web permalink). The web edits only `subject` and `body_text`; recipients are read-only on the web. |

### 1.18 HTTP routes and pages (owners)

| Route | Owner | Route | Owner |
|---|---|---|---|
| `POST /api/channels/sendblue` | 2.1 | `GET /api/google/oauth`, `GET /api/google/callback` | 3.6 |
| `POST /api/channels/dev` (404 in prod) | 2.1 | `POST /api/google/calendar-push` | 3.6 |
| `POST,GET /api/jobs/dispatch` | 1.1 | `POST /api/google/gmail-push` | 2.5 |
| `GET /api/cron/daily` | 4.1 | `POST /api/syllabus/upload` | 3.5 |
| `GET /aria.vcf` | 1.2 | `POST /api/me/export` | 4.6 |
| `/api/signup`, `/api/session/redeem` (exist) | 1.6 | | |

**Pages:**

| Page(s) | Owner |
|---|---|
| `/`, `/m`, `/link-expired`, `(app)/layout`, `signed-out`, `account-deleted`, `not-found`, `global-error`, `privacy`, `terms` | 1.6 |
| `(app)/setup/page.tsx`, `src/server/web/setup-data.ts` | 1.6 (renders every section via placeholder components with final props) |
| `ScheduleForm.tsx`, `ToneForm.tsx`, `setup/actions.ts`, `(app)/week/**` | 4.4 |
| `CanvasConnect.tsx`, `GoogleConnect.tsx`, `setup/integration-actions.ts`, `(app)/email/[id]/**` | 4.5 |
| `SyllabusUpload.tsx` | 3.5 |
| `(app)/settings/**` | 4.6 |

---

## §2 Conflict log

| # | Conflict | Resolution | Superseded |
|---|---|---|---|
| C1 | Debounce store: brief says Upstash; V2-03 says the `jobs` row | **`jobs` row** (`enqueue_job` debounce mode). Upstash holds the per-user run lease (DB fallback in dev) and rate limits. Flagged to Daniel (§6 D1). | brief "Redis for debounce" |
| C2 | Reply plan shape: V2-03 (`bubbles: {text, replyToMessageId?}[]`, reactions `{targetMessageId}`) vs V2-04 (`bubbles: string[]`, single `replyToMessageId`, `link {url, purpose}`) vs assumptions in V2-06/07/08 | **V2-03's `ReplyPlan`** for everyone, plus a `textPlan()` helper. V2-04's `resolvePlan` maps `reply_to` to the first bubble. The link is its own bubble. | V2-04 §8.1 `ReplyPlan`; V2-06 §8 consumed item 2; V2-07 §8.2 ReplyPlan assumption |
| C3 | `react` tool (brief/spec) vs plan field (V2-04, V2-03) | **Plan field.** No `react` tool. | brief tool list |
| C4 | `AgentTurnInput`/Result shapes differ (V2-03 §7 vs V2-04 §8.1); who creates `agent_runs` | **Merged (§1.2).** The pipeline creates the run; the agent writes stats. | V2-04 §8.1 types, `runs.ts createAgentRun` (becomes `updateRunStats`) |
| C5 | Watchdog + interim pools duplicated (V2-03 §2.9 and V2-04 §2.9c) | **The pipeline owns the watchdog and interim lines.** The register heuristic moves to `src/shared/register.ts`. | V2-04 `persona/interim.ts`, watchdog in `runAgentTurn` |
| C6 | Duplicate tools: `send_interim` (V2-03 T8 & V2-04), `pause_messages` vs `pause`, `set_identity` vs `update_profile`, `update_profile.briefing_time` vs `update_notification_settings.briefingTime` | **V2-04 owns `send_interim`, `pause`, `update_profile`** (name/school/timezone; timezone sets `timezone_source='user'`). Briefing settings live **only** in `update_notification_settings`. | V2-03 §9 tools + T8; V2-04 §9.2 `update_profile.briefing_time` |
| C7 | Three tz implementations (V2-03 `src/shared/tz.ts`, V2-06 `src/shared/time/tz.ts`, V2-07 `calendar/time.ts`) | **V2-06's `src/shared/time/tz.ts`** plus 4 additions (§1.10), built for real in Wave 0. | V2-03 §7 tz.ts; V2-07 §7.2 `calendar/time.ts`; V2-05 T0 |
| C8 | Quiet-hours columns: `quiet_start/quiet_end` (V2-03, web) vs `quiet_hours_start/end` (V2-06) | **`quiet_start` / `quiet_end`** | V2-06 §4 quiet columns |
| C9 | `deliver` options/results: V2-03 (`dedupeKey`, `priority`, `expiresAt`, sent/queued/suppressed) vs V2-06 (`idempotencyKey`, `urgent`/`requested` booleans, `notAfter`, `deferMode`, sent/duplicate/deferred/expired/blocked) vs V2-05 (`idempotencyKey`) | **Merged (§1.1):** names `dedupeKey`, `priority`, `expiresAt`; `deferMode` adopted from V2-06; results sent/queued/deferred/suppressed/failed. | V2-06 §8 consumed item 4; V2-05 §8.4 `idempotencyKey` |
| C10 | `JobHandler` signature: V2-03 `defineJobKind`, V2-04 `(job)=>void`, V2-06 `(job, ctx)`, V2-07 `(job)` + `PermanentJobError` + `cancelPendingJobs`, V2-06 `cancelJobByDedupeKey` | **V2-03's `defineJobKind`**, plus `PermanentJobError`, plus one `cancelJobs(filters)`. | V2-04 §8.5, V2-06 §8 consumed items 1–3, V2-07 §8.2 jobs row |
| C11 | `syllabus_parse` lease ≥ 360s (V2-08) vs the global 330s lock | **330s is enough**, because the invocation is hard-capped at 300s. `maxAttempts` is 2. No per-kind lease. | V2-08 §2.1 consequence, §8.3 |
| C12 | Model-facing ids: V2-04 `t_`+6 hex aliases; V2-05 `t_`+8 hex DB-prefix refs; V2-06 raw uuids; V2-07 uuid `block_id` and raw Gmail ids; V2-08 `<uuid>:<i>` | **All are `AliasTable` aliases, prefix + 8 hex** (§1.0 rule 4). `resolveItemRef` serves only non-agent callers. | V2-04 §2.5 "6 hex"; V2-06 §9 `itemId`/`reminderId` uuid; V2-07 §9.2 `block_id`/`email_id`; V2-08 §9 `attachmentId` |
| C13 | `TimelineItemView`: V2-04 (ISO strings, 4 urgencies) vs web `TimelineViewItem` vs V2-05 | **V2-05's superset** (Dates, 7 urgencies). Tools serialize; the web maps it. | V2-04 §8.5 view type; web §8 `TimelineViewItem` |
| C14 | Untrusted wrapper: signatures (object / positional / `(label, data)`) and tag names | **V2-04's object form, one `<untrusted>` tag** | V2-06 §2.5 `<untrusted_data>`; V2-07 §7.1 `untrusted.ts`, `<untrusted_email>`; V2-08 §8.3 |
| C15 | Pending actions: status sets (V2-04 executing/done vs web confirmed/sent), `confirmed_at` vs `decided_at`, executor signature (`ToolCtx` vs `{userId, actionId, payload}`), executor directory, web revise/confirm path | **§1.5 + migration §5:** statuses pending/executing/done/failed/cancelled/expired; `decided_at` + `decided_via` + `version`; `ExecContext` executor; `agent/pending/executors/`. | V2-04 §7.2 pending, §4 `confirmed_at`; V2-07 §7.4 `agent/executors/`; web §8 statuses |
| C16 | `SendEmailPayload` location/fields (V2-07 snake in `gmail/send.ts` vs web camel in `src/shared/email-draft.ts`) | **`src/shared/email-draft.ts` with V2-07's snake fields**, plus `original_rfc822_id` | web §8 camelCase shape |
| C17 | Account deletion: V2-04 soft-delete + purge + hooks vs web immediate hard delete | **One `deleteAccount`** (§1.16). Chat = soft + `account_purge` job (job `user_id` null). | V2-04 §7.2 `deletion-hooks.ts`, executor body |
| C18 | Fact deletion: soft (V2-04) vs hard (web) | **Hard delete** for `forget` and the web delete | V2-04 §9.2 #10 soft-delete |
| C19 | Persona tone: V2-04 `persona.tone` pref (mirror/friendly/chill_professional) vs web `persona_prefs.tone` (mirror/casual/polished) vs V2-06 `persona_prefs.register` | **`users.persona_prefs.tone`** via `src/shared/persona-prefs.ts`; templates via `templateRegister` | V2-04 §2.9 tone dial; V2-06 §8 consumed item 3 |
| C20 | Google OAuth start: V2-07 POST (CSRF) vs brief + web GET (CSP `form-action` blocks POST→302 to Google) | **GET**, with `fresh_setup` + `Sec-Fetch-Site` check + `no-store`. A cross-site GET can only start a consent flow for the victim's own Google account, and the callback is bound to the cookie and session. The disconnect route is dropped (server action instead), and so is `GoogleCard.tsx` (web owns the UI). | V2-07 §2.3 start, §7.4 oauth/disconnect routes + GoogleCard, Q10 |
| C21 | Google status shape (`GoogleStatus` vs `GoogleStatusView`); `disconnectGoogle` return type | **§1.12** (web shape plus `features`/`triage`); returns `{revoked}` | V2-07 §7.1 `status.ts`/`disconnect.ts` return types |
| C22 | Canvas connect API and errors (web subset vs V2-05) | **V2-05 superset**; no `/api/canvas/connect` | web §8 V2-05 block |
| C23 | LLM extensions requested by four branches (`callModel`, `runStructured`+`draft`, `recordLlmCall`/`costForModel`/Opus price, `meta`/maxTokens) | **One owner (1.3)**, §1.6. V2-07 07b-3 and V2-08 T5 must not edit `src/server/llm`. | V2-07 §8.2 LLM row; V2-08 §7.2 llm edit |
| C24 | `llm_calls.user_id` proposed twice (V2-04, V2-08) + `job_id`/`meta` | One copy each (migration §3) | — |
| C25 | `integrations`: `status_notified_at` (V2-05 & V2-07), the status check twice, `last_error` vs `status_reason` | One copy each. **`last_error`** = last sync error code; **`status_reason`** = why the status changed. | — |
| C26 | `users.briefing_enabled` (V2-06 & web), `pending_actions.result` (V2-04 & web), `email_items.alerted_at` (V2-06 & V2-07) | One copy each | — |
| C27 | Baseline `user_preferences` index name unknown | Dropped by predicate in a DO block | V2-04 §4 `drop index` line |
| C28 | Syllabus all-day: V2-08 `raw.all_day` vs V2-05 column | **The `all_day` column** (`TimelineItemInput.allDay`) | V2-08 §2.7 raw flag |
| C29 | Hook name: `onUserScheduleSettingsChanged` (V2-06) vs `onSchedulePrefsChanged` (web) vs `recomputeNextBriefing` (V2-04) | **`onUserScheduleSettingsChanged`**, which also calls `rebaseTimeline` (V2-05 request) | web §8, V2-04 §8.5 |
| C30 | `scheduler.ts` + `notes.ts` owned by V2-06 T6 but needed in Wave 2/3 | Moved to task 2.6 | V2-06 §11 T6 file list |
| C31 | V2-07 `composeProactive` request; V2-04 offers proactive agent runs | **Not built.** Email alerts use templates; the triage digest uses `runStructured(route "briefing")` in `gmail/triage.ts`. | V2-07 §8.2 composeProactive row |
| C32 | `ctx.userText` (V2-07 request) | **Added to `ToolCtx`** | — |
| C33 | `user_preferences.constraint_json` (V2-07 proposal on a V2-04 table) | **Accepted.** Schema in `src/shared/scheduling-constraints.ts`; written by `propose_preference`. | V2-07 Q3 |
| C34 | Redacting Canvas URLs in `messages.body` (V2-05 asks V2-03) | `redactInboundBodies` in `channels/repo.ts` | V2-05 §8.4 V2-03 row |
| C35 | `messages.media` shape (V2-03 `{url, kind}` vs V2-08 `{url, contentType?, filename?, size?}`) | Union (§1.1) | — |
| C36 | Mutator gating across branches: V2-04 evidence vs V2-06 "user-turn only" vs none (V2-05/07/08) | **Evidence rule for all mutators** (§1.0 rule 5) | — |
| C37 | `timeline_apply` `security invoker` (V2-05), V2-04 functions `invoker` with `search_path = public` | **All `security definer set search_path = ''`**, fully qualified, service_role only | V2-05 §4, V2-04 §4 function headers |
| C38 | Smoke-test styles: tsx scripts (V2-03, V2-07, V2-08) vs Jest smoke (V2-04, V2-05, V2-06, web) | **Jest:** `tests/smoke/<area>.smoke.test.ts`, run with `npm run smoke`. Throwaway rows always deleted. | V2-03 §10.2 path, V2-07 `scripts/smoke/google-db.ts`, V2-08 `scripts/smoke/syllabus-intake.ts` |
| C39 | `vercel.json` crons: V2-03 dispatch backstop (12:00) and V2-06 `/api/cron/daily` (10:00); `CRON_SECRET` used by both | **Both crons in one file** (Hobby allows 100 daily crons); one `CRON_SECRET` | — |
| C40 | Web "ports" layer (`src/server/web/ports.ts` + `PORT_STUB`) | Superseded by the Wave 0 stubs. The web imports contracts directly. | web §8 ports paragraph, W10 grep |
| C41 | Paths moved by the `(app)` route group: V2-08 `src/app/setup/_components/SyllabusUpload.tsx`, V2-07 `setup/GoogleCard.tsx` | `src/app/(app)/setup/SyllabusUpload.tsx`; GoogleCard dropped | V2-08 §7.2, V2-07 §7.4 |
| C42 | `/privacy` + `/terms`: web says skip, V2-07 says Google branding needs them | **Build minimal pages** (1.6) unless Daniel declines (§6 D5) | web §1 skip, Q2 |
| C43 | `httpx2` pin (V2-08) flagged as a possible typosquat | **Kept.** Verified on PyPI 2026-10-10: `anthropic==1.8.0` declares `httpx2<3,>=2.0.0`; httpx2's author is Tom Christie, the maintainer is Pydantic Services Inc., the repo is github.com/pydantic/httpx2, and it has 18 releases since 2026-05-11. `fastapi.testclient` (which needs classic `httpx`) is **not** used; tests use `httpx2.ASGITransport`. | — |
| C44 | Schedule location of `cron.schedule` (002 comment says V2-06) | **003 §14** (no-op until Vault is set) | 002 header comment |
| C45 | `maskHandle` location (V2-07 Q15) | `src/server/phone.ts` (exists) | — |

---

## §3 Dependencies

### 3.1 npm

All versions verified with `npm view` on 2026-10-10. Install exact (`-E`).

| Package | Version | Published | Kind | Why / plan |
|---|---|---|---|---|
| `tsx` | 4.23.15 | 2026-09-20 | dev | Dev REPL, dev tick (V2-03) |
| `ical.js` | 2.2.1 | 2025-08-08 | dep | ICS lexer (V2-05) |
| `jose` | 6.2.12 | 2026-09-05 | dep | Google OIDC JWT verify (V2-07). ESM-only. |
| `server-only` | 0.0.1 | 2022-09-03 | dep | `import "server-only"` (web) |
| `@playwright/test` | 1.63.0 | 2026-09-04 | dev | Web e2e/QA + asset renderer (web). Uses installed Chrome. |

There are no other runtime additions. The following are explicitly rejected:
- `googleapis`, `@googleapis/*`, `google-auth-library`
- `node-ical`, `rrule`, `rrule-temporal`, `temporal-polyfill`, `luxon`, `date-fns-tz`
- `sendblue` SDK, `undici`, shadcn/Radix, `@testing-library/*`, `sharp`

### 3.2 pip (`services/parser/`, Python 3.13, `python:3.13-slim` pinned by digest)

All versions verified against the PyPI JSON on 2026-10-10.

| Package | Pin | Uploaded | File |
|---|---|---|---|
| `anthropic` | 1.8.0 | 2026-09-22 | requirements.txt |
| `fastapi` | 0.141.1 | 2026-07-29 | requirements.txt |
| `uvicorn` | 0.53.0 | 2026-09-14 | requirements.txt |
| `pydantic` | 2.13.5 | 2026-08-28 | requirements.txt |
| `pypdf` | 6.19.0 | 2026-09-16 | requirements.txt |
| `tzdata` | 2026.4 | 2026-09-12 | requirements.txt |
| `pytest` | 9.1.1 | 2026-06-19 | requirements-dev.txt |
| `httpx2` | 2.13.1 | 2026-09-23 | requirements-dev.txt (C43) |

Lock: `uv pip compile requirements.txt --generate-hashes -o requirements.lock` (orchestrator). The Dockerfile then runs `pip install --require-hashes`.

### 3.3 Config changes (orchestrator, Wave 0)

**`jest.config.mjs`:**

```js
const config = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.tsx"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^ical\\.js$": "<rootDir>/node_modules/ical.js/dist/ical.es5.cjs",
  },
  modulePathIgnorePatterns: ["<rootDir>/mobile/", "<rootDir>/celery_worker/", "<rootDir>/services/"],
};
const base = createJestConfig(config);
export default async () => {
  const c = await base();
  c.transformIgnorePatterns = ["/node_modules/(?!(jose)/)", "^.+\\.module\\.(css|sass|scss)$"];
  return c;
};
```

- `jest.smoke.config.mjs`: same base, `testMatch: ["<rootDir>/tests/smoke/**/*.smoke.test.ts"]`, `testTimeout: 120000`.
- `evals/jest.config.mjs` is owned by 5.1 (V2-04 §7.5).

**`package.json`:**
- `"engines": { "node": "24.x" }`. Vercel's default is 24; local Node 22 only warns.
- scripts:

```json
"typecheck": "tsc --noEmit",
"test": "jest",
"smoke": "jest -c jest.smoke.config.mjs --runInBand",
"evals": "jest -c evals/jest.config.mjs --runInBand",
"dev:chat": "tsx scripts/dev-chat.ts",
"dev:tick": "tsx scripts/dev-tick.ts",
"parser:test": "cd services/parser && pytest",
"e2e": "playwright test",
"qa:shots": "playwright test --project=shots",
"assets": "playwright test scripts/assets/render.spec.ts --project=assets"
```

**Other files:**

| File | Change |
|---|---|
| `vercel.json` | `{"crons":[{"path":"/api/jobs/dispatch","schedule":"0 12 * * *"},{"path":"/api/cron/daily","schedule":"0 10 * * *"}]}` |
| `eslint.config.mjs` | `react/no-danger: "error"` for `src/app/**` |
| `.gitignore` | `services/parser/.env.local`, `test-results/`, `playwright-report/`, `.pytest_cache/` |
| `.env.example` | §4 |

---

## §4 Environment variables

**Bold** = new compared with the current `.env.example`. ✗ = credentials still missing.

| Group | Var | Req | Notes |
|---|---|---|---|
| App | `NODE_ENV`, `APP_BASE_URL` | prod ✗ | Deployed URL needed for OAuth, Pub/Sub, magic links |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | yes | have |
| LLM | `ANTHROPIC_API_KEY` | yes | have |
| LLM | `OPENAI_API_KEY` | no ✗ | Luna fallback is deferred (V2-04 T9) |
| LLM | **`AGENT_ESCALATION_CAP_PCT`** (10), **`ARIA_AGENT`** (`stub`) | no | |
| Sendblue | `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_SIGNING_SECRET` (comma list), `SENDBLUE_FROM_NUMBER` | prod ✗ | |
| Sendblue | **`SENDBLUE_API_BASE`** | no | `.com` vs `.co` unverified |
| Channel | **`CHANNEL_PROVIDER`** (`dev`\|`sendblue`), **`DEV_CHANNEL_SECRET`** | dev | |
| Upstash | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | prod ✗ | Dev falls back to the DB lease and in-memory rate limit |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (opt), `GMAIL_PUBSUB_TOPIC` | ✗ | Unset topic in dev means polling |
| Google | **`GMAIL_PUSH_SERVICE_ACCOUNT`**, **`GMAIL_PUSH_AUDIENCE`** (opt), **`GMAIL_PUSH_SUBSCRIPTION`** (opt), **`GOOGLE_PKCE`** (opt) | ✗ | |
| Secrets | `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `JOBS_DISPATCH_SECRET` | yes | `JOBS_DISPATCH_SECRET` must equal Vault `aria_dispatch_secret` |
| Secrets | **`CRON_SECRET`** | prod | `openssl rand -hex 32`; Vercel Cron bearer |
| Parser (TS) | `PARSER_SERVICE_URL` ✗ (Cloud Run), `PARSER_SHARED_SECRET` | yes | |
| Parser (TS) | **`PARSER_TIMEOUT_MS`** (280000), **`SYLLABUS_MEDIA_ALLOWED_HOSTS`** ✗ (Sendblue CDN host), **`SYLLABUS_MAX_PDF_BYTES`**, **`SYLLABUS_UPLOAD_MAX_BYTES`**, **`SYLLABUS_DAILY_LIMIT`** | no | |
| Canvas | **`CANVAS_FEED_MAX_BYTES`**, **`CANVAS_SYNC_DISABLED`**, **`CANVAS_LIVE_TEST_URL`** (tests only; never commit) | no | |
| Monitoring | `SENTRY_DSN` | no ✗ | |
| Tests | **`EVAL_MODE`**, **`EVAL_DEV_CHANNEL_URL`**, **`EVAL_REPEAT`**, **`E2E_BASE_URL`** | no | |

Parser service env (`services/parser/.env.example`, Cloud Run): V2-08 §6 second table. It needs a **separate** `ANTHROPIC_API_KEY` ✗ (§6 D6).

---

## §5 Build waves

**Every task's standing rules:**
- No `npm install`, `pip install`, migrations, `git commit`/`push`, or `next build`.
- Verify with `npx tsc --noEmit`, `npx eslint <own files>`, `npm test -- <own tests>`, and, for DB code, `npm run smoke -- <own smoke file>`.
- No `any`. JSDoc on every export. `import "server-only"` in every server file.
- Logs carry masked handles only, never bodies or tokens.
- **Global must-not-touch:**
  - §1.0 frozen files
  - `supabase/**`
  - `package.json`, `package-lock.json`, jest configs, `.env*`, `vercel.json`, `eslint.config.mjs`
  - any file owned by another task
  - the branch plan docs

  If a contract looks wrong, **stop and write a change request in the hand-off**; don't edit around it.
- **Smoke dependencies:** when a smoke step depends on a module built by another task in the **same** wave, it is marked *(gate)* and the orchestrator runs it at the wave gate.

**Wave gate (orchestrator, after each wave):**
1. `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run smoke`, `npm run build`. From Wave 1 on, also `cd services/parser && pytest`.
2. `grep -c "notImplemented(" -r src/` goes down by the expected amount.
3. Review the hand-offs, then commit per area (never `git add .`).

### Wave 0: scaffolding (3 steps)

| Id | Task | Details |
|---|---|---|
| **0.1** | **Orchestrator infra** (no sub-agent) | **(a) Preflight:** `select version();` (needs ≥ 15.1.1.61 for 15s cron); `select count(*) from syllabi;` (expect 0); `select scope, count(*) from web_sessions group by 1;` (only view/setup); `select indexname from pg_indexes where tablename='user_preferences';`.<br>**(b) Dry-run 003.** This integration pass could not run it locally because the permission was denied. Use `supabase db push --dry-run`, or apply to a scratch DB.<br>**(c)** `supabase db push`.<br>**(d)** Regenerate `src/server/db/types.ts`.<br>**(e)** `npm i -E ical.js@2.2.1 jose@6.2.12 server-only@0.0.1 && npm i -E -D tsx@4.23.15 @playwright/test@1.63.0`.<br>**(f)** Apply the §3.3 config, `.env.example` (§4), `vercel.json`, eslint and `.gitignore` changes.<br>**(g)** Commit. |
| **0.2** | **Contract stubs** (sub-agent; after 0.1) | **Follow:** this §1 exactly.<br>**Owns** (until handed over):<br>• all §1.0 frozen files<br>• `src/server/_stub.ts` (`notImplemented(owner)`, `NotImplementedError`)<br>• every stub file named in §1 (each with `// OWNER: <id>`): `jobs/enqueue.ts`, all 19 `jobs/kinds/*.ts` (final zod payloads), `channels/deliver.ts`, `channels/repo.ts` (`redactInboundBodies` only), `agent/index.ts`, `agent/tools/define.ts` (minimal real), all 31 `agent/tools/*.ts` (final name/description/zod input/flags; `run` returns `{ok:false, error:"not_implemented"}`), `agent/pending/actions.ts`, `agent/pending/executors/{delete-account,send-email}.ts`, `memory/index.ts`, `timeline/index.ts` + `timeline/hooks.ts`, `integrations/canvas/{connect,sync}.ts`, `integrations/google/{status,disconnect,http,store,tokens,errors}.ts`, `gmail/{sync,classify,alerts,triage}.ts`, `calendar/busy.ts`, `integrations/syllabus/{index,client}.ts`, `reminders/service.ts`, `briefing/{scheduler,notes}.ts`, `proactive/settings.ts`, `alerts/timeline-changes.ts`, `account/delete.ts`<br>• minimal edits to `security/link-policy.ts` + `magic-links.ts` (§1.15 type/table only)<br>• `tests/unit/contracts/registry.test.ts`<br>**Accept:** `tsc` clean. Existing tests pass. The registry test asserts the kind and tool names and order (§1.3/§1.4). Every §1 symbol is importable. No stub mutator silently succeeds. |
| **0.3** | **Shared pure primitives** (sub-agent; parallel with 0.2) | **Follow:** V2-06 §2.1, §7 `tz.ts`, §10 tz vectors; V2-03 §10.1 `tz.test`; V2-07 §10 `time.test`; V2-04 §2.8(4) + §10.1 untrusted; V2-08 §7.2 course-key + vectors.<br>**Owns:** `src/shared/time/tz.ts`, `src/shared/course-key.ts`, `src/shared/register.ts`, `src/server/agent/untrusted.ts`, `tests/fixtures/contract/course_key_vectors.json`, `tests/unit/shared/{tz,course-key,register}.test.ts`, `tests/unit/agent/untrusted.test.ts`.<br>**Accept:** every DST vector (NY gap/overlap, Sydney, Lord Howe, Kolkata, London, Phoenix, Auckland) passes. 10k-instant property round-trip. `formatForChat` examples. Untrusted close-tag injection neutralized. No imports outside `src/shared` (`untrusted.ts` may import only `src/shared`). |

### Wave 1: foundations (6 parallel)

| Id | Task | Follow | Owns | Consumes | Accept |
|---|---|---|---|---|---|
| **1.1** | Jobs runtime | V2-03 §2.11, §7 jobs table, §11 T2 | `jobs/{enqueue,runner,backoff,auth}.ts`, `jobs/kinds/{noop,retention-purge}.ts`, `api/jobs/dispatch/route.ts`, `scripts/dev-tick.ts`, `scripts/ops/configure-jobs-tick.sql`, `tests/unit/jobs/*`, `tests/smoke/jobs.smoke.test.ts` | 003 RPCs, `jobs/types.ts` | V2-03 T2 criteria. Retention also purges `briefings.plan` >180d (V2-06 Q11), `proactive_dedupe` >30d and signups (V2-03 Q9). Smoke = V2-03 §10.2 items 3–5, 8, 9. |
| **1.2** | Channels core + providers | V2-03 §2.6–2.10, §2.12, §3 Sendblue, §7 channel files, §11 T1 (minus tz) + T3 | `channels/{plan,render,guards,commands,interim,vcard,execute,index}.ts`, `channels/providers/*`, `pipeline/{config,welcome}.ts`, `app/aria.vcf/route.ts`, `tests/fixtures/sendblue/*`, `tests/unit/channels/*` | tz, register, `channels/types.ts` | V2-03 §10.1: plan, render, guards, commands, execute, sendblue, welcome-interim, vcard. `textPlan` tested. No Sendblue SDK. |
| **1.3** | LLM layer + agent foundations | V2-04 §2.1–2.5, §3, §7.1, §7.2 (config, plan, aliases, budget, define, registry), §11 T1+T2; §1.6 here | `src/server/llm/*`, `agent/{config,plan}.ts`, `agent/context/{aliases,budget}.ts`, `agent/tools/{define,registry}.ts`, `tests/unit/llm/*`, `tests/unit/agent/{aliases,plan,registry}.test.ts` | `agent/types.ts`, tool stubs | V2-04 T1/T2 criteria. `runStructured` via `zodOutputFormat`. `classify` thinking disabled. Opus pricing. `recordLlmCall` never throws. The registry test from §1.4 passes against the 31 stubs. Manual cache check script logs `cache_read > 0` on a second call. |
| **1.4** | Canvas pure | V2-05 §2.1–2.7, §3, §7.1, §7.2 (ssrf, fetch-feed, ics, parse, schedule), §10.1–10.2, §11 T1–T3 | `src/shared/{universities,canvas-url,canvas-guide}.ts`, `canvas/{ssrf,fetch-feed,ics,parse,schedule}.ts`, `tests/fixtures/canvas/*`, `tests/unit/canvas/*`, `tests/unit/shared/{universities,canvas-url}.test.ts` | tz, course-key | V2-05 T1–T3 criteria. **Salvage** `mobile/lib/universities.ts` (with corrections) and `celery_worker/canvas/*.py` logic before Wave 5 deletes them. |
| **1.5** | Python parser service | V2-08 §2.1–2.15, §7.1, §8.1, §10 (Python), §11 T1–T3 | `services/parser/**`, `docker-compose.yml` (parser only; celery + redis removed) | course-key vectors | V2-08 T1–T3 criteria. `pytest` green offline. `docker build` produces a non-root image. healthz/401/413 behave. Golden contract JSON is committed. Live test is optional (record cost). |
| **1.6** | Web shell + shared pure + PWA | web §2.1–2.8, §7.1–7.3, §9.1, §11 W1–W3; §1.15/§1.17 here | Everything in web W1/W2/W3 "Owns" **except** `web/ports.ts`. Plus `(app)/setup/page.tsx` with five placeholder components at final paths (Schedule, Tone, Canvas, Google, Syllabus) and final props, `src/server/web/setup-data.ts`, `src/shared/persona-prefs.ts` (+ `templateRegister`), `app/privacy/page.tsx`, `app/terms/page.tsx` (minimal, §6 D5), `playwright.config.ts` | contracts (status getters return neutral values) | Web W1–W3 criteria. `/setup` renders every section from placeholders. CSP present; `/m` redeem still works. The `link-policy` additions are tested. |

### Wave 2: services (6 parallel)

| Id | Task | Follow | Owns | Consumes | Accept |
|---|---|---|---|---|---|
| **2.1** | Delivery + ingest + webhooks | V2-03 §2.2, §2.5–2.8, §2.12, §7 repo/deliver/pipeline, §11 T4+T5; §1.1 deliver | `channels/{repo,deliver}.ts`, `jobs/kinds/proactive-flush.ts`, `pipeline/{lease,ingest,commands-handler,kick}.ts`, `api/channels/{sendblue,dev}/route.ts`, `tests/unit/pipeline/lease.test.ts`, `tests/helpers/memory-store.ts`, `tests/smoke/pipeline.smoke.test.ts` | 1.1, 1.2 | V2-03 T4+T5 criteria, plus the §1.1 merged semantics: `deferMode:"return"`; synchronous `expiresAt` check; inline flush for allowed-now urgent/requested; `proactive_dedupe`. Smoke = V2-03 §10.2 items 1, 2, 6, 7. |
| **2.2** | Memory + context + persona | V2-04 §2.5, §2.7–2.9 (not interim/watchdog), §7.2 context/persona, §7.3 (not extraction/summary), §11 T3+T4; web §8 memory API | `memory/{index,profile,conversation,preference-policy,preferences,facts,web}.ts`, `agent/context/{window,render,static-prompt,build}.ts`, `agent/persona/{style-guide,few-shots,ack}.ts`, `tests/unit/memory/{policy,profile}.test.ts`, `tests/unit/agent/{context,static-prompt,ack}.test.ts`, `tests/smoke/memory.smoke.test.ts` | 1.3, register, timeline + reminders contracts | V2-04 T3/T4 criteria. Few-shots use the §1.4 names (`update_profile` has no briefing_time; `pause`). The transcript renders attachments as `[attachment m_xxxxxxxx:0 — PDF "<name>"]`. The static prompt is byte-stable. Memory smoke passes (preferences, `recall_facts`, `claim_escalation`). |
| **2.3** | Timeline | V2-05 §2.4, §2.5, §2.8, §2.10, §7.3, §8, §10.2–10.3, §11 T4+T5 | `timeline/{diff,policy,urgency,view,store,hooks,index}.ts`, `tests/unit/timeline/*`, `tests/smoke/timeline.smoke.test.ts` | tz, course-key, untrusted, 1.1 enqueue | V2-05 T4+T5 criteria. All §8.1 functions and aliases. Batch enqueued only after the RPC commits. Smoke items 1–6, 9. |
| **2.4** | Google core | V2-07 §2.1–2.4, §2.14, §7.1 (config, oauth/state, oauth/flow, errors, http, oidc, store, tokens, status), §10 (state, config, oidc, http), §11 07a-1 (minus time) + 07a-2 | those files + their tests, `tests/smoke/google.smoke.test.ts` (integration parts) | contracts, crypto | 07a-1/07a-2 criteria. `getGoogleStatus` returns §1.12 shape. `markGoogleUnavailable` sends exactly one notice via `deliver` *(gate)*. |
| **2.5** | Gmail base | V2-07 §2.9, §2.10 (prefilter only), §7.3 (schemas, api, headers, mime, prefilter, ingest, sync, push), §11 07b-1 + 07b-2 | `gmail/{schemas,api,headers,mime,prefilter,ingest,sync,push}.ts`, `api/google/gmail-push/route.ts`, `kinds/{gmail-watch-renew,gmail-history-sync}.ts`, `tests/unit/google/{headers,mime,prefilter}.test.ts`, smoke cursor/dedupe additions *(own file `tests/smoke/gmail.smoke.test.ts`)* | 2.4 (via contract), `gmail/types.ts`, `classifyIngested` stub | 07b-1/07b-2 criteria. Ingest calls `classifyIngested` then `alertHighImportance` (stubs until 4.3). The cursor never regresses. `sendRaw` is only importable by `gmail/send.ts` (4.3); enforce with an eslint `no-restricted-imports` comment check in the hand-off. |
| **2.6** | Reminders + schedule core | V2-06 §2.1–2.4, §2.6, §2.7, §2.9, §7 (rrule-lite, proactive/schedule, proactive/settings, reminders/{service,render,fire}), §9 tools, §11 T1 (rrule) + T2 + T4 + T5; scheduler + notes per §1.14 | `src/shared/time/rrule-lite.ts`, `proactive/{schedule,settings}.ts`, `briefing/{scheduler,notes}.ts`, `reminders/{service,render,fire}.ts`, `kinds/reminder-fire.ts`, `tools/{create-reminder,list-reminders,cancel-reminder,update-notification-settings}.ts`, `tests/unit/{time/rrule-lite,proactive/schedule,reminders/*}.test.ts`, `tests/smoke/reminders.smoke.test.ts` | tz, deliver/timeline contracts *(gate)*, 1.1 | V2-06 T1/T2/T4/T5 criteria. `deliver` flags mapped to §1.1 (`priority:"requested"` / `"urgent"`, `expiresAt`). Aliases `t_`/`r_`. `onUserScheduleSettingsChanged` calls `rebaseTimeline`. V2-06 smoke steps 2, 3, 6, 8 *(gate)*. |

### Wave 3: agent + integrations (6 parallel)

| Id | Task | Follow | Owns | Consumes | Accept |
|---|---|---|---|---|---|
| **3.1** | Turn orchestration + dev loop | V2-03 §2.2–2.4, §2.7, §2.9, §10.3, §11 T6+T7; §1.2 here | `pipeline/{turn,watchdog,stub-agent,agent-impl}.ts`, `kinds/conversation-turn.ts`, `scripts/dev-chat.ts`, `tests/unit/pipeline/turn.test.ts`, `tests/smoke/turn.smoke.test.ts` | 2.1, `runAgentTurn` contract | V2-03 T6+T7 criteria. Creates and closes `agent_runs` per §1.2. First contact calls `scheduleNextBriefing`. Users with `deleted_at` are ignored. The REPL script from V2-03 §10.3 passes with `ARIA_AGENT=stub`. |
| **3.2** | Agent loop | V2-04 §2.1, §2.2, §2.6, §2.10, §2.11, §7.2 (index, loop, runs, escalation), §10.1 loop/escalation, §11 T5 | `agent/{index,loop,runs,escalation}.ts`, `tests/unit/agent/{loop,escalation}.test.ts` | 1.3, 2.2 | V2-04 T5 criteria. Loop tests 1–10 (test 11, the watchdog, moves to 3.1). Enqueues `memory_extract` / `conversation_summary`. `runs.ts` exposes `updateRunStats`, not create. |
| **3.3** | V2-04 tools + pending + memory jobs | V2-04 §2.7 (extraction, summary), §2.8, §9, §11 T6+T7; §1.5 here; web §8 pending path | 16 tool files (§1.4 owner 3.3), `agent/pending/actions.ts`, `pending/executors/delete-account.ts`, `memory/{extraction,summary}.ts`, `kinds/{memory-extract,conversation-summary,account-purge}.ts`, `tests/unit/agent/tools-*.test.ts`, `tests/unit/memory/extraction-validate.test.ts`, `tests/smoke/pending.smoke.test.ts` | 2.2, 2.3, 2.6 (scheduler), 1.3 | V2-04 T6+T7 criteria. Concurrent confirms: exactly one executes. Web revise/confirm with version guard. `same_run` refusal. `account_purge` calls the `deleteAccount` contract *(gate with 4.6 at W4)*. |
| **3.4** | Canvas sync + connect + tools | V2-05 §2.6–2.9, §7.2 (store, sync, connect), §9, §11 T6+T7 | `canvas/{store,sync,connect}.ts`, `kinds/canvas-sync.ts`, `tools/{connect-canvas,canvas-status}.ts`, `tests/unit/canvas/{schedule-io,connect-tool}.test.ts`, smoke additions in `tests/smoke/canvas.smoke.test.ts` | 1.4, 2.3, 2.1 (deliver, `redactInboundBodies`), 2.2 (`refreshProfileBlock`) | V2-05 T6+T7 criteria. URL only from user-authored text. Feed URL never logged. Smoke items 7, 8, 10. |
| **3.5** | Syllabus TS + wiring | V2-08 §2.6, §2.11–2.14, §7.2, §8.2, §9, §10 (TS), §11 T4–T6 | `integrations/syllabus/*`, `kinds/syllabus-parse.ts`, `tools/{read-syllabus,syllabus-info}.ts`, `api/syllabus/upload/route.ts`, `(app)/setup/SyllabusUpload.tsx`, `tests/unit/syllabus/*`, `tests/smoke/syllabus.smoke.test.ts` | 1.5 (contract/goldens), 1.3 (`recordLlmCall`), 2.3, 2.1, course-key | V2-08 T4–T6 criteria. Does not edit `src/server/llm`. Dev-channel PDF → confirmation bubbles *(gate with 3.1)*. |
| **3.6** | Google OAuth routes + calendar read | V2-07 §2.3, §2.5, §2.6, §2.11 (post-connect), §7.2 (schemas, api, normalize, sync, watch), §7.4 routes, §10 (normalize, calendar-push), §11 07a-3 (minus GoogleCard + disconnect route) + 07a-4; §1.12 GET start | `google/disconnect.ts`, `calendar/{schemas,api,normalize,sync,watch}.ts`, `api/google/{oauth,callback,calendar-push}/route.ts`, `kinds/{google-post-connect,gcal-sync,gcal-watch-renew}.ts`, tests | 2.4, 2.5 (`startGmailWatch`/`stopGmailWatch`), 2.3 | 07a-3/07a-4 criteria with GET start. A cross-site `Sec-Fetch-Site` → 403. Stale session → `/setup?google=stale`. Callback codes ∈ `GoogleConnectStatus`. Post-connect calls the `startTriage` contract. `disconnectGoogle` returns `{revoked}`. |

### Wave 4: proactive + Google features + web pages (6 parallel)

| Id | Task | Follow | Owns | Consumes | Accept |
|---|---|---|---|---|---|
| **4.1** | Briefing + change alerts + reconcile | V2-06 §2.5, §2.6, §2.8, §2.9, §7 (briefing snapshot, prompt, template, load, generate, run; alerts; reconcile; cron route), §10, §11 T3 + T6 (minus scheduler) + T7–T9 | `briefing/{snapshot,prompt,template,load,generate,run}.ts`, `alerts/timeline-changes.ts`, `proactive/reconcile.ts`, `kinds/{briefing-prepare,briefing-send,timeline-changes}.ts`, `api/cron/daily/route.ts`, `.github/workflows/keepalive.yml` (only if §6 D11 = yes), `tests/unit/briefing/*`, `tests/smoke/briefing.smoke.test.ts` | 2.6, 2.3, 2.2 (`listQueuedProposals`), 4.3 accessors (contract) | V2-06 T3/T6–T9 criteria. Briefing link uses the `digest` purpose. LLM via `runStructured(route:"briefing")` with untrusted wrapping. V2-06 smoke steps 1–9. |
| **4.2** | Scheduling + Aria calendar tools | V2-07 §2.7, §2.8, §7.2 (slots, busy, aria-calendar), §9.2 calendar tools, §10 slots, §11 07a-5 + 07a-6 | `calendar/{slots,busy,aria-calendar}.ts`, `tools/{find-free-slots,create-block,move-block,delete-block}.ts`, `tests/unit/google/{slots,constraints}.test.ts` | 3.6, 2.2 (`listActivePreferences`, `getProfile`), 3.5 (`getSyllabusSignals`), scheduling-constraints | 07a-5/07a-6 criteria (the 14 slot cases). Slots are returned as `s_` aliases. `create_block` accepts a slot alias. |
| **4.3** | Gmail intelligence + email tools | V2-07 §2.10–2.12, §7.3 (classify, alerts, triage, draft, send), §9 (`gmail_triage_chunk`, email tools, executor), §10 classify/triage-plan, §11 07b-3 + 07b-4 + 07b-5 | `gmail/{classify,alerts,triage,draft,send}.ts`, `kinds/gmail-triage-chunk.ts`, `tools/{search-email,read-email,draft-email}.ts`, `pending/executors/send-email.ts`, `tests/unit/google/{classify,triage-plan}.test.ts` | 2.5, 3.3 (pending), 1.3 (`runStructured`, `draft` route), email-draft | 07b-3..5 criteria. Alerts use templates; the digest uses `runStructured("briefing")`. `sendRaw` is imported only by `send.ts`. No send path exists without a confirmed pending action. |
| **4.4** | Web: setup schedule/tone + /week | web §2.5, §7.4 (schedule/tone parts), §7.5, §9.2–9.3, §11 W4 + W7 | `(app)/setup/{ScheduleForm,ToneForm,actions}.tsx\|ts`, `(app)/week/**`, `src/server/web/week-data.ts`, `tests/unit/render.test.tsx` (week parts), `tests/smoke/schedule.smoke.test.ts` | 1.6, 2.3, 2.6 (`onUserScheduleSettingsChanged`) | W4 + W7 criteria. Mark done goes through `setTimelineItemStatus`. All-day items land on the right day. |
| **4.5** | Web: setup integrations + email draft | web §2.3, §7.4 (Canvas/Google), §7.7, §9.2, §9.5, §11 W5 + W6 + W9 | `(app)/setup/{CanvasConnect,GoogleConnect}.tsx`, `(app)/setup/integration-actions.ts`, `(app)/email/[id]/**`, `src/server/web/email-data.ts` | 3.4, 3.6, 2.4 (status), 3.3 (pending path), email-draft | W5 + W6 + W9 criteria with **GET** connect `<a>`. Recipients read-only. Send uses `confirmPendingAction({via:"web", expectedVersion})`. |
| **4.6** | Web: settings + export/delete | web §7.6, §9.4, §11 W8a + W8b; §1.16 here | `(app)/settings/**`, `src/server/web/settings-data.ts`, `src/server/account/{delete,export}.ts`, `api/me/export/route.ts`, `tests/unit/export-shape.test.ts`, `tests/smoke/account.smoke.test.ts` | 2.2 (web memory API), 3.4/3.6 disconnects | W8a + W8b criteria. `deleteAccount` is idempotent and handles `via:"job"`. The chat `account_purge` path is verified *(gate)*. |

### Wave 5: final (5.1–5.4 parallel, then 5.5)

| Id | Task | Owns | Accept |
|---|---|---|---|
| **5.1** | Evals v0 (V2-04 §7.5, §10.3, §11 T8) | `evals/**` (incl. `evals/jest.config.mjs`), `evals/BASELINE.md` (generated) | `npm run evals` runs direct mode against real Supabase + Anthropic and cleans up. The injection suite (incl. V2-07 email seeds) is green. Prints a cost report. Eval runs set `is_eval`. |
| **5.2** | Salvage cleanup + docs | **Deletes:** `mobile/`, `celery_worker/`, `Procfile`, `scripts/phone-dev.sh`, `APP_STORE_CHECKLIST.md`, `src/server/_stub.ts` (after the grep is clean), the jest `modulePathIgnorePatterns` for mobile/celery (orchestrator applies).<br>**Rewrites for V2:** `CLAUDE.md` (architecture, ownership = single engineer, gotchas incl. the §1.0 rules), `README.md`, `DEPLOYMENT.md`, `PRODUCTION.md` (Cloud Run parser, Upstash, Sendblue, Google project, Vault/cron, separate parser key), `LOCALDEV.md`/`SETUP.md`/`ONBOARDING.md` (rewrite, or delete if V1-only).<br>**Verifies:** `docker-compose.yml` has only `parser`. | Pre-delete checklist: universities and Canvas parse ported (1.4), no V2 import from `mobile/` or `celery_worker/`. `npm run build` is green after deletion. Docs mention only V2 commands. |
| **5.3** | E2E dev-channel conversation test | `tests/e2e-chat/conversation.smoke.test.ts`, plus bug fixes in `src/server/**` (each fix listed in the hand-off) | With `npm run dev`, `npm run dev:tick`, the local parser (`PARSER_FAKE_LLM=1`) and a real Anthropic key, the following scripted conversation on the dev channel passes:<br>1. greeting → welcome + vCard<br>2. name → `update_profile`<br>3. 3-message burst → one run<br>4. "what's due tmr" against seeded timeline → local times<br>5. "remind me in 1 min to drink water" → fires within 75s<br>6. "finished the econ pset" → `mark_done` + tapback<br>7. preference propose → "sure" → active<br>8. syllabus PDF (dev URL) → confirmation bubbles<br>9. `draft_email` stubbed Google → pending action not confirmable in the same run<br>10. STOP → no reply; START resumes<br>11. "pause till tomorrow" → `deliver(proactive)` queued past the pause<br>12. `count(*) group by idempotency_key having count>1` = 0<br>Leaves zero rows. |
| **5.4** | Web Playwright e2e + visual QA (web W10) | `tests/e2e/**`, presentation-only fixes in `src/app/**` | Web §10 e2e flows pass on iphone-15 (Chrome). Screenshot set at 375/393/430/1280 in light, dark and reduced motion. No horizontal scroll. Manual a11y checklist done. |
| **5.5** | Code review (after 5.1–5.4) | read-only; findings report | Run the `code-review` skill at `high` over the full V2 diff, focused on friend-protections (no send without confirm, evidence gating, untrusted wrapping), double-send paths, RLS/grants, secrets in logs, and DST. The orchestrator triages fixes. |

---

## §6 Decisions for Daniel

Each item has a default that we'll use if Daniel doesn't answer.

| # | Decision | Default |
|---|---|---|
| D1 | **Debounce deviation:** keep the debounce window in the Postgres `jobs` row (strongly consistent, crash-durable) instead of Upstash as you decided. Upstash still holds the run lease and rate limits. Upstash reads are eventually consistent, which can produce double or missed runs. | **Jobs row** |
| D2 | App icon: new V2 "a" mark (crisp, on-palette) vs crop of `Aria_Logo.png` (~335 px source, purple-cyan) | **V2 mark** |
| D3 | Parser hosting: Google Cloud Run (needs a **billing account + card**; $5 budget alert; expected $0) vs Vercel Python fallback (3 MB PDF cap) | **Cloud Run** |
| D4 | If Google Console rejects `<app>.vercel.app` as an authorized domain: buy a domain (~$10–11/yr, Cloudflare) | **Try vercel.app first; buy only if rejected** |
| D5 | Minimal `/privacy` + `/terms` pages (Google's "In production" branding form asks for them) | **Build minimal pages** |
| D6 | Separate Anthropic API key (workspace `aria-parser`) for the Python service | **Yes** |
| D7 | Syllabus primary model: Sonnet 5.5 (~$0.13–0.20/syllabus) vs trying Haiku 5.5 (~20× cheaper) | **Sonnet now; week-1 bake-off on 10 syllabi** |
| D8 | May urgent alerts (e.g. a midnight deadline moved at 10:30pm) break quiet hours? | **No** (defer to quiet end; user-set reminders do bypass) |
| D9 | Crisis rule: persona replies to self-harm cues with care + 988 | **Include** |
| D10 | Few-shots: ship V2-04's 21 reconstructed exchanges until you paste your original example conversations | **Ship reconstructed** |
| D11 | Dev vs prod DB: today both share one Supabase project, so the prod 15s tick can claim local-dev jobs. Option: a second free Supabase project `aria-dev`. Also, GitHub Actions keepalive (only useful if the repo is private). | **Create `aria-dev` (free); add the GH keepalive only if the repo is private** |
| D12 | Sendblue account settings: auto typing indicator ON, auto mark-read ON, no `outbound` status webhook | **As stated** |

---

## §7 Credentials and runbooks

### 7.1 What Daniel creates (all under Daniel's accounts)

| Account | Steps | Produces |
|---|---|---|
| **Sendblue sandbox** | Sign up at `dashboard.sendblue.com/company-signup`. Create the API key/secret. Webhook `receive` → `<APP_BASE_URL>/api/channels/sendblue` with `globalSecret` = `SENDBLUE_SIGNING_SECRET`. Enable auto-typing + mark-read (D12). `sendblue add-contact` for each friend (≤10), then each friend texts once. | `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_SIGNING_SECRET`, `SENDBLUE_FROM_NUMBER` |
| **Google Cloud** | V2-07 §6.2 steps 1–11: project `aria-v2`; enable Gmail, Calendar and Pub/Sub; Branding (no logo; privacy/terms URLs from D5); authorized domain check (D4); publish **In production**; manual scopes; Web client with prod + localhost redirect URIs; topic `gmail-push` + publisher grant; SA `gmail-push-invoker`; push subscription with audience. **Link a billing account** (Pub/Sub + Cloud Run). | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_SERVICE_ACCOUNT`, `GMAIL_PUSH_SUBSCRIPTION` |
| **Upstash** | Free Redis DB (region near `iad1`), REST API | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| **Cloud Run parser** | V2-08 §12 steps 0–5: secrets, SA `aria-parser`, `gcloud run deploy aria-parser --source services/parser --region us-east4 … --max-instances 2`, Artifact Registry keep-3, $5 budget | `PARSER_SERVICE_URL`, `PARSER_SHARED_SECRET` |
| **Anthropic** | Workspace `aria-parser` key (D6) | parser `ANTHROPIC_API_KEY` |
| **Vercel (Hobby)** | Import repo; Node 24; set every §4 prod var (`CRON_SECRET` = `openssl rand -hex 32`); production domain → `APP_BASE_URL` | deployed URL |
| **Supabase `aria-dev`** (D11) | New free project; `supabase db push` 001–003 there; `.env.local` points at it | dev keys |

### 7.2 Post-deploy runbook (after the first Vercel deploy)

1. **Vault + tick** (`scripts/ops/configure-jobs-tick.sql`, owned by 1.1):

   ```sql
   select vault.create_secret('<APP_BASE_URL>/api/jobs/dispatch', 'aria_dispatch_url', 'jobs tick target');
   select vault.create_secret('<JOBS_DISPATCH_SECRET>', 'aria_dispatch_secret', 'jobs tick HMAC');
   -- verify
   select jobname, schedule, active from cron.job order by 1;    -- 5 jobs: aria-jobs-tick, aria-retention-enqueue,
                                                                 -- aria-cron-history-purge, canvas-sync-enqueue, timeline-cleanup
   select public.enqueue_job('noop', null, now(), '{"note":"deploy-check"}'::jsonb);
   -- within ~30s:
   select status from public.jobs where payload->>'note' = 'deploy-check';                    -- done
   select status_code, created from net._http_response order by created desc limit 3;         -- 202
   -- rotation: select vault.update_secret((select id from vault.secrets where name='aria_dispatch_secret'), '<new>');
   ```

2. **Vercel crons.** Both crons appear in the dashboard. `curl -H "Authorization: Bearer $CRON_SECRET" $APP_BASE_URL/api/cron/daily` returns 200, and `system_heartbeat` updates.
3. **Sendblue.** Point the webhook at the deployed URL, send a test text, and check that the webhook logs 200 in under 1s.
4. **Google.** Confirm the redirect URI and Pub/Sub push endpoint use the deployed host. Do a first connect with Daniel's personal Gmail.
5. **Parser.** `curl $PARSER_SERVICE_URL/healthz`. Set `SYLLABUS_MEDIA_ALLOWED_HOSTS` from the first real Sendblue PDF payload.

### 7.3 Verify when credentials arrive (merged; details in each plan's §12)

**Sendblue** (V2-03 §12 items 1–11; V2-04 §12; V2-08 V3):
1. The `sb-signing-secret` header is a static secret.
2. Canonical base URL: `.com` vs `.co`.
3. Fixtures captured for iMessage text, photo, PDF, multi-attachment, inline reply, SMS from Android, and Apple ID email sender.
4. Inbound tapback shape. This decides `x_` evidence ("❤️ = yes").
5. Send response carries `message_handle`.
6. Typing, reactions and inline replies on the sandbox line.
7. STOP/START behaviour.
8. vCard renders, and links expand.
9. Sandbox limits; whether there is a 24h window for proactive messages.
10. Media CDN host.

**Upstash** (V2-03 #13): `SET NX PX` and the Lua release; byte-exact tokens with `automaticDeserialization: false`.

**Supabase** (V2-03 #14–18, V2-06 #1):
1. Postgres version ≥ 15.1.1.61.
2. The 15s cron runs on Free.
3. `extensions.hmac` exists.
4. Vault is readable by cron.
5. pg_net timeout.
6. Free-tier pausing behaviour over 8 days.

**Vercel** (V2-03 #19–22, V2-06 #2, #6):
1. `maxDuration = 300` takes effect.
2. `after()` runs ≥ 60s.
3. pg_net 5s timeout vs cold start.
4. Cron bearer.
5. Node 24 + ICU zones.

**Anthropic** (V2-04 §12):
1. Cache read on the second identical call.
2. Haiku TTFT p50/p95, adaptive vs disabled thinking.
3. Strict grammar compiles with all 31 tools.
4. Sonnet reads Haiku thinking blocks.
5. Briefing token counts (V2-06 #5).

**Google** (V2-07 §12 items 1–18):
1. `vercel.app` authorized domain.
2. Scope classes.
3. In production.
4. Unverified screen.
5. Granular consent.
6. PKCE accepted for Web clients.
7. Refresh token on reconnect.
8. Aria calendar created.
9. Watch expiry.
10. Gmail push JWT.
11. Threaded send + `Message-ID` preserved.
12. `authuser` permalink.
13. Yale EliApps block test.
14. Revocation → exactly one message.
15. Triage cost.

**Canvas** (V2-05 §12 items 1–13): Daniel's Yale feed. Id shape, content type, ETag, course-code format → `courseKey`, date-only spot checks, overrides, revocation signature, fetch from Vercel `iad1`, hourly slot, DST on 2026-11-01.

**Parser** (V2-08 §12 V1–V10): healthz cold start, 401, end to end, re-send hit, non-syllabus, upload ≤ 4 MB, clean logs, billing $0, secret rotation.

**Web** (web §12): iMessage previews per kind, preview fetch doesn't burn the token, `sms:` buttons, Canvas guide on iPhone, Google on iPhone, `/week` around midnight, safe areas, dark mode, PWA copy, export/delete, the draft send path, security headers.

---

## §8 Known risks (merged, deduped, ranked)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **Haiku 5.5 latency.** 9.7s TTFT with thinking (spec §4.6) against the p95 ≈ 12s exit gate. | Core UX | Ack fast path; instant typing; 8s interim; effort `low`; eval-gated switch to `thinking:disabled` (V2-04 Q6); Luna bake-off later |
| 2 | **Contract drift across 24 parallel tasks** | Integration breaks | Wave 0 frozen types + stubs; registry test; signature-change requests only through the orchestrator; per-wave gates with `tsc` + smoke |
| 3 | **Sendblue unknowns.** No creds; undocumented inbound tapbacks, email-handle field, sandbox reactions/inline-reply support, base URL. | Reactions, `x_` evidence, identity | Dev provider; lenient zod parsing; capability flags with fallbacks (`unsupported_on_this_line` disables reactions); §7.3 capture list |
| 4 | **Prompt injection** via email, Canvas, calendar, syllabus | Data exfiltration or unwanted actions | No send tool; evidence gate; taint; single `wrapUntrusted`; deterministic recipients; read-only web recipients; injection evals (5.1) |
| 5 | **Google gating.** `vercel.app` domain rejection, unverified-app friction, Yale EliApps block, 100-user lifetime cap | Gmail/Calendar unavailable to some friends | D4 domain fallback; personal-Gmail guidance; one consent with granular gating |
| 6 | **Supabase Free.** Pausing, sub-minute cron on Free unverified, dev/prod shared DB cross-claims | Scheduled work stops | Daily Vercel crons + heartbeat write; D11 dev project; prod refuses the `dev` provider (cross-claims dead-letter harmlessly) |
| 7 | **Vercel Hobby limits.** 300s cap, `after()` killed with the invocation, pg_net 5s timeout vs cold start, no Skew Protection | Lost turns, stale actions | Jobs backstop (15s tick + daily cron); 330s lock; orphan recovery; idempotency keys; "Aria just updated" reload path |
| 8 | **Double sends** (retries, reclaimed jobs, web + chat confirm) | Trust | Outbound rows inserted before send with unique `idempotency_key`; no auto-resend on ambiguous failure; `proactive_dedupe`; atomic pending transitions; sent-folder lookup |
| 9 | **Cost spikes:** Sonnet escalations, Opus syllabus escalation, triage, drafts | Budget | Atomic 10% cap (`claim_escalation`); parser max-instances 2 + $5 budget; 5 parses/day; drafts ≤20/day; `llm_calls` on every call |
| 10 | **Canvas fetch from Vercel egress** (WAF 403s) and errors in the school list | Canvas sync fails | Slow-transient class + 48h notice; probed list corrections; "Other" host path with Canvas proof |
| 11 | **Preserved-thinking 400s** if the message array is mutated mid-run | Agent failures | Append-only invariant test (V2-04 loop test 3) |
| 12 | **Static prefix size / strict-tool budget** with 31 tools (~9k tokens) | Cost, grammar compile failures | Registry budget test; 1h static TTL; live grammar check (§7.3 Anthropic #3) |
| 13 | **Lost change batch** (crash between `timeline_apply` commit and enqueue) | Missed alert | Retry enqueue once; the next sync recomputes; outbox column is the production fix (V2-05 Q18) |
| 14 | **Proactive item expiring inside the outbox** after a persisted deferral is dropped (logged), not turned into a briefing note | Missed far-out alert | Producers use `deferMode:"return"` + `expiresAt` for alerts that need a fallback (V2-06 alerts do) |
| 15 | **Migration 003 not executed locally** during integration (permission denied) | Push failure | Wave 0.1(b) dry-run before `db push` |
