/**
 * Turn orchestration smoke (V2-03 §11 T6/T7, master plan §1.2 / Wave 3 row 3.1), against the
 * LOCAL Supabase stack by default (`SMOKE_TARGET=env` for the env project).
 *
 * Everything goes through the production path for its own rows only: `ingestEvents` (dev
 * provider) → the debounced `conversation_turn` job → `kickJob(jobId)` (claims exactly that job;
 * never the global `runDueJobs`) → `runConversationTurn` with the DB store, the DB lease, the dev
 * provider and `ARIA_AGENT=stub`. A few cases call `runConversationTurn` directly with an injected
 * agent (failure, mid-run follow-up + drain).
 *
 *  1. first contact, greeting only → welcome + vCard rows, `welcome` run, scheduleNextBriefing
 *  2. next message → stub echo keyed `<runId>:0`, run closed with input_message_ids
 *  3. a burst of three → one run with all three
 *  4. "ok" → a tapback only (reaction row, no bubble)
 *  5. reaction-only inbound turn → run with no inputs, agent sees the tapback
 *  6. lease held → rescheduled, nothing consumed
 *  7. orphan run (nothing sent) → recovered and processed
 *  8. agent throws → un-consumed, run failed, `retry`
 *  9. mid-run message → one follow-up pass; the drain claims the tail job inline
 * 10. deleted user → ignored; opted-out channel → closed without a reply
 *
 * Handles are fictional `+1555013xxxx`. Every row hangs off throwaway users (cascade), deleted in
 * afterAll.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

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
// Deterministic local wiring: DB lease, dev provider, in-memory rate limit, stub agent.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.CHANNEL_PROVIDER = "dev";
process.env.ARIA_AGENT = "stub";

import { getProvider } from "@/server/channels";
import type { InboundEvent } from "@/server/channels/types";
import type { JobContext } from "@/server/jobs/types";
import { ingestEvents, type IngestOutcome } from "@/server/pipeline/ingest";
import { kickDelayMs, kickJob, turnDedupeKey } from "@/server/pipeline/kick";
import { createDbLeaseStore } from "@/server/pipeline/lease";
import { stubAgentTurn } from "@/server/pipeline/stub-agent";
import { runConversationTurn } from "@/server/pipeline/turn";
import type { AgentTurnInput, RunAgentTurn } from "@/server/pipeline/types";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN = randomUUID().slice(0, 8);
const userIds = new Set<string>();
let seq = 0;
const dev = getProvider("dev");

type MessageEvent = Extract<InboundEvent, { type: "message" }>;
type TurnOutcome = Extract<IngestOutcome, { kind: "turn" }>;

function msg(handle: string, text: string): MessageEvent {
  seq += 1;
  return {
    type: "message",
    providerMessageId: `turn-smoke-${RUN}-${seq}`,
    handle,
    handleKind: "phone",
    line: "dev",
    service: "imessage",
    text,
    media: [],
    sentAt: new Date(),
    providerOptedOut: false,
  };
}

function must<T>(res: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${label}: no data`);
  return res.data;
}

async function ensureFreshHandle(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const h = `+1555013${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
    const rows = must(await sb.from("channels").select("id").eq("handle", h), "handle probe");
    if (rows.length === 0) return h;
  }
  throw new Error("no free fictional handle");
}

async function send(ev: InboundEvent): Promise<IngestOutcome> {
  const [o] = await ingestEvents(dev, [ev]);
  if (o.kind === "turn" || o.kind === "command" || o.kind === "stored_only") userIds.add(o.userId);
  return o;
}

function asTurn(o: IngestOutcome): TurnOutcome {
  if (o.kind !== "turn") throw new Error(`expected a turn outcome, got ${o.kind}`);
  return o;
}

/** The webhook fast path for one of our jobs: sleep until run_at, claim that job id, run it. */
async function kick(o: TurnOutcome): Promise<void> {
  await kickJob(o.jobId, kickDelayMs(o.runAt, o.dbNow));
}

async function jobRow(id: string) {
  return must(await sb.from("jobs").select("*").eq("id", id).single(), "job");
}

async function runs(userId: string) {
  return must(await sb.from("agent_runs").select("*").eq("user_id", userId).order("started_at"), "runs");
}

async function outbound(userId: string) {
  return must(
    await sb.from("messages").select("*").eq("user_id", userId).eq("direction", "out").order("created_at"),
    "outbound",
  );
}

async function inbound(userId: string) {
  return must(
    await sb.from("messages").select("*").eq("user_id", userId).eq("direction", "in").order("created_at"),
    "inbound",
  );
}

function jobCtx(userId: string, over: Partial<JobContext> = {}): JobContext {
  return {
    jobId: randomUUID(),
    kind: "conversation_turn",
    userId,
    attempt: 1,
    maxAttempts: 3,
    token: randomUUID(),
    now: new Date(),
    deadline: Date.now() + 120_000,
    signal: new AbortController().signal,
    ...over,
  };
}

/** A fresh user whose welcome was already sent (greeting turn run to completion). */
async function welcomedUser(): Promise<{ handle: string; userId: string }> {
  const handle = await ensureFreshHandle();
  const o = asTurn(await send(msg(handle, "hey")));
  await kick(o);
  return { handle, userId: o.userId };
}

afterAll(async () => {
  for (const id of userIds) await sb.from("users").delete().eq("id", id);
  const left = must(await sb.from("users").select("id").in("id", [...userIds]), "cleanup check");
  expect(left).toHaveLength(0);
});

describe("conversation turn (V2-03 T6/T7, master plan §1.2)", () => {
  let handle = "";
  let userId = "";

  it("1: first contact, greeting only → welcome + vCard, welcome run, briefing scheduled, no agent", async () => {
    handle = await ensureFreshHandle();
    const o = asTurn(await send(msg(handle, "hey aria")));
    userId = o.userId;
    await kick(o);

    expect(await jobRow(o.jobId)).toMatchObject({ status: "done" });
    const [run] = await runs(userId);
    expect(run).toMatchObject({ trigger: "welcome", status: "done", is_eval: false, input_message_ids: [o.messageId] });
    expect(run.channel_id).toBe(o.channelId);
    expect(run.finished_at).not.toBeNull();
    const out = await outbound(userId);
    expect(out.map((m) => [m.trigger, m.idempotency_key])).toEqual([
      ["welcome", `welcome:${o.channelId}:0`],
      ["welcome", `welcome:${o.channelId}:1`],
      ["contact_card", `welcome:${o.channelId}:card:0`],
    ]);
    expect(out.every((m) => m.run_id === run.id && m.status === "sent")).toBe(true);
    expect(out[2].media).toEqual([{ url: "http://localhost:3000/aria.vcf", kind: "vcard" }]);
    const [m] = await inbound(userId);
    expect(m.consumed_by_run).toBe(run.id);
    const user = must(await sb.from("users").select("next_briefing_at").eq("id", userId).single(), "user");
    expect(user.next_briefing_at).not.toBeNull();
  });

  it("2: the next message → stub echo keyed <runId>:0; run closed with its inputs", async () => {
    const o = asTurn(await send(msg(handle, "Dan")));
    await kick(o);
    const run = (await runs(userId)).at(-1)!;
    expect(run).toMatchObject({ trigger: "inbound", status: "done", error: null, input_message_ids: [o.messageId] });
    const replies = (await outbound(userId)).filter((m) => m.run_id === run.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ trigger: "reply", idempotency_key: `${run.id}:0`, body: "(stub) Dan", status: "sent" });
  });

  it("3: a burst of three → one run with all three messages", async () => {
    const outs: TurnOutcome[] = [];
    for (const text of ["whats due", "also gym?", "nvm"]) {
      outs.push(asTurn(await send(msg(handle, text))));
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(new Set(outs.map((o) => o.jobId)).size).toBe(1);
    await Promise.all(outs.map((o) => kick(o)));
    const run = (await runs(userId)).at(-1)!;
    expect(run.input_message_ids).toEqual(outs.map((o) => o.messageId));
    const replies = (await outbound(userId)).filter((m) => m.run_id === run.id);
    expect(replies.map((m) => m.body)).toEqual(["(stub) 3 messages: whats due / also gym? / nvm"]);
    expect((await runs(userId)).filter((r) => r.trigger === "inbound")).toHaveLength(2);
  });

  it("4: 'ok' → a like tapback only (no bubble row)", async () => {
    const o = asTurn(await send(msg(handle, "ok")));
    await kick(o);
    const run = (await runs(userId)).at(-1)!;
    expect(run.input_message_ids).toEqual([o.messageId]);
    expect((await outbound(userId)).filter((m) => m.run_id === run.id)).toHaveLength(0);
    const reacts = must(await sb.from("reactions").select("*").eq("message_id", o.messageId!), "reactions");
    expect(reacts).toEqual([expect.objectContaining({ actor: "aria", type: "like" })]);
  });

  it("5: reaction-only turn → run with no inputs; the agent sees the tapback", async () => {
    const last = (await outbound(userId)).filter((m) => m.trigger === "reply").at(-1)!;
    const o = asTurn(
      await send({ type: "reaction", handle, targetProviderId: last.provider_message_id!, reaction: "love", removed: false, sentAt: new Date() }),
    );
    await kick(o);
    const run = (await runs(userId)).at(-1)!;
    expect(run).toMatchObject({ trigger: "inbound", status: "done", input_message_ids: [] });
    const replies = (await outbound(userId)).filter((m) => m.run_id === run.id);
    expect(replies.map((m) => m.body)).toEqual(["(stub) saw your love tapback"]);
  });

  it("6: lease held by another run → rescheduled, nothing consumed", async () => {
    const lease = createDbLeaseStore();
    const other = randomUUID();
    expect(await lease.acquire(userId, other, 30_000)).toBe(true);
    try {
      const o = asTurn(await send(msg(handle, "you there?")));
      const before = Date.now();
      await kick(o);
      const job = await jobRow(o.jobId);
      expect(job.status).toBe("pending");
      expect(Date.parse(job.run_at)).toBeGreaterThan(before);
      const m = (await inbound(userId)).find((x) => x.id === o.messageId)!;
      expect(m.consumed_by_run).toBeNull();
    } finally {
      await lease.release(userId, other);
    }
    // Lease free again: the rescheduled job runs and answers.
    const pending = must(
      await sb.from("jobs").select("*").eq("dedupe_key", turnDedupeKey(userId)).eq("status", "pending").single(),
      "pending turn",
    );
    await kickJob(pending.id, Math.max(0, Date.parse(pending.run_at) - Date.now()) + 100);
    expect(await jobRow(pending.id)).toMatchObject({ status: "done" });
    const replies = (await outbound(userId)).filter((m) => m.body === "(stub) you there?");
    expect(replies).toHaveLength(1);
  });

  it("7: orphan run that sent nothing → failed, its message un-consumed and answered now", async () => {
    const o = asTurn(await send(msg(handle, "lost message")));
    const orphan = must(
      await sb
        .from("agent_runs")
        .insert({ user_id: userId, channel_id: o.channelId, status: "running", trigger: "inbound", input_message_ids: [o.messageId!] })
        .select("id")
        .single(),
      "orphan",
    );
    must(await sb.from("messages").update({ consumed_by_run: orphan.id }).eq("id", o.messageId!).select("id"), "consume");
    await kick(o);
    const after = must(await sb.from("agent_runs").select("*").eq("id", orphan.id).single(), "orphan after");
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/orphan: recovered 1/);
    const m = (await inbound(userId)).find((x) => x.id === o.messageId)!;
    expect(m.consumed_by_run).not.toBe(orphan.id);
    expect((await outbound(userId)).filter((x) => x.body === "(stub) lost message")).toHaveLength(1);
  });

  it("8: agent throws → message un-consumed, run failed, retry", async () => {
    const o = asTurn(await send(msg(handle, "this will fail")));
    const failing: RunAgentTurn = async () => {
      throw new Error("smoke: agent unavailable");
    };
    const out = await runConversationTurn(userId, jobCtx(userId), { runAgentTurn: failing, drain: async () => undefined });
    expect(out).toMatchObject({ type: "retry" });
    const run = (await runs(userId)).at(-1)!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/smoke: agent unavailable/);
    const m = (await inbound(userId)).find((x) => x.id === o.messageId)!;
    expect(m.consumed_by_run).toBeNull();
    // The real job then answers it.
    await kick(o);
    expect((await outbound(userId)).filter((x) => x.body === "(stub) this will fail")).toHaveLength(1);
  });

  it("9: mid-run message → one follow-up pass; the drain claims the tail job inline", async () => {
    const { handle: h, userId: u } = await welcomedUser();
    const first = asTurn(await send(msg(h, "first")));
    const calls: AgentTurnInput[] = [];
    let tail: TurnOutcome | null = null;
    const agent: RunAgentTurn = async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        tail = asTurn(await send(msg(h, "mid-run")));
      }
      return stubAgentTurn(input);
    };
    const out = await runConversationTurn(u, jobCtx(u), { runAgentTurn: agent });
    expect(out).toEqual({ type: "done" });
    expect(calls.map((c) => [c.isFollowUpPass, c.newMessages.map((m) => m.body)])).toEqual([
      [false, ["first"]],
      [true, ["mid-run"]],
    ]);
    // The debounced job (pushed by the mid-run message) was claimed inline by the drain.
    const t = tail as TurnOutcome | null;
    expect(t?.jobId).toBe(first.jobId);
    expect(await jobRow(first.jobId)).toMatchObject({ status: "done" });
    const done = (await runs(u)).filter((r) => r.trigger === "inbound");
    expect(done.map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("10: deleted user → ignored; opted-out channel → closed without a reply", async () => {
    const a = await welcomedUser();
    const o = asTurn(await send(msg(a.handle, "still there?")));
    must(await sb.from("users").update({ deleted_at: new Date().toISOString() }).eq("id", a.userId).select("id"), "delete");
    await kick(o);
    expect(await jobRow(o.jobId)).toMatchObject({ status: "done" });
    expect((await runs(a.userId)).filter((r) => r.trigger === "inbound")).toHaveLength(0);
    expect((await inbound(a.userId)).find((x) => x.id === o.messageId)?.consumed_by_run).toBeNull();

    const b = await welcomedUser();
    const ob = asTurn(await send(msg(b.handle, "hello?")));
    must(await sb.from("channels").update({ opted_out_at: new Date().toISOString() }).eq("id", ob.channelId).select("id"), "opt out");
    const outBefore = (await outbound(b.userId)).length;
    await kick(ob);
    expect((await outbound(b.userId)).length).toBe(outBefore);
    const m = (await inbound(b.userId)).find((x) => x.id === ob.messageId)!;
    expect(m.consumed_by_run).not.toBeNull();
    const closer = must(await sb.from("agent_runs").select("*").eq("id", m.consumed_by_run!).single(), "closer");
    expect(closer).toMatchObject({ trigger: "command", status: "done", error: "ignored: opted out" });
  });
});
