import "server-only";
// OWNER: 2.1

/**
 * Channel / message DB access for delivery and ingest (V2-03 §7 `repo.ts`; master plan §1.1).
 * Service-role client only. Never logs bodies or handles (callers mask handles).
 *
 * Idempotency: outbound rows are inserted BEFORE the provider send with a unique
 * `idempotency_key` (partial unique index); a conflict means "already attempted" and the caller
 * skips the send (at-most-once, V2-03 §2.5). Proactive producer keys are claimed in
 * `proactive_dedupe` (primary key `(user_id, dedupe_key)`).
 */
import { db, type Tables } from "@/server/db";
import type { Json } from "@/server/db/types";
import type { ReactionType, SendResult, Service } from "@/server/channels/types";

/** A `channels` row. */
export type ChannelRow = Tables<"channels">;

/** The user fields delivery guards need. */
export interface UserDeliveryState {
  id: string;
  name: string | null;
  timezone: string;
  quietStart: string;
  quietEnd: string;
  deletedAt: Date | null;
}

/** One outbound bubble row, written before the send. */
export interface OutboundRowInput {
  userId: string;
  channelId: string;
  provider: string | null;
  body: string | null;
  media: { url: string; kind: string }[] | null;
  /** agent_runs.id (FK) or null for producer deliveries. */
  runId: string | null;
  deliveryId: string;
  /** reply | interim | welcome | contact_card | command | fallback | <proactive reason>. */
  trigger: string;
  idempotencyKey: string;
  service: Service | null;
  replyToMessageId: string | null;
  proactiveClass: "routine" | "urgent" | "requested" | null;
  outsideWindow: boolean;
}

const UNIQUE_VIOLATION = "23505";
const DAY_MS = 24 * 60 * 60_000;

function fail(op: string, message: string): never {
  throw new Error(`[channels/repo] ${op}: ${message}`);
}

/**
 * Loads one channel.
 * @param channelId channels.id
 * @returns the row, or null when it doesn't exist
 */
export async function getChannel(channelId: string): Promise<ChannelRow | null> {
  const { data, error } = await db().from("channels").select("*").eq("id", channelId).maybeSingle();
  if (error) fail("getChannel", error.message);
  return data;
}

/**
 * The user's primary channel (primary first, then most recently active, then oldest).
 * @param userId users.id
 * @returns the row, or null when the user has no channel
 */
export async function getPrimaryChannel(userId: string): Promise<ChannelRow | null> {
  const { data, error } = await db()
    .from("channels")
    .select("*")
    .eq("user_id", userId)
    .order("is_primary", { ascending: false })
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) fail("getPrimaryChannel", error.message);
  return data?.[0] ?? null;
}

/**
 * Finds a channel by its `(kind, handle)` identity.
 * @param kind channels.kind ("imessage" for every Sendblue/dev handle)
 * @param handle normalized handle (E.164 or lowercased email)
 * @returns the row, or null
 */
export async function findChannelByHandle(kind: string, handle: string): Promise<ChannelRow | null> {
  const { data, error } = await db()
    .from("channels")
    .select("*")
    .eq("kind", kind)
    .eq("handle", handle)
    .maybeSingle();
  if (error) fail("findChannelByHandle", error.message);
  return data;
}

/**
 * Loads the user fields delivery needs (time zone, quiet hours, deletion).
 * @param userId users.id
 * @returns the state, or null when the user doesn't exist
 */
export async function getUserDeliveryState(userId: string): Promise<UserDeliveryState | null> {
  const { data, error } = await db()
    .from("users")
    .select("id, name, timezone, quiet_start, quiet_end, deleted_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) fail("getUserDeliveryState", error.message);
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    timezone: data.timezone,
    quietStart: data.quiet_start,
    quietEnd: data.quiet_end,
    deletedAt: data.deleted_at ? new Date(data.deleted_at) : null,
  };
}

/**
 * Inserts an outbound bubble row before sending (status `pending`).
 * @param row row fields (idempotency key required)
 * @returns the new messages.id, or null when the idempotency key already exists (skip the send)
 * @throws on any other DB error
 */
export async function insertOutbound(row: OutboundRowInput): Promise<string | null> {
  const { data, error } = await db()
    .from("messages")
    .insert({
      user_id: row.userId,
      channel_id: row.channelId,
      direction: "out",
      provider: row.provider,
      body: row.body,
      media: row.media as Json,
      run_id: row.runId,
      delivery_id: row.deliveryId,
      trigger: row.trigger,
      idempotency_key: row.idempotencyKey,
      service: row.service,
      reply_to_message_id: row.replyToMessageId,
      proactive_class: row.proactiveClass,
      outside_window: row.outsideWindow,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return null;
    fail("insertOutbound", error.message);
  }
  return data.id;
}

/**
 * Records the provider's answer on an outbound row.
 * @param messageId messages.id from `insertOutbound`
 * @param result provider send result
 */
export async function markOutbound(messageId: string, result: SendResult): Promise<void> {
  const { error } = await db()
    .from("messages")
    .update({
      status: result.errorKey && result.status !== "sent" ? `${result.status}:${result.errorKey}`.slice(0, 64) : result.status,
      provider_message_id: result.providerMessageId,
      ...(result.service ? { service: result.service } : {}),
    })
    .eq("id", messageId);
  if (error) fail("markOutbound", error.message);
}

/**
 * Provider message id of one of our messages (reactions, inline replies, dev reply mapping).
 * @param messageId messages.id
 * @returns provider_message_id, or null when unknown / not yet sent
 */
export async function getProviderMessageId(messageId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("messages")
    .select("provider_message_id")
    .eq("id", messageId)
    .maybeSingle();
  if (error) fail("getProviderMessageId", error.message);
  return data?.provider_message_id ?? null;
}

/**
 * Our messages.id for a provider message id.
 * @param provider messages.provider ("sendblue" | "dev")
 * @param providerMessageId provider handle of the message
 * @returns the id and owner, or null
 */
export async function findMessageByProviderId(
  provider: string,
  providerMessageId: string,
): Promise<{ id: string; userId: string; direction: string } | null> {
  const { data, error } = await db()
    .from("messages")
    .select("id, user_id, direction")
    .eq("provider", provider)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (error) fail("findMessageByProviderId", error.message);
  return data ? { id: data.id, userId: data.user_id, direction: data.direction } : null;
}

/**
 * Bodies of messages, for SMS quote prefixes (never logged).
 * @param ids messages.id values
 * @returns id → body (messages without a body are omitted)
 */
export async function messageSnippets(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data, error } = await db().from("messages").select("id, body").in("id", ids);
  if (error) fail("messageSnippets", error.message);
  const out: Record<string, string> = {};
  for (const r of data ?? []) if (r.body) out[r.id] = r.body;
  return out;
}

/**
 * Applies a provider status update (Sendblue status webhook) to an outbound row.
 * @param provider messages.provider
 * @param providerMessageId provider handle of the message
 * @param status provider status text
 * @returns the channel id of the updated row, or null when no row matched
 */
export async function updateOutboundStatus(
  provider: string,
  providerMessageId: string,
  status: string,
): Promise<string | null> {
  const { data, error } = await db()
    .from("messages")
    .update({ status: status.slice(0, 64) })
    .eq("provider", provider)
    .eq("provider_message_id", providerMessageId)
    .eq("direction", "out")
    .select("channel_id");
  if (error) fail("updateOutboundStatus", error.message);
  return data?.[0]?.channel_id ?? null;
}

/**
 * Sets or clears a channel's opt-out and writes a `consents` row (granted = at === null).
 * Setting keeps an existing earlier opt-out timestamp.
 * @param channelId channels.id
 * @param at opt-out instant, or null to opt back in
 * @param source consent source ("keyword" | "provider" | "web")
 */
export async function setOptOut(channelId: string, at: Date | null, source: string): Promise<void> {
  const client = db();
  let q = client.from("channels").update({ opted_out_at: at ? at.toISOString() : null }).eq("id", channelId);
  if (at) q = q.is("opted_out_at", null);
  const { error } = await q;
  if (error) fail("setOptOut", error.message);
  const ch = await getChannel(channelId);
  if (!ch) return;
  const { error: cErr } = await client.from("consents").insert({
    user_id: ch.user_id,
    channel_id: channelId,
    scope: "messaging",
    granted: at === null,
    source,
  });
  if (cErr) fail("setOptOut(consent)", cErr.message);
}

/**
 * Sets or clears a channel's proactive pause.
 * @param channelId channels.id
 * @param until pause end, or null to resume
 */
export async function setPause(channelId: string, until: Date | null): Promise<void> {
  const { error } = await db()
    .from("channels")
    .update({ paused_until: until ? until.toISOString() : null })
    .eq("id", channelId);
  if (error) fail("setPause", error.message);
}

/**
 * Proactive send history for the guards: routine deliveries since the cap-day start (distinct
 * `delivery_id`) and the last proactive send of any class (bundling).
 * @param userId users.id
 * @param sinceLocalMidnight start of the user's local day (`capDayStart`)
 * @returns routine count and last proactive send
 */
export async function proactiveStats(
  userId: string,
  sinceLocalMidnight: Date,
): Promise<{ routineCount: number; lastProactiveAt: Date | null }> {
  const client = db();
  const [routine, last] = await Promise.all([
    client
      .from("messages")
      .select("delivery_id")
      .eq("user_id", userId)
      .eq("direction", "out")
      .eq("proactive_class", "routine")
      .gte("created_at", sinceLocalMidnight.toISOString()),
    client
      .from("messages")
      .select("created_at")
      .eq("user_id", userId)
      .eq("direction", "out")
      .not("proactive_class", "is", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (routine.error) fail("proactiveStats", routine.error.message);
  if (last.error) fail("proactiveStats", last.error.message);
  const deliveries = new Set((routine.data ?? []).map((r) => r.delivery_id ?? "?"));
  const lastAt = last.data?.[0]?.created_at;
  return { routineCount: deliveries.size, lastProactiveAt: lastAt ? new Date(lastAt) : null };
}

/**
 * Distinct users that received an outside-window proactive send on this line in the last 24h
 * (Sendblue follow-up quota, V2-03 §2.6).
 * @param line channels.provider_line (null → 0)
 * @param now current instant
 * @returns distinct recipient count
 */
export async function followupRecipients24h(line: string | null, now: Date): Promise<number> {
  if (!line) return 0;
  const { data, error } = await db()
    .from("messages")
    .select("user_id, channels!inner(provider_line)")
    .eq("direction", "out")
    .eq("outside_window", true)
    .eq("channels.provider_line", line)
    .gte("created_at", new Date(now.getTime() - DAY_MS).toISOString());
  if (error) fail("followupRecipients24h", error.message);
  return new Set((data ?? []).map((r) => r.user_id)).size;
}

/**
 * Stores (or marks removed) a reaction on a message. Idempotent on `(message_id, actor, type)`.
 * @param input target message, actor, reaction type, removal flag
 */
export async function recordReaction(input: {
  messageId: string;
  actor: "user" | "aria";
  type: ReactionType;
  removed?: boolean;
}): Promise<void> {
  const client = db();
  if (input.removed) {
    const { error } = await client
      .from("reactions")
      .update({ removed_at: new Date().toISOString() })
      .eq("message_id", input.messageId)
      .eq("actor", input.actor)
      .eq("type", input.type);
    if (error) fail("recordReaction", error.message);
    return;
  }
  const { error } = await client
    .from("reactions")
    .upsert(
      { message_id: input.messageId, actor: input.actor, type: input.type, removed_at: null },
      { onConflict: "message_id,actor,type" },
    );
  if (error) fail("recordReaction", error.message);
}

/**
 * Claims a proactive producer key (insert … on conflict do nothing). At-most-once: claim first,
 * then send.
 * @param userId users.id
 * @param key producer dedupe key
 * @returns true when this call claimed it, false when it was already delivered
 */
export async function claimDedupe(userId: string, key: string): Promise<boolean> {
  const { data, error } = await db()
    .from("proactive_dedupe")
    .upsert({ user_id: userId, dedupe_key: key }, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
    .select("dedupe_key");
  if (error) fail("claimDedupe", error.message);
  return (data?.length ?? 0) > 0;
}

/**
 * Whether a proactive producer key was already delivered.
 * @param userId users.id
 * @param key producer dedupe key
 * @returns true when claimed before
 */
export async function dedupeExists(userId: string, key: string): Promise<boolean> {
  return (await deliveredKeys(userId, [key])).has(key);
}

/**
 * The subset of keys already delivered (batch form of `dedupeExists`).
 * @param userId users.id
 * @param keys producer dedupe keys
 * @returns delivered keys
 */
export async function deliveredKeys(userId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { data, error } = await db()
    .from("proactive_dedupe")
    .select("dedupe_key")
    .eq("user_id", userId)
    .in("dedupe_key", keys);
  if (error) fail("deliveredKeys", error.message);
  return new Set((data ?? []).map((r) => r.dedupe_key));
}

/**
 * Closes inbound messages without an agent run: inserts a finished `agent_runs` row
 * (`trigger='command'`) and marks the messages consumed by it (only still-unconsumed rows).
 * Used for keyword commands and for messages received while opted out.
 * @param input owner, channel, inbound message ids, optional note stored in `error`
 * @returns the agent_runs.id
 */
export async function closeWithoutAgent(input: {
  userId: string;
  channelId: string;
  messageIds: string[];
  note?: string | null;
}): Promise<string> {
  const client = db();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("agent_runs")
    .insert({
      user_id: input.userId,
      channel_id: input.channelId,
      status: "done",
      trigger: "command",
      input_message_ids: input.messageIds,
      finished_at: now,
      error: input.note ?? null,
    })
    .select("id")
    .single();
  if (error) fail("closeWithoutAgent", error.message);
  if (input.messageIds.length > 0) {
    const { error: uErr } = await client
      .from("messages")
      .update({ consumed_by_run: data.id })
      .in("id", input.messageIds)
      .eq("user_id", input.userId)
      .eq("direction", "in")
      .is("consumed_by_run", null);
    if (uErr) fail("closeWithoutAgent(consume)", uErr.message);
  }
  return data.id;
}

/**
 * Whether the user is deleted (or missing). The pipeline ignores such users (master plan §1.16).
 * @param userId users.id
 * @returns true when `deleted_at` is set or the row is gone
 */
export async function isUserDeleted(userId: string): Promise<boolean> {
  const { data, error } = await db().from("users").select("deleted_at").eq("id", userId).maybeSingle();
  if (error) fail("isUserDeleted", error.message);
  return !data || data.deleted_at !== null;
}

/**
 * Rewrite the bodies of this user's INBOUND messages (e.g. scrub a Canvas feed URL after a chat
 * connect). Scoped by `user_id` and `direction = 'in'`.
 * @param userId owner
 * @param messageIds messages.id values to rewrite
 * @param redact pure body → body transform
 * @returns number of rows changed
 */
export async function redactInboundBodies(
  userId: string,
  messageIds: string[],
  redact: (body: string) => string,
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const client = db();
  const { data, error } = await client
    .from("messages")
    .select("id, body")
    .eq("user_id", userId)
    .eq("direction", "in")
    .in("id", messageIds);
  if (error) fail("redactInboundBodies", error.message);
  let changed = 0;
  for (const row of data ?? []) {
    if (row.body === null) continue;
    const next = redact(row.body);
    if (next === row.body) continue;
    const { error: uErr } = await client
      .from("messages")
      .update({ body: next })
      .eq("id", row.id)
      .eq("user_id", userId)
      .eq("direction", "in");
    if (uErr) fail("redactInboundBodies(update)", uErr.message);
    changed += 1;
  }
  return changed;
}
