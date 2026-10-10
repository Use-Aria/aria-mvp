/**
 * Pipeline / delivery smoke (V2-03 §10.2 items 1, 2, 6, 7 + task 2.1 T4/T5 checks), against the
 * LOCAL Supabase stack by default (`SMOKE_TARGET=env` for the env project, as in jobs.smoke).
 *
 *  1. `ingest_inbound_message` concurrency via `ingestEvents`: 3 parallel bubbles from a fresh
 *     handle → 1 user, 1 channel, 3 messages, one debounced turn job; a repeat is a duplicate.
 *  2. Signup match: name + tz copied, `matched_user_id` set, consent row.
 *  6. `acquire_user_lease` through the DB lease store: exclusive, owner extend, expiry handover.
 *  7. `purge_messages_before`: back-dated rows purged, reactions cascade.
 *  +  STOP / START / pause / HELP commands, opted-out storage, typing debounce push,
 *     `deliverReply` idempotency, `deliver` (non-proactive, urgent inline, routine outbox merge,
 *     flush, pause deferral, deferMode "return", synchronous expiry, dedupe, opt-out),
 *     `redactInboundBodies`, and `/api/channels/dev` (secret, replyToMessageId mapping, timing).
 *
 * Handles are fictional `+1555010xxxx`. Every row hangs off throwaway users (cascade) or signups,
 * deleted in afterAll. Turn jobs are never kicked (the `conversation_turn` handler is task 3.1).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

// `after()` outside a request scope throws; capture callbacks instead of running them.
const afterTasks: Array<() => unknown> = [];
jest.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    afterTasks.push(cb);
  },
}));

// ── Target selection (before any server module calls db()) ─────────────────
function localTarget(): { url: string; serviceKey: string } {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}
function envTarget(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SMOKE_TARGET=env needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  return { url, serviceKey };
}
const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
// Deterministic local wiring: DB lease, dev provider (with a webhook secret), in-memory rate limit.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.CHANNEL_PROVIDER = "dev";
const DEV_SECRET = `smoke-dev-${randomUUID()}`;
process.env.DEV_CHANNEL_SECRET = DEV_SECRET;

import { getProvider } from "@/server/channels";
import { deliver, deliverReply, flushOutbox, outboxDedupeKey } from "@/server/channels/deliver";
import type { DevProvider } from "@/server/channels/providers/dev";
import { redactInboundBodies } from "@/server/channels/repo";
import type { ChannelProvider, InboundEvent, OutboxItem } from "@/server/channels/types";
import { cancelJobs } from "@/server/jobs/enqueue";
import { createDbLeaseStore } from "@/server/pipeline/lease";
import { afterIngest, ingestEvents, type IngestOutcome } from "@/server/pipeline/ingest";
import { turnDedupeKey } from "@/server/pipeline/kick";
import { POST as devRoute } from "@/app/api/channels/dev/route";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN = randomUUID().slice(0, 8);
const userIds = new Set<string>();
const signupIds: string[] = [];
let seq = 0;

function isDev(p: ChannelProvider): p is DevProvider {
  return "transcript" in p;
}
const dev = getProvider("dev");
if (!isDev(dev)) throw new Error("expected the dev provider");

function freshHandle(): string {
  return `+1555010${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

type MessageEvent = Extract<InboundEvent, { type: "message" }>;

function msg(handle: string, text: string, extra: Partial<MessageEvent> = {}): MessageEvent {
  seq += 1;
  return {
    type: "message",
    providerMessageId: `smoke-${RUN}-${seq}`,
    handle,
    handleKind: "phone",
    line: "dev",
    service: "imessage",
    text,
    media: [],
    sentAt: new Date(),
    providerOptedOut: false,
    ...extra,
  };
}

async function ingestOne(ev: InboundEvent): Promise<IngestOutcome> {
  const [o] = await ingestEvents(dev, [ev]);
  if (o.kind === "turn" || o.kind === "command" || o.kind === "stored_only") userIds.add(o.userId);
  return o;
}

function must<T>(res: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${label}: no data`);
  return res.data;
}

async function channelOf(userId: string) {
  return must(await sb.from("channels").select("*").eq("user_id", userId).single(), "channel");
}

async function outbound(userId: string) {
  return must(
    await sb.from("messages").select("*").eq("user_id", userId).eq("direction", "out").order("created_at"),
    "outbound",
  );
}

async function pendingOutboxJob(userId: string) {
  const rows = must(
    await sb.from("jobs").select("*").eq("dedupe_key", outboxDedupeKey(userId)).eq("status", "pending"),
    "outbox job",
  );
  return rows[0] ?? null;
}

function payloadItems(payload: unknown): OutboxItem[] {
  const items = (payload as { items?: OutboxItem[] }).items;
  return items ?? [];
}

async function ensureFreshHandle(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const h = freshHandle();
    const rows = must(await sb.from("channels").select("id").eq("handle", h), "handle probe");
    if (rows.length === 0) return h;
  }
  throw new Error("no free fictional handle");
}

afterAll(async () => {
  for (const id of signupIds) await sb.from("signups").delete().eq("id", id);
  for (const id of userIds) await sb.from("users").delete().eq("id", id);
  const left = must(await sb.from("users").select("id").in("id", [...userIds]), "cleanup check");
  expect(left).toHaveLength(0);
});

describe("ingest (V2-03 §10.2 items 1–2)", () => {
  let handle1 = "";
  let user1 = "";

  it("1: three parallel bubbles from a new handle → one user, one channel, three messages, one turn job", async () => {
    handle1 = await ensureFreshHandle();
    const evs = [msg(handle1, "whats due"), msg(handle1, "also gym?"), msg(handle1, "nvm")];
    const outs = await Promise.all(evs.map((e) => ingestOne(e)));
    const turns = outs.filter((o): o is Extract<IngestOutcome, { kind: "turn" }> => o.kind === "turn");
    expect(turns).toHaveLength(3);
    user1 = turns[0].userId;
    expect(new Set(turns.map((t) => t.userId)).size).toBe(1);
    expect(new Set(turns.map((t) => t.jobId)).size).toBe(1);

    const channels = must(await sb.from("channels").select("*").eq("handle", handle1), "channels");
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ kind: "imessage", provider: "dev", user_id: user1, last_service: "imessage" });
    const inbound = must(await sb.from("messages").select("id").eq("user_id", user1).eq("direction", "in"), "msgs");
    expect(inbound).toHaveLength(3);

    const job = must(await sb.from("jobs").select("*").eq("id", turns[0].jobId).single(), "turn job");
    expect(job).toMatchObject({ kind: "conversation_turn", status: "pending", dedupe_key: turnDedupeKey(user1) });
    const runAt = Date.parse(job.run_at);
    expect(runAt).toBeLessThanOrEqual(Date.parse(job.created_at) + 8_000 + 5);
    expect(runAt).toBeGreaterThan(Date.parse(job.created_at));

    expect(await ingestOne({ ...evs[0], text: "whats due" })).toEqual({ kind: "duplicate" });
    const again = must(await sb.from("messages").select("id").eq("user_id", user1).eq("direction", "in"), "msgs");
    expect(again).toHaveLength(3);
  });

  it("typing from the user pushes the pending turn's run_at (still capped at 8s)", async () => {
    const before = must(await sb.from("jobs").select("*").eq("dedupe_key", turnDedupeKey(user1)).eq("status", "pending").single(), "job");
    const [o] = await ingestEvents(dev, [{ type: "typing", handle: handle1, isTyping: true }]);
    expect(o.kind).toBe("turn");
    if (o.kind !== "turn") return;
    expect(o.jobId).toBe(before.id);
    expect(o.showTyping).toBe(false);
    expect(o.runAt.getTime()).toBeGreaterThanOrEqual(Date.parse(before.run_at));
    expect(o.runAt.getTime()).toBeLessThanOrEqual(Date.parse(before.created_at) + 8_000 + 5);
    const [stopped] = await ingestEvents(dev, [{ type: "typing", handle: handle1, isTyping: false }]);
    expect(stopped.kind).toBe("ignored");
  });

  it("STOP → opted out + consent + confirmation; then stored silently; START resumes; pause sets paused_until", async () => {
    await cancelJobs({ userId: user1 });
    const stop = await ingestOne(msg(handle1, "STOP!!"));
    expect(stop.kind).toBe("command");
    if (stop.kind !== "command") return;
    expect(stop.command.kind).toBe("opt_out");
    expect(stop.confirm).toBe(true);
    let ch = await channelOf(user1);
    expect(ch.opted_out_at).not.toBeNull();
    const consents = must(await sb.from("consents").select("*").eq("user_id", user1), "consents");
    expect(consents.some((c) => c.granted === false && c.source === "keyword")).toBe(true);
    const stopRow = must(await sb.from("messages").select("consumed_by_run").eq("id", stop.messageId).single(), "stop row");
    expect(stopRow.consumed_by_run).toBe(stop.runId);
    const run = must(await sb.from("agent_runs").select("*").eq("id", stop.runId).single(), "run");
    expect(run).toMatchObject({ trigger: "command", status: "done" });

    const sendsBefore = dev.transcript().filter((e) => e.op === "send").length;
    await afterIngest([stop], dev);
    const confirm = (await outbound(user1)).filter((m) => m.trigger === "command");
    expect(confirm).toHaveLength(1);
    expect(confirm[0]).toMatchObject({ status: "sent", run_id: stop.runId, idempotency_key: `cmd:${stop.messageId}:0` });
    expect(dev.transcript().filter((e) => e.op === "send").length).toBe(sendsBefore + 1);

    const ignored = await ingestOne(msg(handle1, "hello?"));
    expect(ignored).toMatchObject({ kind: "stored_only", reason: "opted_out" });
    const helloRow = must(await sb.from("messages").select("consumed_by_run").eq("body", "hello?").eq("user_id", user1).single(), "hello");
    expect(helloRow.consumed_by_run).not.toBeNull();
    expect((await ingestOne(msg(handle1, "help"))).kind).toBe("stored_only");

    const start = await ingestOne(msg(handle1, "start"));
    expect(start).toMatchObject({ kind: "command", confirm: true });
    ch = await channelOf(user1);
    expect(ch.opted_out_at).toBeNull();

    const pause = await ingestOne(msg(handle1, "pause for 2 days"));
    expect(pause.kind).toBe("command");
    ch = await channelOf(user1);
    expect(ch.paused_until).not.toBeNull();
    const pausedFor = Date.parse(ch.paused_until ?? "") - Date.now();
    expect(pausedFor).toBeGreaterThan(47 * 3600_000);
    expect(pausedFor).toBeLessThan(49 * 3600_000);
    if (start.kind === "command" && pause.kind === "command") await afterIngest([start, pause], dev);
    expect((await outbound(user1)).filter((m) => m.trigger === "command")).toHaveLength(3);

    const help = await ingestOne(msg(handle1, "HELP"));
    expect(help).toMatchObject({ kind: "command" });
  });

  it("2: signup match copies name + timezone, sets matched_user_id, writes the consent", async () => {
    const handle = await ensureFreshHandle();
    const signup = must(
      await sb
        .from("signups")
        .insert({ name: "Smoke Sig", phone_e164: handle, timezone: "America/Los_Angeles", consent_version: `smoke-${RUN}` })
        .select("id")
        .single(),
      "signup",
    );
    signupIds.push(signup.id);
    const o = await ingestOne(msg(handle, "hey aria"));
    expect(o.kind).toBe("turn");
    if (o.kind !== "turn") return;
    const user = must(await sb.from("users").select("*").eq("id", o.userId).single(), "user");
    expect(user).toMatchObject({ name: "Smoke Sig", timezone: "America/Los_Angeles", timezone_source: "signup" });
    const s = must(await sb.from("signups").select("matched_user_id").eq("id", signup.id).single(), "signup row");
    expect(s.matched_user_id).toBe(o.userId);
    const consents = must(await sb.from("consents").select("*").eq("user_id", o.userId), "consents");
    expect(consents).toEqual([expect.objectContaining({ source: "signup", granted: true, copy_version: `smoke-${RUN}` })]);
  });
});

describe("DB lease (V2-03 §10.2 item 6)", () => {
  it("exclusive; owner extends; release is owner-only; a short TTL expires and hands over", async () => {
    const o = await ingestOne(msg(await ensureFreshHandle(), "lease me"));
    if (o.kind !== "turn") throw new Error("expected a turn");
    const u = o.userId;
    const store = createDbLeaseStore();
    const a = randomUUID();
    const b = randomUUID();
    expect(await store.acquire(u, a, 60_000)).toBe(true);
    expect(await store.acquire(u, b, 60_000)).toBe(false);
    expect(await store.extend(u, a, 60_000)).toBe(true);
    expect(await store.extend(u, b, 60_000)).toBe(false);
    expect(await store.isHeld(u)).toBe(true);
    await store.release(u, b);
    expect(await store.isHeld(u)).toBe(true);
    await store.release(u, a);
    expect(await store.isHeld(u)).toBe(false);

    expect(await store.acquire(u, a, 400)).toBe(true);
    expect(await store.acquire(u, b, 60_000)).toBe(false);
    await new Promise((r) => setTimeout(r, 700));
    expect(await store.acquire(u, b, 60_000)).toBe(true);
    expect(await store.extend(u, a, 60_000)).toBe(false);
    await store.release(u, b);
  });
});

describe("retention (V2-03 §10.2 item 7)", () => {
  it("purge_messages_before deletes back-dated rows and cascades their reactions", async () => {
    const o = await ingestOne(msg(await ensureFreshHandle(), "purge base"));
    if (o.kind !== "turn") throw new Error("expected a turn");
    const old = "2001-01-01T00:00:00Z";
    const rows = must(
      await sb
        .from("messages")
        .insert([0, 1, 2].map((i) => ({ user_id: o.userId, channel_id: o.channelId, direction: "in", body: `old ${i}`, created_at: old })))
        .select("id"),
      "old rows",
    );
    must(await sb.from("reactions").insert({ message_id: rows[0].id, actor: "user", type: "love" }).select("id"), "reaction");
    const { data: n, error } = await sb.rpc("purge_messages_before", { p_before: "2001-01-02T00:00:00Z" });
    expect(error).toBeNull();
    expect(n).toBe(3);
    expect(must(await sb.from("messages").select("id").in("id", rows.map((r) => r.id)), "left")).toHaveLength(0);
    expect(must(await sb.from("reactions").select("id").eq("message_id", rows[0].id), "reactions")).toHaveLength(0);
  });
});

describe("delivery (task 2.1 T4)", () => {
  let user = "";
  let channelId = "";
  let inboundId = "";

  beforeAll(async () => {
    const o = await ingestOne(msg(await ensureFreshHandle(), "deliver to me"));
    if (o.kind !== "turn") throw new Error("expected a turn");
    user = o.userId;
    channelId = o.channelId;
    inboundId = o.messageId ?? "";
    await cancelJobs({ userId: user });
    // No quiet window (start == end), so the checks don't depend on the wall clock.
    must(await sb.from("users").update({ quiet_start: "00:00", quiet_end: "00:00" }).eq("id", user).select("id"), "quiet");
  });

  it("deliverReply writes rows before sending with idempotency keys; a re-run sends nothing twice", async () => {
    const run = must(await sb.from("agent_runs").insert({ user_id: user, channel_id: channelId }).select("id").single(), "run");
    const plan = {
      reactions: [{ targetMessageId: inboundId, type: "like" }],
      bubbles: [{ text: "first" }, { text: "second", replyToMessageId: inboundId }],
    };
    const sendsBefore = dev.transcript().length;
    const r = await deliverReply({ userId: user, channelId, runId: run.id, plan, elapsedMs: 5_000, trigger: "reply", keyPrefix: run.id });
    expect(r.status).toBe("sent");
    if (r.status !== "sent") return;
    expect(r.messageIds).toHaveLength(2);
    const rows = (await outbound(user)).filter((m) => m.run_id === run.id);
    expect(rows.map((m) => m.idempotency_key).sort()).toEqual([`${run.id}:1`, `${run.id}:2`]);
    expect(rows.every((m) => m.status === "sent" && m.provider_message_id && m.delivery_id === r.deliveryId)).toBe(true);
    expect(rows.find((m) => m.body === "second")?.reply_to_message_id).toBe(inboundId);
    const reactions = must(await sb.from("reactions").select("*").eq("message_id", inboundId), "reactions");
    expect(reactions).toEqual([expect.objectContaining({ actor: "aria", type: "like" })]);
    const sendsAfterFirst = dev.transcript().filter((e) => e.op === "send").length;
    expect(sendsAfterFirst).toBeGreaterThan(0);

    const again = await deliverReply({ userId: user, channelId, runId: run.id, plan, elapsedMs: 5_000, trigger: "reply", keyPrefix: run.id });
    expect(again).toEqual({ status: "suppressed", reason: "duplicate" });
    expect(dev.transcript().filter((e) => e.op === "send").length).toBe(sendsAfterFirst);
    expect(dev.transcript().length).toBeGreaterThan(sendsBefore);
  });

  it("deliver(proactive:false) sends now; the same dedupeKey is a duplicate", async () => {
    const plan = { bubbles: [{ text: "canvas connected 🎉" }] };
    const r = await deliver(user, plan, { proactive: false, reason: "canvas_connected", dedupeKey: `cc:${RUN}` });
    expect(r.status).toBe("sent");
    const row = (await outbound(user)).find((m) => m.trigger === "canvas_connected");
    expect(row).toMatchObject({ proactive_class: null, idempotency_key: `d:${user}:cc:${RUN}:0`, status: "sent" });
    expect(await deliver(user, plan, { proactive: false, reason: "canvas_connected", dedupeKey: `cc:${RUN}` })).toEqual({
      status: "suppressed",
      reason: "duplicate",
    });
  });

  it("urgent allowed now is flushed inline (sent) and claimed in proactive_dedupe", async () => {
    const r = await deliver(user, { bubbles: [{ text: "heads up: due moved to tmrw 9am" }] }, {
      proactive: true,
      reason: "due_change",
      priority: "urgent",
      dedupeKey: `urgent:${RUN}`,
    });
    expect(r.status).toBe("sent");
    const d = must(await sb.from("proactive_dedupe").select("*").eq("user_id", user).eq("dedupe_key", `urgent:${RUN}`), "dedupe");
    expect(d).toHaveLength(1);
    expect((await outbound(user)).find((m) => m.trigger === "due_change")).toMatchObject({ proactive_class: "urgent" });
    const again = await deliver(user, { bubbles: [{ text: "dup" }] }, {
      proactive: true,
      reason: "due_change",
      priority: "urgent",
      dedupeKey: `urgent:${RUN}`,
    });
    expect(again).toEqual({ status: "suppressed", reason: "duplicate" });
  });

  it("routine items are queued into ONE outbox job, and the flush merges + sends + claims them", async () => {
    const a = await deliver(user, { bubbles: [{ text: "fyi A" }] }, { proactive: true, reason: "briefing", dedupeKey: `a:${RUN}` });
    const b = await deliver(user, { bubbles: [{ text: "fyi B" }] }, { proactive: true, reason: "deadline_nudge", dedupeKey: `b:${RUN}` });
    expect(a.status).toBe("queued");
    expect(b.status).toBe("queued");
    if (a.status !== "queued" || b.status !== "queued") return;
    expect(b.jobId).toBe(a.jobId);
    // The urgent send just happened → routine waits for the 10-min bundling window.
    expect(a.runAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    const job = await pendingOutboxJob(user);
    expect(job?.id).toBe(a.jobId);
    const items = payloadItems(job?.payload);
    expect(items.map((i) => i.dedupeKey)).toEqual([`a:${RUN}`, `b:${RUN}`]);

    // Flushing "now" re-applies the bundling guard → re-queued, nothing sent.
    await cancelJobs({ ids: [a.jobId] });
    expect(await flushOutbox(user, a.jobId, items, new Date())).toEqual({ type: "done" });
    const requeued = await pendingOutboxJob(user);
    expect(payloadItems(requeued?.payload).map((i) => i.dedupeKey)).toEqual([`a:${RUN}`, `b:${RUN}`]);
    if (requeued) await cancelJobs({ ids: [requeued.id] });

    // After the bundling window: one merged delivery, both keys claimed.
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await flushOutbox(user, a.jobId, items, later)).toEqual({ type: "done" });
    const sent = (await outbound(user)).filter((m) => m.idempotency_key?.startsWith(`${a.jobId}:`));
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((m) => m.delivery_id)).size).toBe(1);
    expect(sent.every((m) => m.proactive_class === "routine")).toBe(true);
    const claimed = must(await sb.from("proactive_dedupe").select("dedupe_key").eq("user_id", user), "claimed");
    expect(claimed.map((c) => c.dedupe_key)).toEqual(expect.arrayContaining([`a:${RUN}`, `b:${RUN}`]));
    // A retried flush sends nothing twice.
    await flushOutbox(user, a.jobId, items, later);
    expect((await outbound(user)).filter((m) => m.idempotency_key?.startsWith(`${a.jobId}:`))).toHaveLength(2);
    expect(await deliver(user, { bubbles: [{ text: "x" }] }, { proactive: true, reason: "briefing", dedupeKey: `a:${RUN}` })).toEqual({
      status: "suppressed",
      reason: "duplicate",
    });
  });

  it("pause defers (queued past the pause, never dropped); return mode persists nothing; expiry is synchronous", async () => {
    const until = new Date(Date.now() + 60 * 60_000);
    must(await sb.from("channels").update({ paused_until: until.toISOString() }).eq("id", channelId).select("id"), "pause");

    const req = await deliver(user, { bubbles: [{ text: "reminder: call mom" }] }, {
      proactive: true,
      reason: "reminder",
      priority: "requested",
      dedupeKey: `req:${RUN}`,
    });
    expect(req.status).toBe("queued");
    if (req.status !== "queued") return;
    expect(req.runAt.getTime()).toBeGreaterThanOrEqual(until.getTime() - 1_000);

    const ret = await deliver(user, { bubbles: [{ text: "briefing" }] }, {
      proactive: true,
      reason: "briefing",
      dedupeKey: `ret:${RUN}`,
      deferMode: "return",
    });
    expect(ret.status).toBe("deferred");
    if (ret.status === "deferred") expect(ret.until.getTime()).toBeGreaterThanOrEqual(until.getTime() - 1_000);
    const job = await pendingOutboxJob(user);
    expect(payloadItems(job?.payload).map((i) => i.dedupeKey)).toEqual([`req:${RUN}`]);

    const expired = await deliver(user, { bubbles: [{ text: "nudge" }] }, {
      proactive: true,
      reason: "deadline_nudge",
      priority: "urgent",
      dedupeKey: `exp:${RUN}`,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(expired).toEqual({ status: "suppressed", reason: "expired" });

    // A flush while still paused re-queues the item (deferred, not dropped).
    if (job) await cancelJobs({ ids: [job.id] });
    await flushOutbox(user, randomUUID(), payloadItems(job?.payload), new Date());
    const again = await pendingOutboxJob(user);
    expect(payloadItems(again?.payload).map((i) => i.dedupeKey)).toEqual([`req:${RUN}`]);
    expect(Date.parse(again?.run_at ?? "")).toBeGreaterThanOrEqual(until.getTime() - 1_000);
    if (again) await cancelJobs({ ids: [again.id] });
    must(await sb.from("channels").update({ paused_until: null }).eq("id", channelId).select("id"), "unpause");
  });

  it("opted out → suppressed for every class (and invalid / deleted cases)", async () => {
    must(await sb.from("channels").update({ opted_out_at: new Date().toISOString() }).eq("id", channelId).select("id"), "opt out");
    const plan = { bubbles: [{ text: "x" }] };
    expect(await deliver(user, plan, { proactive: true, reason: "briefing", dedupeKey: `oo:${RUN}` })).toEqual({
      status: "suppressed",
      reason: "opted_out",
    });
    expect(await deliver(user, plan, { proactive: false, reason: "canvas_connected" })).toEqual({
      status: "suppressed",
      reason: "opted_out",
    });
    expect(await deliver(user, { bubbles: [] }, { proactive: false, reason: "x" })).toEqual({
      status: "suppressed",
      reason: "invalid_plan",
    });
    expect(await deliver(randomUUID(), plan, { proactive: false, reason: "x" })).toEqual({ status: "suppressed", reason: "deleted" });
    await expect(deliver(user, plan, { proactive: true, reason: "briefing" })).rejects.toThrow(/dedupeKey/);
    must(await sb.from("channels").update({ opted_out_at: null }).eq("id", channelId).select("id"), "opt in");
  });

  it("redactInboundBodies rewrites only this user's inbound rows", async () => {
    const o = await ingestOne(
      msg((await channelOf(user)).handle, "my feed https://yale.instructure.com/feeds/calendars/user_abc123.ics"),
    );
    if (o.kind !== "turn" || !o.messageId) throw new Error("expected a turn");
    const out = (await outbound(user))[0];
    const n = await redactInboundBodies(user, [o.messageId, out.id], (b) =>
      b.replace(/https:\/\/\S+\.ics/g, "[canvas feed link]"),
    );
    expect(n).toBe(1);
    const row = must(await sb.from("messages").select("body").eq("id", o.messageId).single(), "row");
    expect(row.body).toBe("my feed [canvas feed link]");
    await cancelJobs({ userId: user });
  });
});

describe("/api/channels/dev (T5)", () => {
  it("401 without the secret; maps replyToMessageId → provider id; answers fast; duplicate POST is a no-op", async () => {
    const handle = await ensureFreshHandle();
    const url = "http://localhost:3000/api/channels/dev";
    const unauth = await devRoute(new Request(url, { method: "POST", body: JSON.stringify({ handle, text: "hi" }) }));
    expect(unauth.status).toBe(401);

    const first = await ingestOne(msg(handle, "first"));
    if (first.kind !== "turn") throw new Error("expected a turn");
    await cancelJobs({ userId: first.userId });
    const r = await deliver(first.userId, { bubbles: [{ text: "aria said this" }] }, { proactive: false, reason: "smoke" });
    if (r.status !== "sent") throw new Error(`deliver: ${r.status}`);
    const ariaMsg = r.messageIds[0];

    const body = JSON.stringify({ handle, text: "replying to you", replyToMessageId: ariaMsg, providerMessageId: `smoke-${RUN}-route` });
    const headers = { "x-dev-secret": DEV_SECRET, "content-type": "application/json" };
    afterTasks.length = 0;
    const t0 = Date.now();
    const res = await devRoute(new Request(url, { method: "POST", headers, body }));
    const ms = Date.now() - t0;
    console.info(`[smoke] /api/channels/dev answered in ${ms}ms`);
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(1_500);
    expect(await res.json()).toEqual({ ok: true, outcomes: ["turn"] });
    expect(afterTasks).toHaveLength(1);
    const row = must(
      await sb.from("messages").select("*").eq("provider_message_id", `smoke-${RUN}-route`).single(),
      "inbound",
    );
    expect(row.reply_to_message_id).toBe(ariaMsg);

    const dup = await devRoute(new Request(url, { method: "POST", headers, body }));
    expect(await dup.json()).toEqual({ ok: true, outcomes: ["duplicate"] });
    const unknown = await devRoute(
      new Request(url, { method: "POST", headers, body: JSON.stringify({ handle, text: "x", replyToMessageId: randomUUID() }) }),
    );
    expect(unknown.status).toBe(400);
    afterTasks.length = 0; // never run the captured kick (the turn handler is task 3.1)
    await cancelJobs({ userId: first.userId });
  });
});
