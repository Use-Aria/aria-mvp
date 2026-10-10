/**
 * In-memory fakes for pipeline logic tests (V2-03 §7 Tests): a `LeaseStore`, a fake Upstash
 * client for the Redis lease store, a recording `ChannelProvider`, and a message store with the
 * DB's consume / idempotency semantics. No I/O; every clock is injectable (fake timers work).
 */
import { EXTEND_SCRIPT, RELEASE_SCRIPT, type LeaseRedis, type LeaseStore } from "@/server/pipeline/lease";
import type {
  ChannelCapabilities,
  ChannelProvider,
  InboundMedia,
  OutboundTarget,
  ReactionType,
  SendInput,
  SendResult,
} from "@/server/channels/types";

/** Epoch-ms clock. */
export type Clock = () => number;

// ── leases ──────────────────────────────────────────────────────────────────

/** In-memory lease store with the same semantics as the Redis/DB stores. */
export function createMemoryLeaseStore(clock: Clock = Date.now): LeaseStore & {
  /** Current holder (null when free or expired). */
  holder(userId: string): string | null;
} {
  const leases = new Map<string, { owner: string; until: number }>();
  const live = (userId: string) => {
    const l = leases.get(userId);
    return l && l.until > clock() ? l : null;
  };
  return {
    async acquire(userId, owner, ttlMs) {
      // SET NX semantics: a held lease (even by `owner`) can't be acquired; owners use extend.
      if (live(userId)) return false;
      leases.set(userId, { owner, until: clock() + ttlMs });
      return true;
    },
    async extend(userId, owner, ttlMs) {
      const l = live(userId);
      if (!l || l.owner !== owner) return false;
      l.until = clock() + ttlMs;
      return true;
    },
    async release(userId, owner) {
      const l = leases.get(userId);
      if (l && l.owner === owner) leases.delete(userId);
    },
    async isHeld(userId) {
      return live(userId) !== null;
    },
    holder(userId) {
      return live(userId)?.owner ?? null;
    },
  };
}

/**
 * Fake Upstash client for `createRedisLeaseStore`: `SET NX PX`, `EXISTS`, and the two lease Lua
 * scripts (recognized by identity), with key expiry on an injected clock.
 */
export function createFakeLeaseRedis(clock: Clock = Date.now): LeaseRedis & { calls: string[] } {
  const store = new Map<string, { value: string; until: number }>();
  const calls: string[] = [];
  const get = (key: string) => {
    const e = store.get(key);
    if (e && e.until <= clock()) {
      store.delete(key);
      return null;
    }
    return e ?? null;
  };
  return {
    calls,
    async set(key, value, opts) {
      calls.push("set");
      if (opts.nx && get(key)) return null;
      store.set(key, { value, until: clock() + opts.px });
      return "OK";
    },
    async eval(script, keys, args) {
      const e = get(keys[0]);
      if (script === EXTEND_SCRIPT) {
        calls.push("extend");
        if (!e || e.value !== args[0]) return 0;
        e.until = clock() + Number(args[1]);
        return 1;
      }
      if (script === RELEASE_SCRIPT) {
        calls.push("release");
        if (!e || e.value !== args[0]) return 0;
        store.delete(keys[0]);
        return 1;
      }
      throw new Error("fake redis: unknown script");
    },
    async exists(key) {
      calls.push("exists");
      return get(key) ? 1 : 0;
    },
  };
}

// ── provider ────────────────────────────────────────────────────────────────

/** Default capabilities of the fake provider (an iMessage line with everything on). */
export const FAKE_CAPS: ChannelCapabilities = {
  reactions: true,
  typing: true,
  inlineReplies: true,
  media: true,
  maxBubbleChars: 1200,
};

/** One thing the fake provider was asked to do. */
export type FakeProviderEvent =
  | { op: "send"; to: OutboundTarget; input: SendInput; result: SendResult }
  | { op: "react"; to: OutboundTarget; providerMessageId: string; reaction: ReactionType }
  | { op: "typing"; to: OutboundTarget; state: "start" | "stop" };

/**
 * Recording provider with scriptable send results.
 * @param opts capabilities override and a send-result function (default: sent, `p<n>` ids)
 */
export function createFakeProvider(
  opts: { caps?: Partial<ChannelCapabilities>; send?: (input: SendInput, n: number) => SendResult } = {},
): ChannelProvider & { events: FakeProviderEvent[]; sends(): SendInput[] } {
  const events: FakeProviderEvent[] = [];
  let n = 0;
  return {
    name: "dev",
    events,
    sends: () => events.flatMap((e) => (e.op === "send" ? [e.input] : [])),
    capabilities: () => ({ ...FAKE_CAPS, ...opts.caps }),
    async send(to, input) {
      n += 1;
      const result = opts.send ? opts.send(input, n) : { providerMessageId: `p${n}`, status: "sent" as const };
      events.push({ op: "send", to, input, result });
      return result;
    },
    async react(to, providerMessageId, reaction) {
      events.push({ op: "react", to, providerMessageId, reaction });
      return true;
    },
    async typing(to, state) {
      events.push({ op: "typing", to, state });
    },
    parseWebhook: () => ({ ok: false, status: 401 }),
  };
}

// ── messages ────────────────────────────────────────────────────────────────

/** A message row in the memory store (subset of `messages`). */
export interface MemoryMessage {
  id: string;
  userId: string;
  direction: "in" | "out";
  body: string | null;
  media: InboundMedia[];
  replyToMessageId: string | null;
  createdAt: Date;
  consumedByRun: string | null;
  runId: string | null;
  idempotencyKey: string | null;
  providerMessageId: string | null;
  status: string | null;
}

/**
 * Message store with the DB's semantics: atomic consume of unconsumed inbound (oldest first),
 * un-consume by run, outbound idempotency keys (insert returns null on conflict).
 * @param clock creation-time clock
 */
export function createMemoryMessageStore(clock: Clock = Date.now) {
  const rows: MemoryMessage[] = [];
  let seq = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  return {
    rows,
    /** Adds an inbound message; returns its id. */
    addInbound(userId: string, body: string | null, extra: Partial<MemoryMessage> = {}): string {
      const id = nextId();
      rows.push({
        id,
        userId,
        direction: "in",
        body,
        media: [],
        replyToMessageId: null,
        createdAt: new Date(clock()),
        consumedByRun: null,
        runId: null,
        idempotencyKey: null,
        providerMessageId: `in-${id}`,
        status: "received",
        ...extra,
      });
      return id;
    },
    /** Claims every unconsumed inbound row of the user for `runId`, oldest first. */
    consume(userId: string, runId: string): MemoryMessage[] {
      const got = rows
        .filter((r) => r.userId === userId && r.direction === "in" && r.consumedByRun === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const r of got) r.consumedByRun = runId;
      return got;
    },
    /** Releases a run's inbound rows (failed run with nothing sent). */
    unconsume(runId: string): number {
      let n = 0;
      for (const r of rows) {
        if (r.direction === "in" && r.consumedByRun === runId) {
          r.consumedByRun = null;
          n += 1;
        }
      }
      return n;
    },
    /** Inserts an outbound row; null when the idempotency key already exists. */
    insertOutbound(userId: string, runId: string | null, key: string, body: string | null): string | null {
      if (rows.some((r) => r.idempotencyKey === key)) return null;
      const id = nextId();
      rows.push({
        id,
        userId,
        direction: "out",
        body,
        media: [],
        replyToMessageId: null,
        createdAt: new Date(clock()),
        consumedByRun: null,
        runId,
        idempotencyKey: key,
        providerMessageId: null,
        status: "pending",
      });
      return id;
    },
    /** Outbound rows written by a run. */
    outboundForRun(runId: string): MemoryMessage[] {
      return rows.filter((r) => r.direction === "out" && r.runId === runId);
    },
  };
}
