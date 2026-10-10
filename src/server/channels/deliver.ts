import "server-only";
// OWNER: 2.1

/**
 * Delivery: guards, per-user outbox, execute (master plan §1.1; merges V2-03 §7 + V2-06 §8, C9).
 *
 * - `deliverReply` (pipeline-internal): render → execute with run bookkeeping; opt-out is the only
 *   guard (bypassable for command confirmations).
 * - `deliver(…, {proactive: false})`: direct follow-ups (connect confirmations, syllabus result,
 *   triage digest). Skips every guard except opt-out.
 * - `deliver(…, {proactive: true})`: at-most-once per `dedupeKey` (`proactive_dedupe`, claimed
 *   before the send). Opt-out drops; an item whose earliest allowed send is after `expiresAt` is
 *   `suppressed:"expired"` right away. `urgent`/`requested` items allowed now are flushed inline
 *   (`sent`); everything else joins the per-user outbox (`proactive_flush`, dedupe
 *   `outbox:<userId>`, append mode) and is `queued`. With `deferMode:"return"`, a guard deferral
 *   (pause, quiet hours, cap, follow-up quota, notBefore) returns `deferred` and persists nothing;
 *   bundling and the 30s live-conversation wait are outbox mechanics, not deferrals.
 * - `flushOutbox`: re-applies every guard per item at send time, merges what's sendable into one
 *   plan (bubble keys `<jobId>:<i>`), re-queues what's still deferred (never dropped), drops
 *   opted-out / expired / already-delivered items (logged).
 */
import { randomUUID } from "node:crypto";
import { appOrigin } from "@/server/env";
import { maskHandle } from "@/server/phone";
import { channelContext, getProvider } from "@/server/channels";
import { executeSteps, type ExecuteIo } from "@/server/channels/execute";
import {
  capDayStart,
  earliestAllowedSend,
  effectiveQuietWindow,
  evaluateDelivery,
  outboxRunAt,
  type GuardState,
} from "@/server/channels/guards";
import { mergeOutboxItems, validatePlan } from "@/server/channels/plan";
import { renderPlan } from "@/server/channels/render";
import * as repo from "@/server/channels/repo";
import type { ChannelRow, UserDeliveryState } from "@/server/channels/repo";
import type {
  ChannelProvider,
  OutboundTarget,
  OutboxItem,
  ProviderName,
  ReplyPlan,
} from "@/server/channels/types";
import { enqueueJob } from "@/server/jobs/enqueue";
import type { JobOutcome } from "@/server/jobs/types";
import { getLeaseStore } from "@/server/pipeline/lease";
import { PIPELINE } from "@/server/pipeline/config";
import { safeTimeZone } from "@/shared/time/tz";

export type DeliverPriority = "routine" | "urgent" | "requested";
export interface DeliverOptions {
  proactive: boolean;
  /** "briefing" | "reminder" | "deadline_nudge" | "due_change" | "email_alert" | "canvas_connected" |
   *  "google_connected" | "google_revoked" | "syllabus_parsed" | "gmail_triage_digest" | ... */
  reason: string;
  /** REQUIRED when proactive (at-most-once via proactive_dedupe);
   *  when !proactive it prefixes bubble idempotency keys ("<dedupeKey>:<i>") */
  dedupeKey?: string;
  /** default "routine" when proactive. urgent: bypasses cap+bundling, respects quiet;
   *  requested: bypasses quiet+cap. All respect opt-out + pause. */
  priority?: DeliverPriority;
  /** default: primary channel */
  channelId?: string;
  notBefore?: Date;
  /** if the earliest allowed send > expiresAt → suppressed:"expired" (checked synchronously) */
  expiresAt?: Date;
  /** persist (default): outbox job re-applies guards later; return: caller re-plans */
  deferMode?: "persist" | "return";
}
export type DeliverResult =
  | { status: "sent"; deliveryId: string; messageIds: string[] }
  | { status: "queued"; jobId: string; runAt: Date }
  /** deferMode "return" only; nothing persisted */
  | { status: "deferred"; until: Date }
  | { status: "suppressed"; reason: "opted_out" | "no_channel" | "deleted" | "duplicate" | "expired" | "invalid_plan" }
  | { status: "failed"; error: string };

type ReplyTrigger = "reply" | "interim" | "welcome" | "contact_card" | "command" | "fallback";

/** Outbox dedupe key of a user (one pending `proactive_flush` per user). */
export function outboxDedupeKey(userId: string): string {
  return `outbox:${userId}`;
}

/** True when a validated plan would send nothing. */
function isEmptyPlan(p: ReplyPlan): boolean {
  return p.bubbles.length === 0 && !p.link && (p.reactions?.length ?? 0) === 0 && (p.media?.length ?? 0) === 0;
}

function providerOf(channel: ChannelRow): ProviderName {
  return channel.provider === "dev" ? "dev" : "sendblue";
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ── send path ───────────────────────────────────────────────────────────────

interface SendContext {
  userId: string;
  channel: ChannelRow;
  runId: string | null;
  trigger: string;
  keyPrefix: string;
  elapsedMs: number;
  signal?: AbortSignal;
  proactiveClass: DeliverPriority | null;
  outsideWindow: boolean;
}

/** Renders and executes an already-validated plan on one channel, with outbound bookkeeping. */
async function sendPlan(plan: ReplyPlan, c: SendContext): Promise<DeliverResult> {
  let provider: ChannelProvider;
  try {
    provider = getProvider(providerOf(c.channel));
  } catch (e) {
    return { status: "failed", error: `provider_unavailable: ${e instanceof Error ? e.message : "error"}` };
  }
  const ctx = channelContext(c.channel, { provider });
  const target: OutboundTarget = { handle: c.channel.handle, line: c.channel.provider_line, service: ctx.service };
  const replyIds = [...new Set(plan.bubbles.map((b) => b.replyToMessageId).filter((x): x is string => !!x))];
  const snippets = !ctx.capabilities.inlineReplies && replyIds.length > 1 ? await repo.messageSnippets(replyIds) : {};
  const steps = renderPlan(plan, ctx.capabilities, { elapsedMs: c.elapsedMs, snippets });
  const deliveryId = randomUUID();

  const io: ExecuteIo = {
    provider,
    target,
    signal: c.signal,
    sleep: (ms) => abortableSleep(ms, c.signal),
    async beforeSend(step) {
      const id = await repo.insertOutbound({
        userId: c.userId,
        channelId: c.channel.id,
        provider: provider.name,
        body: step.text ?? null,
        media: step.mediaUrl ? [{ url: step.mediaUrl, kind: mediaKind(plan, step.mediaUrl) }] : null,
        runId: c.runId,
        deliveryId,
        trigger: c.trigger,
        idempotencyKey: `${c.keyPrefix}:${step.bubbleIndex}`,
        service: ctx.service,
        replyToMessageId: step.replyToMessageId ?? null,
        proactiveClass: c.proactiveClass,
        outsideWindow: c.outsideWindow,
      });
      return id ? { messageId: id } : null;
    },
    afterSend: (messageId, result) => repo.markOutbound(messageId, result),
    resolveProviderId: (messageId) => repo.getProviderMessageId(messageId),
    recordReaction: (targetMessageId, reaction) =>
      repo.recordReaction({ messageId: targetMessageId, actor: "aria", type: reaction }),
  };

  const report = await executeSteps(steps, io);
  if (report.declined && /opt/i.test(report.declined)) {
    try {
      await repo.setOptOut(c.channel.id, new Date(), "provider");
    } catch (e) {
      console.error(`[deliver] mirroring provider opt-out failed for ${maskHandle(target.handle)}: ${errText(e)}`);
    }
  }
  if (report.messageIds.length === 0 && report.skipped > 0) return { status: "suppressed", reason: "duplicate" };
  if (report.sent === 0 && report.failed > 0) {
    return { status: "failed", error: report.declined ? `declined:${report.declined}` : "send_failed" };
  }
  if (report.sent === 0 && report.aborted && report.messageIds.length === 0 && steps.some((s) => s.t === "send")) {
    return { status: "failed", error: "aborted" };
  }
  return { status: "sent", deliveryId, messageIds: report.messageIds };
}

function mediaKind(plan: ReplyPlan, url: string): string {
  return plan.media?.find((m) => m.url === url)?.kind ?? "file";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── guards ──────────────────────────────────────────────────────────────────

async function conversationActive(userId: string): Promise<boolean> {
  try {
    return await getLeaseStore().isHeld(userId);
  } catch (e) {
    // A broken lease store must not defer proactive sends forever.
    console.error(`[deliver] lease check failed: ${errText(e)}`);
    return false;
  }
}

/** Loads everything the pure guards need for one user + channel at `now`. */
async function loadGuardState(user: UserDeliveryState, channel: ChannelRow, now: Date): Promise<GuardState> {
  const tz = safeTimeZone(user.timezone);
  const ctx = channelContext(channel, { now });
  const [stats, active, followups] = await Promise.all([
    repo.proactiveStats(user.id, capDayStart(now, tz)),
    conversationActive(user.id),
    ctx.windowOpen ? Promise.resolve(0) : repo.followupRecipients24h(channel.provider_line, now),
  ]);
  return {
    tz,
    quiet: effectiveQuietWindow({ quietStart: user.quietStart, quietEnd: user.quietEnd }, ctx.service),
    optedOut: channel.opted_out_at !== null,
    pausedUntil: channel.paused_until ? new Date(channel.paused_until) : null,
    routineSentToday: stats.routineCount,
    lastProactiveAt: stats.lastProactiveAt,
    conversationActive: active,
    windowOpen: ctx.windowOpen,
    followupRecipients24h: followups,
    quietJitterMs: Math.floor(Math.random() * PIPELINE.quietJitterMaxMs),
  };
}

function withItemTiming(state: GuardState, notBefore: Date | null, expiresAt: Date | null): GuardState {
  return { ...state, notBefore, expiresAt };
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Deliver a plan to a user. Proactive plans go through every guard and the outbox;
 * `proactive: false` skips every guard except opt-out (direct follow-ups only).
 * @param userId recipient
 * @param plan reply plan
 * @param opts proactive flag, reason, dedupe key, priority, timing
 * @returns what happened (sent / queued / deferred / suppressed / failed)
 * @throws Error when `proactive` is set without a `dedupeKey` (programming error), or on DB errors
 */
export async function deliver(userId: string, plan: ReplyPlan, opts: DeliverOptions): Promise<DeliverResult> {
  const key = opts.dedupeKey;
  if (opts.proactive && !key) throw new Error(`deliver(${opts.reason}): dedupeKey is required when proactive`);
  const now = new Date();
  const user = await repo.getUserDeliveryState(userId);
  if (!user || user.deletedAt) return { status: "suppressed", reason: "deleted" };
  const channel = opts.channelId ? await repo.getChannel(opts.channelId) : await repo.getPrimaryChannel(userId);
  if (!channel || channel.user_id !== userId) return { status: "suppressed", reason: "no_channel" };

  const { plan: valid } = validatePlan(plan, { appOrigin: appOrigin() });
  if (isEmptyPlan(valid)) return { status: "suppressed", reason: "invalid_plan" };
  if (channel.opted_out_at) return { status: "suppressed", reason: "opted_out" };
  if (opts.expiresAt && opts.expiresAt.getTime() < now.getTime()) return { status: "suppressed", reason: "expired" };

  if (!opts.proactive || !key) {
    const ctx = channelContext(channel, { now });
    return sendPlan(valid, {
      userId,
      channel,
      runId: null,
      trigger: opts.reason,
      keyPrefix: key ? `d:${userId}:${key}` : `d:${randomUUID()}`,
      elapsedMs: 0,
      proactiveClass: null,
      outsideWindow: !ctx.windowOpen,
    });
  }

  const cls: DeliverPriority = opts.priority ?? "routine";
  if (await repo.dedupeExists(userId, key)) return { status: "suppressed", reason: "duplicate" };

  const state = withItemTiming(await loadGuardState(user, channel, now), opts.notBefore ?? null, opts.expiresAt ?? null);
  const decision = evaluateDelivery(state, cls, now);
  if (decision.action === "drop") return { status: "suppressed", reason: decision.reason };

  if (opts.deferMode === "return") {
    const guarded = earliestAllowedSend({ ...state, lastProactiveAt: null, conversationActive: false }, cls, now);
    if (guarded.at.getTime() > now.getTime()) return { status: "deferred", until: guarded.at };
  }

  if (cls !== "routine" && decision.action === "send") {
    if (!(await repo.claimDedupe(userId, key))) return { status: "suppressed", reason: "duplicate" };
    return sendPlan(valid, {
      userId,
      channel,
      runId: null,
      trigger: opts.reason,
      keyPrefix: `p:${userId}:${key}`,
      elapsedMs: 0,
      proactiveClass: cls,
      outsideWindow: !state.windowOpen,
    });
  }

  const hold = outboxRunAt(cls, now, state.lastProactiveAt);
  const until = decision.action === "defer" ? decision.until : now;
  const runAt = new Date(Math.max(hold.getTime(), until.getTime()));
  if (opts.expiresAt && runAt.getTime() > opts.expiresAt.getTime()) return { status: "suppressed", reason: "expired" };

  const item: OutboxItem = {
    plan: valid,
    reason: opts.reason,
    priority: cls,
    dedupeKey: key,
    channelId: opts.channelId ?? null,
    enqueuedAt: now.toISOString(),
    notBefore: opts.notBefore ? opts.notBefore.toISOString() : null,
    expiresAt: opts.expiresAt ? opts.expiresAt.toISOString() : null,
  };
  const job = await enqueueJob({
    kind: "proactive_flush",
    userId,
    dedupeKey: outboxDedupeKey(userId),
    mode: "append",
    runAt,
    payload: { items: [item] },
  });
  return { status: "queued", jobId: job.id, runAt: job.runAt };
}

/**
 * Pipeline-internal reply delivery with run bookkeeping and pacing credit.
 * @param input user, channel, run, plan, elapsed time, trigger, idempotency-key prefix
 *   (bubble keys are `<keyPrefix>:<i>`), abort signal, and `bypassOptOut` (opt-out confirmation only)
 * @returns delivery result (`suppressed:"duplicate"` when every bubble key already existed)
 */
export async function deliverReply(input: {
  userId: string;
  channelId: string;
  runId: string;
  plan: ReplyPlan;
  elapsedMs: number;
  trigger: ReplyTrigger;
  keyPrefix: string;
  signal?: AbortSignal;
  bypassOptOut?: boolean;
}): Promise<DeliverResult> {
  const channel = await repo.getChannel(input.channelId);
  if (!channel || channel.user_id !== input.userId) return { status: "suppressed", reason: "no_channel" };
  if (channel.opted_out_at && !input.bypassOptOut) return { status: "suppressed", reason: "opted_out" };
  const { plan } = validatePlan(input.plan, { appOrigin: appOrigin() });
  return sendPlan(plan, {
    userId: input.userId,
    channel,
    runId: input.runId || null,
    trigger: input.trigger,
    keyPrefix: input.keyPrefix,
    elapsedMs: input.elapsedMs,
    signal: input.signal,
    proactiveClass: null,
    outsideWindow: false,
  });
}

function strongestClass(items: OutboxItem[]): DeliverPriority {
  if (items.some((i) => i.priority === "routine")) return "routine";
  if (items.some((i) => i.priority === "urgent")) return "urgent";
  return "requested";
}

function triggerOf(items: OutboxItem[]): string {
  return [...new Set(items.map((i) => i.reason))].join("+").slice(0, 64);
}

function isoOrNull(s: string | null): Date | null {
  return s ? new Date(s) : null;
}

/**
 * Outbox flush (`proactive_flush` job handler body): re-apply guards, merge items, send.
 * Items still deferred are re-queued into the user's outbox (never dropped); opted-out, expired
 * and already-delivered items are dropped and logged.
 * @param userId owner of the outbox
 * @param jobId flushing job (bubble idempotency keys `<jobId>:<i>`)
 * @param items queued items
 * @param now clock
 * @returns job outcome (`done`; DB errors throw → retry)
 */
export async function flushOutbox(userId: string, jobId: string, items: OutboxItem[], now: Date): Promise<JobOutcome> {
  if (items.length === 0) return { type: "done" };
  const user = await repo.getUserDeliveryState(userId);
  if (!user || user.deletedAt) {
    console.info(`[deliver] outbox ${jobId.slice(0, 8)}: user gone, dropped ${items.length} item(s)`);
    return { type: "done" };
  }

  const delivered = await repo.deliveredKeys(userId, [...new Set(items.map((i) => i.dedupeKey))]);
  const seen = new Set<string>();
  const live = items.filter((i) => {
    if (delivered.has(i.dedupeKey) || seen.has(i.dedupeKey)) return false;
    seen.add(i.dedupeKey);
    return true;
  });
  const dropped = items.length - live.length;
  if (dropped > 0) console.info(`[deliver] outbox ${jobId.slice(0, 8)}: ${dropped} duplicate item(s) skipped`);

  const groups = new Map<string, { channel: ChannelRow; items: OutboxItem[] }>();
  for (const item of live) {
    const channel = item.channelId ? await repo.getChannel(item.channelId) : await repo.getPrimaryChannel(userId);
    if (!channel || channel.user_id !== userId) {
      console.warn(`[deliver] outbox ${jobId.slice(0, 8)}: no channel for a ${item.reason} item; dropped`);
      continue;
    }
    const g = groups.get(channel.id) ?? { channel, items: [] };
    g.items.push(item);
    groups.set(channel.id, g);
  }

  const requeue: { item: OutboxItem; until: Date }[] = [];
  let groupIndex = 0;
  for (const { channel, items: groupItems } of groups.values()) {
    const base = await loadGuardState(user, channel, now);
    const sendable: OutboxItem[] = [];
    for (const item of groupItems) {
      const d = evaluateDelivery(withItemTiming(base, isoOrNull(item.notBefore), isoOrNull(item.expiresAt)), item.priority, now);
      if (d.action === "send") sendable.push(item);
      else if (d.action === "defer") requeue.push({ item, until: d.until });
      else console.info(`[deliver] outbox ${jobId.slice(0, 8)}: ${item.reason} item dropped (${d.reason})`);
    }

    const claimed: OutboxItem[] = [];
    for (const item of sendable) if (await repo.claimDedupe(userId, item.dedupeKey)) claimed.push(item);
    if (claimed.length > 0) {
      const { plan } = validatePlan(mergeOutboxItems(claimed), { appOrigin: appOrigin() });
      if (!isEmptyPlan(plan)) {
        const result = await sendPlan(plan, {
          userId,
          channel,
          runId: null,
          trigger: triggerOf(claimed),
          keyPrefix: groupIndex === 0 ? jobId : `${jobId}:${channel.id}`,
          elapsedMs: 0,
          proactiveClass: strongestClass(claimed),
          outsideWindow: !base.windowOpen,
        });
        if (result.status !== "sent") {
          console.warn(`[deliver] outbox ${jobId.slice(0, 8)}: ${claimed.length} item(s) → ${result.status}`);
        }
      }
    }
    groupIndex += 1;
  }

  if (requeue.length > 0) {
    const runAt = new Date(Math.min(...requeue.map((r) => r.until.getTime())));
    await enqueueJob({
      kind: "proactive_flush",
      userId,
      dedupeKey: outboxDedupeKey(userId),
      mode: "append",
      runAt,
      payload: { items: requeue.map((r) => r.item) },
    });
  }
  return { type: "done" };
}
