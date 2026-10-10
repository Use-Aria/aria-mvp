import "server-only";
// OWNER: 3.1

/**
 * Conversation turn orchestration (V2-03 §2.2–2.4, §2.7, §2.9; master plan §1.2). The body of the
 * `conversation_turn` job.
 *
 * One turn, under the per-user run lease:
 * 1. Deleted / missing user → done (ignored). Lease held by another run → reschedule +3s without
 *    consuming anything (the active run's follow-up pass or drain picks the messages up).
 * 2. Orphan recovery: any `agent_runs` row of this user still `running` belongs to a crashed
 *    invocation. Nothing sent → its inbound is un-consumed; something sent → not replayed. Both
 *    are marked `failed`.
 * 3. Opted-out channel → unconsumed inbound is closed without a run; nothing is sent.
 * 4. Pass 1: insert the `agent_runs` row (`running`, trigger, channel, `is_eval=false`), atomically
 *    consume every unconsumed inbound message (oldest first), and collect the user's tapbacks on
 *    Aria messages since the last finished run. Nothing new → the row is deleted, done.
 *    A reaction-only turn still runs the agent (`newMessages: []`).
 * 5. First contact (no welcome on this channel yet): deterministic welcome + vCard
 *    (`welcome:<channelId>:<i>`), `scheduleNextBriefing`. A greeting-only first text stops there
 *    (run trigger `welcome`); otherwise the agent runs with `identity.isNewUser` and `welcomeSent`.
 * 6. Daily turn cap (200/local day) → one "breather" bubble per day, no agent.
 * 7. Agent run with the 8s watchdog (one interim per run) and an abort signal (run deadline − 30s,
 *    lease loss). The plan is validated (interim → cap 2) and delivered with bubble keys
 *    `<runId>:<i>`. The pipeline sets `status`, `finished_at`, `error`; the agent writes the stats.
 * 8. Agent throws → un-consume + `retry`; on the last attempt one fallback bubble instead (messages
 *    stay consumed). Lease lost mid-run → un-consume + reschedule, nothing more is sent.
 * 9. Messages that arrived mid-run → exactly one follow-up pass (`isFollowUpPass`, new run row).
 * 10. Release the lease, then drain: claim the user's next due `turn:<userId>` job inline.
 */
import { randomUUID } from "node:crypto";
import { channelContext } from "@/server/channels";
import { deliverReply, type DeliverResult } from "@/server/channels/deliver";
import { capDayStart } from "@/server/channels/guards";
import { detectRegister, pickInterim } from "@/server/channels/interim";
import { textPlan, validatePlan } from "@/server/channels/plan";
import * as repo from "@/server/channels/repo";
import type { ChannelRow } from "@/server/channels/repo";
import type { InboundMedia, ReactionType } from "@/server/channels/types";
import { db, type Db } from "@/server/db";
import { appBaseUrl, appOrigin } from "@/server/env";
import { errorText } from "@/server/jobs/runner";
import type { JobContext, JobOutcome } from "@/server/jobs/types";
import { maskHandle } from "@/server/phone";
import { getRunAgentTurn } from "@/server/pipeline/agent-impl";
import { PIPELINE } from "@/server/pipeline/config";
import { drainUserTurn, turnDedupeKey } from "@/server/pipeline/kick";
import { getLeaseStore, withHeartbeat, type LeaseStore } from "@/server/pipeline/lease";
import type {
  AgentTurnResult,
  IdentityState,
  InboundMessage,
  InboundReaction,
  RunAgentTurn,
} from "@/server/pipeline/types";
import { startWatchdog } from "@/server/pipeline/watchdog";
import { contactCardPlan, isGreetingOnly, welcomePlan } from "@/server/pipeline/welcome";
import { formatLocalDate, localDateOf, safeTimeZone } from "@/shared/time/tz";

/** Reschedule delay when another run holds the user's lease (or the lease was lost). */
export const LEASE_HELD_RETRY_MS = 3_000;
/** The agent's signal aborts this long before the run's hard deadline. */
export const AGENT_ABORT_MARGIN_MS = 30_000;
/** A follow-up pass starts only with at least this much of the run budget left. */
export const FOLLOW_UP_MIN_BUDGET_MS = 60_000;
/** The end-of-run drain only starts with at least this much budget left. */
export const DRAIN_MIN_BUDGET_MS = 45_000;
/** The drain waits for a pending turn job that becomes due within this long. */
export const DRAIN_MAX_WAIT_MS = 5_000;
/** Last-attempt fallback when the agent keeps failing (V2-03 §2.14). */
export const FALLBACK_TEXT = "ugh my brain glitched 😵 say that again?";
/** Sent once per local day when the daily turn cap is hit (V2-03 §2.12). */
export const BREATHER_TEXT = "ok I need a breather 😮‍💨 back tomorrow";

/** `agent_runs.trigger` values the pipeline writes. */
export type RunTrigger = "inbound" | "welcome";
/** `agent_runs.status` values the pipeline sets at the end. */
export type RunStatus = "done" | "failed" | "aborted";

/** The user fields a turn needs. */
export interface TurnUser {
  id: string;
  name: string | null;
  timezone: string;
  timezoneSource: IdentityState["timezoneSource"];
  deletedAt: Date | null;
}

/** DB access of a turn (the DB in production, an in-memory fake in unit tests). */
export interface TurnStore {
  /** The user, or null when missing. */
  loadUser(userId: string): Promise<TurnUser | null>;
  /** The user's primary channel, or null. */
  primaryChannel(userId: string): Promise<ChannelRow | null>;
  /** Inserts the `agent_runs` row (`status='running'`, `is_eval=false`). */
  createRun(input: { userId: string; channelId: string; trigger: RunTrigger }): Promise<{ id: string; startedAt: Date }>;
  /** Records the consumed inbound ids (and the final trigger) on the run. */
  setRunInputs(runId: string, messageIds: string[], trigger: RunTrigger): Promise<void>;
  /** Closes the run: status, `finished_at = now`, error/note. */
  finishRun(runId: string, status: RunStatus, error: string | null): Promise<void>;
  /** Deletes a still-running run that consumed nothing. */
  deleteRun(runId: string): Promise<void>;
  /** Atomically claims every unconsumed inbound message of the user for `runId`, oldest first. */
  consume(userId: string, runId: string): Promise<InboundMessage[]>;
  /** Releases a run's inbound messages. @returns rows released */
  unconsume(runId: string): Promise<number>;
  /** Unconsumed inbound messages of the user. */
  countUnconsumed(userId: string): Promise<number>;
  /** Whether the run wrote any outbound row. */
  hasOutbound(runId: string): Promise<boolean>;
  /** Ids of this user's non-eval runs still `running`. */
  orphanRuns(userId: string): Promise<string[]>;
  /** `started_at` of the user's latest finished (`done`) inbound/welcome run. */
  lastDoneRunStart(userId: string): Promise<Date | null>;
  /** User tapbacks on Aria messages whose add/remove time is in `(since, until]`, oldest first. */
  inboundReactions(userId: string, since: Date | null, until: Date): Promise<InboundReaction[]>;
  /** Whether the first-contact welcome was already sent (attempted) on this channel. */
  welcomeSent(channelId: string): Promise<boolean>;
  /** Non-eval inbound runs started at or after `since` (daily cap). */
  turnsSince(userId: string, since: Date): Promise<number>;
  /** Closes every unconsumed inbound message without an agent run. @returns rows closed */
  closeUnconsumed(userId: string, channelId: string, note: string): Promise<number>;
}

/** `deliverReply` input. */
export type DeliverReplyInput = Parameters<typeof deliverReply>[0];

/** Injectable dependencies of `runConversationTurn` (production defaults for all). */
export interface TurnDeps {
  lease: LeaseStore;
  runAgentTurn: RunAgentTurn;
  store: TurnStore;
  /** Pipeline reply delivery (`deliverReply`). */
  deliver: (input: DeliverReplyInput) => Promise<DeliverResult>;
  /** First-contact hook (`scheduleNextBriefing`). */
  scheduleNextBriefing: (userId: string, now: Date) => Promise<unknown>;
  /** End-of-run drain of the user's next due turn job. Never throws. */
  drain: (userId: string, budgetMs: number) => Promise<void>;
  /** Epoch-ms clock. */
  clock: () => number;
  appOrigin: () => string;
  appBaseUrl: () => string;
  /** Interim line picker randomness. */
  rng: () => number;
}

/** What a turn returns to the job runner, and whether to drain afterwards. */
interface TurnOutcome {
  result: JobOutcome;
  drain: boolean;
}

type PassResult = { kind: "delivered" } | { kind: "empty" } | { kind: "stop"; outcome: TurnOutcome };

const DONE: JobOutcome = { type: "done" };
const MEDIA_KINDS: ReadonlySet<string> = new Set(["image", "pdf", "audio", "video", "vcard", "other"]);

// ── DB store ────────────────────────────────────────────────────────────────

function fail(op: string, message: string): never {
  throw new Error(`[pipeline/turn] ${op}: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `messages.media` JSON → `InboundMedia[]` (unknown entries dropped).
 * @param json stored media column
 * @returns attachments
 */
export function parseInboundMedia(json: unknown): InboundMedia[] {
  if (!Array.isArray(json)) return [];
  const out: InboundMedia[] = [];
  for (const m of json) {
    if (!isRecord(m) || typeof m.url !== "string") continue;
    const kind = typeof m.kind === "string" && MEDIA_KINDS.has(m.kind) ? (m.kind as InboundMedia["kind"]) : "other";
    out.push({
      url: m.url,
      kind,
      ...(typeof m.contentType === "string" ? { contentType: m.contentType } : {}),
      ...(typeof m.filename === "string" ? { filename: m.filename } : {}),
      ...(typeof m.size === "number" ? { size: m.size } : {}),
    });
  }
  return out;
}

function timezoneSourceOf(v: string | null | undefined): IdentityState["timezoneSource"] {
  return v === "signup" || v === "user" || v === "inferred" ? v : "default";
}

/**
 * The production `TurnStore` (service-role client).
 * @param client Supabase client (default `db()`)
 * @returns the store
 */
export function createDbTurnStore(client: Db = db()): TurnStore {
  return {
    async loadUser(userId) {
      const { data, error } = await client
        .from("users")
        .select("id, name, timezone, timezone_source, deleted_at")
        .eq("id", userId)
        .maybeSingle();
      if (error) fail("loadUser", error.message);
      if (!data) return null;
      return {
        id: data.id,
        name: data.name,
        timezone: safeTimeZone(data.timezone),
        timezoneSource: timezoneSourceOf(data.timezone_source),
        deletedAt: data.deleted_at ? new Date(data.deleted_at) : null,
      };
    },

    primaryChannel: (userId) => repo.getPrimaryChannel(userId),

    async createRun({ userId, channelId, trigger }) {
      const { data, error } = await client
        .from("agent_runs")
        .insert({ user_id: userId, channel_id: channelId, status: "running", trigger, is_eval: false, input_message_ids: [] })
        .select("id, started_at")
        .single();
      if (error) fail("createRun", error.message);
      return { id: data.id, startedAt: new Date(data.started_at) };
    },

    async setRunInputs(runId, messageIds, trigger) {
      const { error } = await client.from("agent_runs").update({ input_message_ids: messageIds, trigger }).eq("id", runId);
      if (error) fail("setRunInputs", error.message);
    },

    async finishRun(runId, status, error) {
      const { error: e } = await client
        .from("agent_runs")
        .update({ status, finished_at: new Date().toISOString(), error: error ? error.slice(0, 500) : null })
        .eq("id", runId);
      if (e) fail("finishRun", e.message);
    },

    async deleteRun(runId) {
      const { error } = await client.from("agent_runs").delete().eq("id", runId).eq("status", "running");
      if (error) fail("deleteRun", error.message);
    },

    async consume(userId, runId) {
      const { data, error } = await client
        .from("messages")
        .update({ consumed_by_run: runId })
        .eq("user_id", userId)
        .eq("direction", "in")
        .is("consumed_by_run", null)
        .select("id, body, media, reply_to_message_id, created_at");
      if (error) fail("consume", error.message);
      return (data ?? [])
        .map((r) => ({
          id: r.id,
          body: r.body,
          media: parseInboundMedia(r.media),
          replyToMessageId: r.reply_to_message_id,
          createdAt: new Date(r.created_at),
        }))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    },

    async unconsume(runId) {
      const { data, error } = await client
        .from("messages")
        .update({ consumed_by_run: null })
        .eq("consumed_by_run", runId)
        .eq("direction", "in")
        .select("id");
      if (error) fail("unconsume", error.message);
      return data?.length ?? 0;
    },

    async countUnconsumed(userId) {
      const { count, error } = await client
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("direction", "in")
        .is("consumed_by_run", null);
      if (error) fail("countUnconsumed", error.message);
      return count ?? 0;
    },

    async hasOutbound(runId) {
      const { data, error } = await client
        .from("messages")
        .select("id")
        .eq("run_id", runId)
        .eq("direction", "out")
        .limit(1);
      if (error) fail("hasOutbound", error.message);
      return (data?.length ?? 0) > 0;
    },

    async orphanRuns(userId) {
      const { data, error } = await client
        .from("agent_runs")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "running")
        .eq("is_eval", false);
      if (error) fail("orphanRuns", error.message);
      return (data ?? []).map((r) => r.id);
    },

    async lastDoneRunStart(userId) {
      const { data, error } = await client
        .from("agent_runs")
        .select("started_at")
        .eq("user_id", userId)
        .eq("status", "done")
        .eq("is_eval", false)
        .in("trigger", ["inbound", "welcome"])
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) fail("lastDoneRunStart", error.message);
      const at = data?.[0]?.started_at;
      return at ? new Date(at) : null;
    },

    async inboundReactions(userId, since, until) {
      let q = client
        .from("reactions")
        .select("id, message_id, type, created_at, removed_at, messages!inner(user_id, direction)")
        .eq("actor", "user")
        .eq("messages.user_id", userId)
        .eq("messages.direction", "out");
      if (since) {
        const s = since.toISOString();
        q = q.or(`created_at.gt.${s},removed_at.gt.${s}`);
      }
      const { data, error } = await q.order("created_at", { ascending: true }).limit(50);
      if (error) fail("inboundReactions", error.message);
      return selectReactionWindow(
        (data ?? []).map((r) => ({
          id: r.id,
          messageId: r.message_id,
          type: r.type,
          createdAt: new Date(r.created_at),
          removedAt: r.removed_at ? new Date(r.removed_at) : null,
        })),
        since,
        until,
      );
    },

    async welcomeSent(channelId) {
      const { data, error } = await client
        .from("messages")
        .select("id")
        .eq("channel_id", channelId)
        .eq("direction", "out")
        .eq("trigger", "welcome")
        .limit(1);
      if (error) fail("welcomeSent", error.message);
      return (data?.length ?? 0) > 0;
    },

    async turnsSince(userId, since) {
      const { count, error } = await client
        .from("agent_runs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("trigger", "inbound")
        .eq("is_eval", false)
        .gte("started_at", since.toISOString());
      if (error) fail("turnsSince", error.message);
      return count ?? 0;
    },

    async closeUnconsumed(userId, channelId, note) {
      const { data, error } = await client
        .from("messages")
        .select("id")
        .eq("user_id", userId)
        .eq("direction", "in")
        .is("consumed_by_run", null);
      if (error) fail("closeUnconsumed", error.message);
      const ids = (data ?? []).map((r) => r.id);
      if (ids.length > 0) await repo.closeWithoutAgent({ userId, channelId, messageIds: ids, note });
      return ids.length;
    },
  };
}

/** A stored user reaction row (store-internal shape). */
export interface ReactionRow {
  id: string;
  messageId: string;
  type: string;
  createdAt: Date;
  removedAt: Date | null;
}

/**
 * Which reactions belong to a run (pure): those added or removed in `(since, until]`. A removed
 * reaction is reported as `removed` at its removal time.
 * @param rows stored user reactions on Aria messages
 * @param since previous finished run's start (exclusive), or null for "ever"
 * @param until this run's start (inclusive)
 * @returns `InboundReaction[]`, oldest first
 */
export function selectReactionWindow(rows: ReactionRow[], since: Date | null, until: Date): InboundReaction[] {
  const out: InboundReaction[] = [];
  for (const r of rows) {
    const at = r.removedAt ?? r.createdAt;
    if (at.getTime() > until.getTime()) continue;
    if (since && at.getTime() <= since.getTime()) continue;
    out.push({
      id: r.id,
      targetMessageId: r.messageId,
      type: r.type as ReactionType,
      removed: r.removedAt !== null,
      createdAt: at,
    });
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// ── defaults ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Default drain: if the user's pending turn job becomes due within `DRAIN_MAX_WAIT_MS`, wait for
 * it, then claim it inline (`drainUserTurn`). Never throws.
 */
async function drainAfterRun(userId: string, budgetMs: number): Promise<void> {
  try {
    const { data, error } = await db()
      .from("jobs")
      .select("run_at")
      .eq("dedupe_key", turnDedupeKey(userId))
      .eq("status", "pending")
      .limit(1);
    if (error) throw new Error(error.message);
    const runAt = data?.[0]?.run_at;
    if (!runAt) return;
    const wait = Date.parse(runAt) - Date.now();
    if (wait > DRAIN_MAX_WAIT_MS) return;
    if (wait > 0) await sleep(wait + 50);
    await drainUserTurn(userId, { budgetMs: Math.max(0, budgetMs - Math.max(0, wait)) });
  } catch (e) {
    console.error(`[pipeline] drain lookup failed: ${errorText(e)}`);
  }
}

function defaultDeps(): TurnDeps {
  return {
    lease: getLeaseStore(),
    runAgentTurn: getRunAgentTurn(),
    store: createDbTurnStore(),
    deliver: deliverReply,
    scheduleNextBriefing: async (userId, now) => {
      const { scheduleNextBriefing } = await import("@/server/briefing/scheduler");
      return scheduleNextBriefing(userId, now);
    },
    drain: drainAfterRun,
    clock: Date.now,
    appOrigin,
    appBaseUrl,
    rng: Math.random,
  };
}

function resolveDeps(deps: Partial<TurnDeps>): TurnDeps {
  // Build only the defaults that are missing (tests inject everything; no DB client needed).
  const keys: (keyof TurnDeps)[] = [
    "lease", "runAgentTurn", "store", "deliver", "scheduleNextBriefing", "drain", "clock", "appOrigin", "appBaseUrl", "rng",
  ];
  if (keys.every((k) => deps[k] !== undefined)) return deps as TurnDeps;
  return { ...defaultDeps(), ...deps };
}

// ── turn ────────────────────────────────────────────────────────────────────

interface TurnCtx {
  d: TurnDeps;
  job: JobContext;
  user: TurnUser;
  channel: ChannelRow;
  /** Aborts on lease loss or the job's hard deadline: no further sends. */
  runSignal: AbortSignal;
  /** Epoch ms: min(job deadline, turn start + run deadline). */
  hardDeadline: number;
  leaseLost: () => boolean;
}

function reschedule(d: TurnDeps, reason: string): JobOutcome {
  return { type: "reschedule", runAt: new Date(d.clock() + LEASE_HELD_RETRY_MS), reason };
}

function deliveryNote(r: DeliverResult): string | null {
  switch (r.status) {
    case "sent":
      return null;
    case "suppressed":
      return `delivery suppressed: ${r.reason}`;
    case "failed":
      return `delivery failed: ${r.error}`;
    default:
      return `delivery ${r.status}`;
  }
}

/**
 * Runs one conversation turn for a user (the `conversation_turn` job body).
 * @param userId users.id from the job payload
 * @param job runner context (attempt, deadline, abort signal)
 * @param deps injected dependencies (tests); production defaults otherwise
 * @returns the job outcome: `done`, `retry` (agent failed; inbound un-consumed) or `reschedule`
 *   (another run holds the lease, or the lease was lost mid-run)
 * @throws on DB errors (the runner retries; orphan recovery cleans up on the next attempt)
 */
export async function runConversationTurn(
  userId: string,
  job: JobContext,
  deps: Partial<TurnDeps> = {},
): Promise<JobOutcome> {
  const d = resolveDeps(deps);
  const turnStart = d.clock();
  const user = await d.store.loadUser(userId);
  if (!user || user.deletedAt) {
    console.info(`[pipeline] turn for ${user ? "deleted" : "missing"} user ${userId.slice(0, 8)}: ignored`);
    return DONE;
  }

  const owner = randomUUID();
  if (!(await d.lease.acquire(userId, owner, PIPELINE.leaseTtlMs))) return reschedule(d, "lease_held");

  const runAbort = new AbortController();
  let lost = false;
  const onJobAbort = (): void => runAbort.abort();
  if (job.signal.aborted) runAbort.abort();
  else job.signal.addEventListener("abort", onJobAbort, { once: true });
  const stopHeartbeat = withHeartbeat(d.lease, userId, owner, PIPELINE.leaseTtlMs, PIPELINE.heartbeatMs, () => {
    lost = true;
    console.warn(`[pipeline] lease lost mid-run for user ${userId.slice(0, 8)}; aborting sends`);
    runAbort.abort();
  });
  const hardDeadline = Math.min(job.deadline, turnStart + PIPELINE.runDeadlineMs);

  let outcome: TurnOutcome;
  try {
    await recoverOrphans(d, userId);
    outcome = await runTurn(d, job, user, runAbort.signal, hardDeadline, () => lost);
  } finally {
    stopHeartbeat();
    job.signal.removeEventListener("abort", onJobAbort);
    try {
      await d.lease.release(userId, owner);
    } catch (e) {
      console.error(`[pipeline] lease release failed (expires in ≤${PIPELINE.leaseTtlMs / 1000}s): ${errorText(e)}`);
    }
  }

  if (outcome.drain) {
    const budget = hardDeadline - d.clock();
    if (budget >= DRAIN_MIN_BUDGET_MS) await d.drain(userId, budget);
  }
  return outcome.result;
}

/** Closes runs left `running` by a crashed invocation (V2-03 §2.2 orphan recovery). */
async function recoverOrphans(d: TurnDeps, userId: string): Promise<void> {
  for (const id of await d.store.orphanRuns(userId)) {
    if (await d.store.hasOutbound(id)) {
      await d.store.finishRun(id, "failed", "orphan: partial send, not replayed");
      console.warn(`[pipeline] orphan run ${id.slice(0, 8)} had sent; not replayed`);
    } else {
      const n = await d.store.unconsume(id);
      await d.store.finishRun(id, "failed", `orphan: recovered ${n} message(s)`);
      console.warn(`[pipeline] orphan run ${id.slice(0, 8)} recovered (${n} message(s) un-consumed)`);
    }
  }
}

async function runTurn(
  d: TurnDeps,
  job: JobContext,
  user: TurnUser,
  runSignal: AbortSignal,
  hardDeadline: number,
  leaseLost: () => boolean,
): Promise<TurnOutcome> {
  const channel = await d.store.primaryChannel(user.id);
  if (!channel) {
    console.warn(`[pipeline] user ${user.id.slice(0, 8)} has no channel; turn dropped`);
    return { result: DONE, drain: false };
  }
  if (channel.opted_out_at) {
    const n = await d.store.closeUnconsumed(user.id, channel.id, "ignored: opted out");
    if (n > 0) console.info(`[pipeline] ${maskHandle(channel.handle)} is opted out; ${n} message(s) closed`);
    return { result: DONE, drain: false };
  }

  const ctx: TurnCtx = { d, job, user, channel, runSignal, hardDeadline, leaseLost };
  const first = await runPass(ctx, false);
  if (first.kind === "stop") return first.outcome;
  if (first.kind === "empty") return { result: DONE, drain: true };

  // Messages that arrived while pass 1 ran get exactly one follow-up pass (spec: "loop once").
  if (!runSignal.aborted && hardDeadline - d.clock() >= FOLLOW_UP_MIN_BUDGET_MS && (await d.store.countUnconsumed(user.id)) > 0) {
    const second = await runPass(ctx, true);
    if (second.kind === "stop") return second.outcome;
  }
  return { result: DONE, drain: true };
}

async function runPass(c: TurnCtx, isFollowUpPass: boolean): Promise<PassResult> {
  const { d, user, channel } = c;
  const passStart = d.clock();
  const run = await d.store.createRun({ userId: user.id, channelId: channel.id, trigger: "inbound" });
  const batch = await d.store.consume(user.id, run.id);
  const reactions = await d.store.inboundReactions(user.id, await d.store.lastDoneRunStart(user.id), run.startedAt);
  if (batch.length === 0 && !reactions.some((r) => !r.removed)) {
    await d.store.deleteRun(run.id);
    return { kind: "empty" };
  }

  const firstContact = !isFollowUpPass && !(await d.store.welcomeSent(channel.id));
  const greetingOnly =
    firstContact && batch.length > 0 && batch.every((m) => m.media.length === 0 && !!m.body && isGreetingOnly(m.body));
  await d.store.setRunInputs(run.id, batch.map((m) => m.id), greetingOnly ? "welcome" : "inbound");
  const register = detectRegister(batch.map((m) => m.body ?? "").filter((t) => t.trim().length > 0));
  const send = (input: Omit<DeliverReplyInput, "userId" | "channelId" | "runId" | "signal">): Promise<DeliverResult> =>
    d.deliver({ ...input, userId: user.id, channelId: channel.id, runId: run.id, signal: c.runSignal });

  let welcomeSent = false;
  if (firstContact) {
    const w = await send({
      plan: welcomePlan({ name: user.name, register }),
      elapsedMs: d.clock() - passStart,
      trigger: "welcome",
      keyPrefix: `welcome:${channel.id}`,
    });
    welcomeSent = w.status === "sent" || (w.status === "suppressed" && w.reason === "duplicate");
    if (welcomeSent) {
      await send({ plan: contactCardPlan(d.appBaseUrl()), elapsedMs: 0, trigger: "contact_card", keyPrefix: `welcome:${channel.id}:card` });
    }
    try {
      await d.scheduleNextBriefing(user.id, new Date(d.clock()));
    } catch (e) {
      console.error(`[pipeline] first-contact scheduleNextBriefing failed: ${errorText(e)}`);
    }
    if (greetingOnly) {
      await d.store.finishRun(run.id, "done", deliveryNote(w));
      return { kind: "stop", outcome: { result: DONE, drain: true } };
    }
  }

  // Cost guard: N agent turns per local day, then one breather bubble per day.
  const now = new Date(d.clock());
  const tz = safeTimeZone(user.timezone);
  if ((await d.store.turnsSince(user.id, capDayStart(now, tz))) > PIPELINE.dailyTurnCap) {
    await send({
      plan: textPlan([BREATHER_TEXT]),
      elapsedMs: 0,
      trigger: "fallback",
      keyPrefix: `cap:${user.id}:${formatLocalDate(localDateOf(now, tz))}`,
    });
    await d.store.finishRun(run.id, "done", "daily_turn_cap");
    console.warn(`[pipeline] daily turn cap hit for ${maskHandle(channel.handle)}`);
    return { kind: "stop", outcome: { result: DONE, drain: false } };
  }

  // Agent signal: run deadline − 30s, or anything that aborts the run (lease loss, job deadline).
  const agentAbort = new AbortController();
  const relay = (): void => agentAbort.abort();
  if (c.runSignal.aborted) agentAbort.abort();
  else c.runSignal.addEventListener("abort", relay, { once: true });
  const agentTimer = setTimeout(relay, Math.max(0, c.hardDeadline - AGENT_ABORT_MARGIN_MS - d.clock()));
  agentTimer.unref?.();

  // Object state: closures assign it, so control-flow narrowing must not pin it to its initializer.
  const im: { claimed: boolean; sent: boolean; at: number | null; flight: Promise<boolean> | null } = {
    claimed: false,
    sent: false,
    at: null,
    flight: null,
  };
  const interim = (text: string): Promise<boolean> => {
    if (im.claimed || c.runSignal.aborted) return Promise.resolve(false);
    im.claimed = true;
    im.flight = (async () => {
      const r = await send({ plan: textPlan([text]), elapsedMs: d.clock() - passStart, trigger: "interim", keyPrefix: `${run.id}:interim` });
      im.sent = r.status === "sent";
      if (im.sent) im.at = d.clock();
      return im.sent;
    })();
    return im.flight;
  };
  // "8s with no bubble sent": the first-contact welcome already counts as a bubble.
  const watchdog = welcomeSent
    ? null
    : startWatchdog(PIPELINE.watchdogMs, async () => {
        await interim(pickInterim(register, c.d.rng));
      });

  let result: AgentTurnResult | null = null;
  let failure: unknown = null;
  let threw = false;
  try {
    result = await d.runAgentTurn({
      userId: user.id,
      runId: run.id,
      now,
      timezone: tz,
      channel: channelContext(channel, { now }),
      identity: { isNewUser: firstContact, name: user.name, timezone: tz, timezoneSource: user.timezoneSource },
      trigger: { kind: "inbound" },
      newMessages: batch,
      inboundReactions: reactions,
      isFollowUpPass,
      welcomeSent,
      isEval: false,
      signal: agentAbort.signal,
      interim,
    });
  } catch (e) {
    threw = true;
    failure = e;
  } finally {
    watchdog?.cancel();
    clearTimeout(agentTimer);
    c.runSignal.removeEventListener("abort", relay);
  }
  // Never let an in-flight interim interleave with the reply.
  if (im.flight) await im.flight;

  if (c.runSignal.aborted) {
    // Lease lost (another run may own the user now) or the invocation is out of time: send nothing
    // more; the reply was never delivered, so the inbound goes back for the next run.
    const n = await c.d.store.unconsume(run.id);
    await d.store.finishRun(run.id, "aborted", c.leaseLost() ? "lease lost" : "run deadline");
    console.warn(`[pipeline] run ${run.id.slice(0, 8)} aborted (${c.leaseLost() ? "lease lost" : "deadline"}); ${n} message(s) released`);
    return { kind: "stop", outcome: { result: reschedule(d, c.leaseLost() ? "lease_lost" : "deadline"), drain: false } };
  }

  if (threw || !result) {
    const err = errorText(failure);
    if (c.job.attempt >= c.job.maxAttempts) {
      // Last attempt: one fallback bubble, the messages stay consumed (no further retries).
      const fb = await send({ plan: textPlan([FALLBACK_TEXT]), elapsedMs: 0, trigger: "fallback", keyPrefix: `${run.id}:fallback` });
      await d.store.finishRun(run.id, "failed", err);
      console.error(`[pipeline] agent failed on the last attempt (${err}); fallback ${fb.status}`);
      return { kind: "stop", outcome: { result: DONE, drain: true } };
    }
    const n = await d.store.unconsume(run.id);
    await d.store.finishRun(run.id, "failed", err);
    console.warn(`[pipeline] agent failed (attempt ${c.job.attempt}/${c.job.maxAttempts}): ${err}; ${n} message(s) released`);
    return { kind: "stop", outcome: { result: { type: "retry", error: err }, drain: false } };
  }

  const { plan } = validatePlan(result.plan, { appOrigin: d.appOrigin(), interimSent: im.sent || result.interimSent });
  const dr = await send({
    plan,
    elapsedMs: d.clock() - (im.at ?? passStart),
    trigger: "reply",
    keyPrefix: run.id,
  });
  await d.store.finishRun(run.id, "done", deliveryNote(dr));
  if (dr.status === "failed") console.warn(`[pipeline] reply delivery to ${maskHandle(channel.handle)} failed: ${dr.error}`);
  return { kind: "delivered" };
}
