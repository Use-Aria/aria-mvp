/**
 * pipeline/turn.ts (V2-03 §10.1 `turn.test`, §11 T6; master plan §1.2; V2-04 loop test 11 —
 * the watchdog — moved here). `runConversationTurn` runs against in-memory fakes: the lease and
 * message stores from tests/helpers/memory-store.ts, a fake `TurnStore` with the DB's
 * consume / run-row semantics, and a recording `deliver` that writes outbound rows with the real
 * idempotency keys. Jest modern fake timers drive the watchdog, heartbeat and clock.
 */
import type { DeliverResult } from "@/server/channels/deliver";
import type { ChannelRow } from "@/server/channels/repo";
import type { ReplyPlan } from "@/server/channels/types";
import type { JobContext } from "@/server/jobs/types";
import { agentMode } from "@/server/pipeline/agent-impl";
import { isStubAck, stubAgentTurn } from "@/server/pipeline/stub-agent";
import {
  BREATHER_TEXT,
  FALLBACK_TEXT,
  mutatingToolSucceeded,
  PARTIAL_FALLBACK_TEXT,
  parseInboundMedia,
  replaySafe,
  runConversationTurn,
  selectReactionWindow,
  type DeliverReplyInput,
  type RunStatus,
  type RunTrigger,
  type TurnDeps,
  type TurnStore,
  type TurnUser,
} from "@/server/pipeline/turn";
import type { AgentTurnInput, AgentTurnResult, InboundReaction, RunAgentTurn } from "@/server/pipeline/types";
import { startWatchdog } from "@/server/pipeline/watchdog";
import { createMemoryLeaseStore, createMemoryMessageStore } from "../../helpers/memory-store";

const U = "11111111-1111-4111-8111-111111111111";
const CH = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://localhost:3000";

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeRun {
  id: string;
  userId: string;
  trigger: RunTrigger;
  status: "running" | RunStatus;
  error: string | null;
  inputs: string[];
  startedAt: Date;
  isEval: boolean;
}

interface Delivery {
  input: DeliverReplyInput;
  keys: string[];
}

function channelRow(over: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: CH,
    user_id: U,
    kind: "imessage",
    handle: "+15550100001",
    handle_kind: "phone",
    provider: "dev",
    provider_line: "dev",
    verified_at: null,
    is_primary: true,
    opted_out_at: null,
    paused_until: null,
    last_inbound_at: new Date().toISOString(),
    last_service: "imessage",
    created_at: new Date().toISOString(),
    ...over,
  };
}

function makeWorld(opts: { welcomed?: boolean; user?: Partial<TurnUser>; channel?: Partial<ChannelRow> } = {}) {
  const msgs = createMemoryMessageStore(() => Date.now());
  const lease = createMemoryLeaseStore(() => Date.now());
  const runs: FakeRun[] = [];
  const reactions: { id: string; messageId: string; type: string; createdAt: Date; removedAt: Date | null }[] = [];
  let runSeq = 0;
  const user: TurnUser = {
    id: U,
    name: "Dan",
    timezone: "America/New_York",
    timezoneSource: "default",
    deletedAt: null,
    ...opts.user,
  };
  const channel = channelRow(opts.channel);
  const closed: string[] = [];
  /** Runs with a successful mutating tool call (stands in for `agent_runs.tool_calls` / run rows). */
  const mutated = new Set<string>();
  let turnsToday = 0;

  if (opts.welcomed !== false) msgs.insertOutbound(U, null, `welcome:${CH}:0`, "hey! I'm Aria");
  const welcomeKeys = () => msgs.rows.some((r) => r.direction === "out" && r.idempotencyKey?.startsWith(`welcome:${CH}:`));

  const store: TurnStore = {
    async loadUser(id) {
      return id === U ? user : null;
    },
    async primaryChannel(id) {
      return id === U ? channel : null;
    },
    async createRun({ userId, trigger }) {
      runSeq += 1;
      const run: FakeRun = {
        id: `aaaaaaaa-0000-4000-8000-${String(runSeq).padStart(12, "0")}`,
        userId,
        trigger,
        status: "running",
        error: null,
        inputs: [],
        startedAt: new Date(Date.now()),
        isEval: false,
      };
      runs.push(run);
      return { id: run.id, startedAt: run.startedAt };
    },
    async setRunInputs(runId, ids, trigger) {
      const r = runs.find((x) => x.id === runId)!;
      r.inputs = ids;
      r.trigger = trigger;
    },
    async finishRun(runId, status, error) {
      const r = runs.find((x) => x.id === runId)!;
      r.status = status;
      r.error = error;
    },
    async deleteRun(runId) {
      const i = runs.findIndex((x) => x.id === runId && x.status === "running");
      if (i >= 0) runs.splice(i, 1);
    },
    async consume(userId, runId) {
      return msgs.consume(userId, runId).map((m) => ({
        id: m.id,
        body: m.body,
        media: m.media,
        replyToMessageId: m.replyToMessageId,
        createdAt: m.createdAt,
      }));
    },
    async unconsume(runId) {
      return msgs.unconsume(runId);
    },
    async countUnconsumed(userId) {
      return msgs.rows.filter((r) => r.userId === userId && r.direction === "in" && r.consumedByRun === null).length;
    },
    async sideEffects(runId) {
      // The DB store reads `messages.trigger`; here the per-channel welcome keys stand in for it.
      const sent = msgs.outboundForRun(runId).some((r) => !r.idempotencyKey?.startsWith("welcome:"));
      return { sent, mutated: mutated.has(runId) };
    },
    async orphanRuns(userId) {
      return runs.filter((r) => r.userId === userId && r.status === "running" && !r.isEval).map((r) => r.id);
    },
    async lastDoneRunStart(userId) {
      const done = runs.filter((r) => r.userId === userId && r.status === "done").sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return done[0]?.startedAt ?? null;
    },
    async inboundReactions(_userId, since, until) {
      return selectReactionWindow(reactions, since, until);
    },
    async welcomeSent() {
      return welcomeKeys();
    },
    async turnsSince() {
      return turnsToday + runs.filter((r) => r.trigger === "inbound").length;
    },
    async closeUnconsumed(userId) {
      const open = msgs.rows.filter((r) => r.userId === userId && r.direction === "in" && r.consumedByRun === null);
      for (const r of open) {
        r.consumedByRun = "closed";
        closed.push(r.id);
      }
      return open.length;
    },
  };

  const deliveries: Delivery[] = [];
  const deliver = async (input: DeliverReplyInput): Promise<DeliverResult> => {
    if (input.signal?.aborted) return { status: "failed", error: "aborted" };
    const texts = [
      ...input.plan.bubbles.map((b) => b.text),
      ...(input.plan.link ? [input.plan.link.url] : []),
      ...(input.plan.media ?? []).map((m) => `[media ${m.kind}]`),
    ];
    const keys: string[] = [];
    const ids: string[] = [];
    texts.forEach((t, i) => {
      const key = `${input.keyPrefix}:${i}`;
      keys.push(key);
      const id = msgs.insertOutbound(input.userId, input.runId, key, t);
      if (id) ids.push(id);
    });
    deliveries.push({ input, keys });
    if (texts.length > 0 && ids.length === 0) return { status: "suppressed", reason: "duplicate" };
    return { status: "sent", deliveryId: "d", messageIds: ids };
  };

  const scheduled: string[] = [];
  const drained: number[] = [];
  const deps = (agent: RunAgentTurn, over: Partial<TurnDeps> = {}): TurnDeps => ({
    lease,
    runAgentTurn: agent,
    store,
    deliver,
    scheduleNextBriefing: async (id) => {
      scheduled.push(id);
      return null;
    },
    drain: async (_id, budget) => {
      drained.push(budget);
    },
    clock: () => Date.now(),
    appOrigin: () => ORIGIN,
    appBaseUrl: () => ORIGIN,
    rng: () => 0,
    ...over,
  });

  return {
    msgs,
    lease,
    runs,
    reactions,
    deliveries,
    scheduled,
    drained,
    closed,
    mutated,
    store,
    deps,
    setTurnsToday: (n: number) => {
      turnsToday = n;
    },
    replies: () => deliveries.filter((x) => x.input.trigger === "reply"),
    sentTexts: () => deliveries.flatMap((x) => x.input.plan.bubbles.map((b) => b.text)),
  };
}

function job(over: Partial<JobContext> = {}): JobContext {
  return {
    jobId: "job-1",
    kind: "conversation_turn",
    userId: U,
    attempt: 1,
    maxAttempts: 3,
    token: "tok",
    now: new Date(),
    deadline: Date.now() + 270_000,
    signal: new AbortController().signal,
    ...over,
  };
}

function reply(plan: ReplyPlan, extra: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return { plan, model: "claude-haiku-5-5", escalated: false, interimSent: false, costUsd: 0.001, ...extra };
}

/** Records every input; answers with `fn` (default: one echo bubble). */
function recordingAgent(fn?: (input: AgentTurnInput, n: number) => Promise<AgentTurnResult> | AgentTurnResult) {
  const calls: AgentTurnInput[] = [];
  const agent: RunAgentTurn = async (input) => {
    calls.push(input);
    return fn ? fn(input, calls.length) : reply({ bubbles: [{ text: `ok (${input.newMessages.length})` }] });
  };
  return { agent, calls };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-10-10T16:00:00Z") });
  for (const level of ["info", "warn", "error"] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ── runConversationTurn ─────────────────────────────────────────────────────

describe("runConversationTurn", () => {
  test("lease held by another run → reschedule +3s, nothing consumed, no agent", async () => {
    const w = makeWorld();
    w.msgs.addInbound(U, "whats due");
    await w.lease.acquire(U, "other-run", 60_000);
    const { agent, calls } = recordingAgent();
    const out = await runConversationTurn(U, job(), w.deps(agent));
    expect(out).toEqual({ type: "reschedule", runAt: new Date(Date.now() + 3_000), reason: "lease_held" });
    expect(calls).toHaveLength(0);
    expect(w.runs).toHaveLength(0);
    expect(w.msgs.rows.filter((r) => r.direction === "in" && r.consumedByRun)).toHaveLength(0);
  });

  test("nothing unconsumed → done, no send, no run row left", async () => {
    const w = makeWorld();
    const { agent, calls } = recordingAgent();
    const out = await runConversationTurn(U, job(), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    expect(calls).toHaveLength(0);
    expect(w.runs).toHaveLength(0);
    expect(w.deliveries).toHaveLength(0);
    expect(w.lease.holder(U)).toBeNull();
  });

  test("a burst is one run: all messages in newMessages (oldest first), reply keyed <runId>:<i>, run closed", async () => {
    const w = makeWorld();
    const a = w.msgs.addInbound(U, "whats due");
    jest.advanceTimersByTime(300);
    const b = w.msgs.addInbound(U, "also gym?");
    jest.advanceTimersByTime(300);
    const c = w.msgs.addInbound(U, "nvm");
    const { agent, calls } = recordingAgent();
    const out = await runConversationTurn(U, job(), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    expect(calls).toHaveLength(1);
    expect(calls[0].newMessages.map((m) => m.id)).toEqual([a, b, c]);
    expect(calls[0]).toMatchObject({
      userId: U,
      isFollowUpPass: false,
      welcomeSent: false,
      isEval: false,
      trigger: { kind: "inbound" },
      inboundReactions: [],
      identity: { isNewUser: false, name: "Dan", timezone: "America/New_York", timezoneSource: "default" },
    });
    expect(calls[0].channel).toMatchObject({ channelId: CH, provider: "dev", service: "imessage" });
    const run = w.runs[0];
    expect(calls[0].runId).toBe(run.id);
    expect(run).toMatchObject({ status: "done", error: null, trigger: "inbound", inputs: [a, b, c] });
    expect(w.replies()).toHaveLength(1);
    expect(w.replies()[0].keys).toEqual([`${run.id}:0`]);
    expect(w.lease.holder(U)).toBeNull();
    expect(w.drained).toHaveLength(1);
  });

  test("a message arriving mid-run gets exactly one follow-up pass; later ones are left for the next job", async () => {
    const w = makeWorld();
    w.msgs.addInbound(U, "first");
    let late = "";
    let later = "";
    const { agent, calls } = recordingAgent((input, n) => {
      if (n === 1) late = w.msgs.addInbound(U, "wait also this");
      if (n === 2) later = w.msgs.addInbound(U, "and this");
      return reply({ bubbles: [{ text: `pass ${n}` }] });
    });
    await runConversationTurn(U, job(), w.deps(agent));
    expect(calls).toHaveLength(2);
    expect(calls[1].isFollowUpPass).toBe(true);
    expect(calls[1].newMessages.map((m) => m.id)).toEqual([late]);
    expect(calls[1].runId).not.toBe(calls[0].runId);
    expect(w.runs.map((r) => r.status)).toEqual(["done", "done"]);
    expect(w.msgs.rows.find((r) => r.id === later)?.consumedByRun).toBeNull();
    expect(w.replies()).toHaveLength(2);
  });

  test("watchdog: a slow agent gets exactly one interim at 8s, and the reply is capped at 2 bubbles", async () => {
    const w = makeWorld();
    w.msgs.addInbound(U, "whats due this week");
    let toolInterim: boolean | null = null;
    const { agent } = recordingAgent(async (input) => {
      await new Promise((r) => setTimeout(r, 12_000));
      toolInterim = await input.interim("send_interim tool line");
      return reply({ bubbles: [{ text: "one" }, { text: "two" }, { text: "three" }] });
    });
    const p = runConversationTurn(U, job(), w.deps(agent));
    await jest.advanceTimersByTimeAsync(7_999);
    expect(w.deliveries.filter((x) => x.input.trigger === "interim")).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    const interims = w.deliveries.filter((x) => x.input.trigger === "interim");
    expect(interims).toHaveLength(1);
    expect(interims[0].keys).toEqual([`${w.runs[0].id}:interim:0`]);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ type: "done" });
    expect(toolInterim).toBe(false);
    expect(w.deliveries.filter((x) => x.input.trigger === "interim")).toHaveLength(1);
    const bubbles = w.replies()[0].input.plan.bubbles.map((b) => b.text);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]).toContain("three");
  });

  test("watchdog: a fast agent gets no interim; the agent's own interim blocks the watchdog", async () => {
    const w = makeWorld();
    w.msgs.addInbound(U, "hi");
    const { agent } = recordingAgent(async (input) => {
      expect(await input.interim("checking")).toBe(true);
      expect(await input.interim("again")).toBe(false);
      await new Promise((r) => setTimeout(r, 10_000));
      return reply({ bubbles: [{ text: "done" }] }, { interimSent: true });
    });
    const p = runConversationTurn(U, job(), w.deps(agent));
    await jest.advanceTimersByTimeAsync(11_000);
    await p;
    const interims = w.deliveries.filter((x) => x.input.trigger === "interim");
    expect(interims).toHaveLength(1);
    expect(interims[0].input.plan.bubbles[0].text).toBe("checking");
  });

  test("agent throw → un-consume + retry; run marked failed", async () => {
    const w = makeWorld();
    const m = w.msgs.addInbound(U, "hello?");
    const { agent } = recordingAgent(() => {
      throw new Error("model overloaded");
    });
    const out = await runConversationTurn(U, job({ attempt: 1 }), w.deps(agent));
    expect(out).toMatchObject({ type: "retry" });
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBeNull();
    expect(w.runs[0]).toMatchObject({ status: "failed" });
    expect(w.runs[0].error).toContain("model overloaded");
    expect(w.replies()).toHaveLength(0);
    expect(w.drained).toHaveLength(0);
  });

  test("agent throw on the last attempt → one fallback bubble, messages stay consumed, done", async () => {
    const w = makeWorld();
    const m = w.msgs.addInbound(U, "hello?");
    const { agent } = recordingAgent(() => {
      throw new Error("still down");
    });
    const out = await runConversationTurn(U, job({ attempt: 3, maxAttempts: 3 }), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    const fb = w.deliveries.filter((x) => x.input.trigger === "fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0].input.plan.bubbles[0].text).toBe(FALLBACK_TEXT);
    expect(fb[0].keys).toEqual([`${w.runs[0].id}:fallback:0`]);
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBe(w.runs[0].id);
    expect(w.runs[0].status).toBe("failed");
  });

  test("throw after a successful mutating tool → stays consumed, one partial fallback, no retry", async () => {
    const w = makeWorld();
    const m = w.msgs.addInbound(U, "remind me at 5 and block 2h for chem");
    const { agent, calls } = recordingAgent((input) => {
      w.mutated.add(input.runId); // create_reminder succeeded, then the model call failed
      throw new Error("model overloaded");
    });
    const out = await runConversationTurn(U, job({ attempt: 1, maxAttempts: 3 }), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    expect(calls).toHaveLength(1);
    expect(w.runs).toHaveLength(1);
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBe(w.runs[0].id);
    const fb = w.deliveries.filter((x) => x.input.trigger === "fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0].input.plan.bubbles[0].text).toBe(PARTIAL_FALLBACK_TEXT);
    expect(fb[0].keys).toEqual([`${w.runs[0].id}:fallback:0`]);
    expect(w.runs[0].status).toBe("failed");
    expect(w.runs[0].error).toContain("model overloaded");
    expect(w.runs[0].error).toContain("mutated, not replayed");
    expect(w.replies()).toHaveLength(0);
    // A later job finds nothing to replay: no second run, the agent is not called again.
    const again = recordingAgent();
    await runConversationTurn(U, job({ attempt: 2 }), w.deps(again.agent));
    expect(again.calls).toHaveLength(0);
    expect(w.runs).toHaveLength(1);
  });

  test("throw after the interim went out → stays consumed, one fallback, no retry", async () => {
    const w = makeWorld();
    const m = w.msgs.addInbound(U, "plan my week");
    const { agent } = recordingAgent(async (input) => {
      expect(await input.interim("one sec 👀")).toBe(true);
      throw new Error("tool loop blew up");
    });
    const out = await runConversationTurn(U, job({ attempt: 1 }), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBe(w.runs[0].id);
    expect(w.deliveries.map((x) => x.input.trigger)).toEqual(["interim", "fallback"]);
    expect(w.deliveries[1].input.plan.bubbles[0].text).toBe(FALLBACK_TEXT);
    expect(w.runs[0]).toMatchObject({ status: "failed" });
    expect(w.runs[0].error).toContain("partial send, not replayed");
  });

  test("watchdog interim, then the agent throws → no retry (the interim would repeat)", async () => {
    const w = makeWorld();
    w.msgs.addInbound(U, "whats due");
    const { agent } = recordingAgent(async () => {
      await new Promise((r) => setTimeout(r, 9_000));
      throw new Error("late failure");
    });
    const p = runConversationTurn(U, job({ attempt: 1 }), w.deps(agent));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ type: "done" });
    expect(w.deliveries.map((x) => x.input.trigger)).toEqual(["interim", "fallback"]);
  });

  test("first contact: the welcome alone doesn't block a retry (it's keyed per channel)", async () => {
    const w = makeWorld({ welcomed: false });
    const m = w.msgs.addInbound(U, "hi whats due tmrw");
    const { agent } = recordingAgent(() => {
      throw new Error("model overloaded");
    });
    const out = await runConversationTurn(U, job({ attempt: 1 }), w.deps(agent));
    expect(out).toMatchObject({ type: "retry" });
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBeNull();
    expect(w.deliveries.filter((x) => x.input.trigger === "fallback")).toHaveLength(0);
  });

  test("lease lost after a mutating tool → messages stay consumed, nothing sent", async () => {
    const w = makeWorld();
    const m = w.msgs.addInbound(U, "remind me at 5");
    const { agent } = recordingAgent(async (input) => {
      w.mutated.add(input.runId);
      await new Promise((r) => setTimeout(r, 70_000));
      return reply({ bubbles: [{ text: "done" }] });
    });
    const failingLease = { ...w.lease, extend: async () => false };
    const p = runConversationTurn(U, job(), w.deps(agent, { lease: failingLease }));
    await jest.advanceTimersByTimeAsync(71_000);
    expect(await p).toMatchObject({ type: "reschedule", reason: "lease_lost" });
    expect(w.replies()).toHaveLength(0);
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBe(w.runs[0].id);
    expect(w.runs[0]).toMatchObject({ status: "aborted", error: "lease lost; mutated, not replayed" });
  });

  test("orphan run that mutated (nothing sent) is not replayed", async () => {
    const w = makeWorld();
    const orphan = await w.store.createRun({ userId: U, channelId: CH, trigger: "inbound" });
    const m = w.msgs.addInbound(U, "remind me at 5");
    w.msgs.consume(U, orphan.id);
    w.mutated.add(orphan.id);
    const { agent, calls } = recordingAgent();
    await runConversationTurn(U, job(), w.deps(agent));
    expect(w.runs.find((r) => r.id === orphan.id)).toMatchObject({ status: "failed", error: "orphan: mutated, not replayed" });
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBe(orphan.id);
    expect(calls).toHaveLength(0);
  });

  test("orphan run with no outbound is recovered: its messages are un-consumed and processed now", async () => {
    const w = makeWorld();
    const orphan = await w.store.createRun({ userId: U, channelId: CH, trigger: "inbound" });
    const m = w.msgs.addInbound(U, "did you get this");
    w.msgs.consume(U, orphan.id);
    const { agent, calls } = recordingAgent();
    await runConversationTurn(U, job(), w.deps(agent));
    expect(w.runs.find((r) => r.id === orphan.id)).toMatchObject({ status: "failed" });
    expect(w.runs.find((r) => r.id === orphan.id)?.error).toContain("orphan: recovered 1");
    expect(calls).toHaveLength(1);
    expect(calls[0].newMessages.map((x) => x.id)).toEqual([m]);
  });

  test("orphan run that already sent is not replayed", async () => {
    const w = makeWorld();
    const orphan = await w.store.createRun({ userId: U, channelId: CH, trigger: "inbound" });
    const m = w.msgs.addInbound(U, "did you get this");
    w.msgs.consume(U, orphan.id);
    w.msgs.insertOutbound(U, orphan.id, `${orphan.id}:0`, "partial reply");
    const { agent, calls } = recordingAgent();
    const out = await runConversationTurn(U, job(), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    expect(w.runs.find((r) => r.id === orphan.id)).toMatchObject({ status: "failed", error: "orphan: partial send, not replayed" });
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBe(orphan.id);
    expect(calls).toHaveLength(0);
  });

  test("first contact, greeting only → welcome + vCard, scheduleNextBriefing, no agent; run trigger 'welcome'", async () => {
    const w = makeWorld({ welcomed: false, user: { name: null } });
    w.msgs.addInbound(U, "hey aria");
    const { agent, calls } = recordingAgent();
    const out = await runConversationTurn(U, job(), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    expect(calls).toHaveLength(0);
    const welcome = w.deliveries.find((x) => x.input.trigger === "welcome");
    expect(welcome?.keys).toEqual([`welcome:${CH}:0`, `welcome:${CH}:1`]);
    expect(welcome?.input.plan.bubbles[0].text).toMatch(/AI assistant/);
    expect(welcome?.input.plan.bubbles[1].text).toMatch(/call you/);
    const card = w.deliveries.find((x) => x.input.trigger === "contact_card");
    expect(card?.input.plan.media).toEqual([{ url: `${ORIGIN}/aria.vcf`, kind: "vcard" }]);
    expect(w.scheduled).toEqual([U]);
    expect(w.runs[0]).toMatchObject({ trigger: "welcome", status: "done" });
  });

  test("first contact with content → welcome + vCard, then the agent with isNewUser + welcomeSent (no watchdog)", async () => {
    const w = makeWorld({ welcomed: false });
    w.msgs.addInbound(U, "hi whats due tmrw");
    const { agent, calls } = recordingAgent(async () => {
      await new Promise((r) => setTimeout(r, 9_000));
      return reply({ bubbles: [{ text: "nothing due" }] });
    });
    const p = runConversationTurn(U, job(), w.deps(agent));
    await jest.advanceTimersByTimeAsync(10_000);
    await p;
    expect(calls).toHaveLength(1);
    expect(calls[0].welcomeSent).toBe(true);
    expect(calls[0].identity.isNewUser).toBe(true);
    expect(w.deliveries.map((x) => x.input.trigger)).toEqual(["welcome", "contact_card", "reply"]);
    expect(w.scheduled).toEqual([U]);
    expect(w.runs[0].trigger).toBe("inbound");
  });

  test("welcome already sent → no second welcome on the next turn", async () => {
    const w = makeWorld({ welcomed: false });
    w.msgs.addInbound(U, "hey");
    await runConversationTurn(U, job(), w.deps(recordingAgent().agent));
    w.msgs.addInbound(U, "Dan");
    const { agent, calls } = recordingAgent();
    await runConversationTurn(U, job(), w.deps(agent));
    expect(w.deliveries.filter((x) => x.input.trigger === "welcome")).toHaveLength(1);
    expect(calls[0].identity.isNewUser).toBe(false);
    expect(w.scheduled).toEqual([U]);
  });

  test("opted-out channel → no run, no send; unconsumed inbound is closed", async () => {
    const w = makeWorld({ channel: { opted_out_at: new Date().toISOString() } });
    const m = w.msgs.addInbound(U, "hello?");
    const { agent, calls } = recordingAgent();
    const out = await runConversationTurn(U, job(), w.deps(agent));
    expect(out).toEqual({ type: "done" });
    expect(calls).toHaveLength(0);
    expect(w.deliveries).toHaveLength(0);
    expect(w.closed).toEqual([m]);
    expect(w.runs).toHaveLength(0);
  });

  test("deleted user → ignored (no lease, no run)", async () => {
    const w = makeWorld({ user: { deletedAt: new Date() } });
    w.msgs.addInbound(U, "hello?");
    const acquire = jest.spyOn(w.lease, "acquire");
    const { agent, calls } = recordingAgent();
    expect(await runConversationTurn(U, job(), w.deps(agent))).toEqual({ type: "done" });
    expect(acquire).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(w.runs).toHaveLength(0);
  });

  test("reaction-only turn → the agent runs with newMessages [] and the tapback", async () => {
    const w = makeWorld();
    // A finished earlier run, then Aria's message and the user's tapback on it.
    w.msgs.addInbound(U, "remind me at 5");
    await runConversationTurn(U, job(), w.deps(recordingAgent().agent));
    const ariaMsg = w.msgs.rows.filter((r) => r.direction === "out").at(-1)!;
    jest.advanceTimersByTime(5_000);
    w.reactions.push({ id: "r-1", messageId: ariaMsg.id, type: "love", createdAt: new Date(), removedAt: null });
    jest.advanceTimersByTime(3_000);
    const { agent, calls } = recordingAgent(() => reply({ bubbles: [] }));
    await runConversationTurn(U, job(), w.deps(agent));
    expect(calls).toHaveLength(1);
    expect(calls[0].newMessages).toEqual([]);
    expect(calls[0].inboundReactions).toEqual<InboundReaction[]>([
      { id: "r-1", targetMessageId: ariaMsg.id, type: "love", removed: false, createdAt: expect.any(Date) },
    ]);
    // The cursor moved: the same tapback is not presented again.
    jest.advanceTimersByTime(3_000);
    const again = recordingAgent();
    await runConversationTurn(U, job(), w.deps(again.agent));
    expect(again.calls).toHaveLength(0);
  });

  test("lease lost mid-run → nothing more is sent, messages released, reschedule", async () => {
    const w = makeWorld();
    const m = w.msgs.addInbound(U, "plan my week");
    const { agent } = recordingAgent(async () => {
      await new Promise((r) => setTimeout(r, 70_000));
      return reply({ bubbles: [{ text: "here's your week" }] });
    });
    const failingLease = { ...w.lease, extend: async () => false };
    const p = runConversationTurn(U, job(), w.deps(agent, { lease: failingLease }));
    await jest.advanceTimersByTimeAsync(71_000);
    const out = await p;
    expect(out).toMatchObject({ type: "reschedule", reason: "lease_lost" });
    expect(w.replies()).toHaveLength(0);
    expect(w.msgs.rows.find((r) => r.id === m)?.consumedByRun).toBeNull();
    expect(w.runs[0]).toMatchObject({ status: "aborted", error: "lease lost" });
  });

  test("agent signal aborts 30s before the run deadline", async () => {
    const w = makeWorld();
    w.msgs.addInbound(U, "slow one");
    let abortedAt: number | null = null;
    const start = Date.now();
    const { agent } = recordingAgent(
      (input) =>
        new Promise((_, reject) => {
          input.signal.addEventListener("abort", () => {
            abortedAt = Date.now() - start;
            reject(new Error("aborted"));
          });
        }),
    );
    const p = runConversationTurn(U, job({ deadline: start + 100_000 }), w.deps(agent));
    await jest.advanceTimersByTimeAsync(80_000);
    // The 8s watchdog interim already went out, so the run is not replayed: fallback instead.
    expect(await p).toEqual({ type: "done" });
    expect(abortedAt).toBe(70_000);
    expect(w.deliveries.map((x) => x.input.trigger)).toEqual(["interim", "fallback"]);
  });

  test("daily turn cap → one breather bubble per local day, no agent", async () => {
    const w = makeWorld();
    w.setTurnsToday(200);
    w.msgs.addInbound(U, "another one");
    const { agent, calls } = recordingAgent();
    await runConversationTurn(U, job(), w.deps(agent));
    expect(calls).toHaveLength(0);
    const fb = w.deliveries.filter((x) => x.input.trigger === "fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0].input.plan.bubbles[0].text).toBe(BREATHER_TEXT);
    expect(fb[0].keys).toEqual([`cap:${U}:2026-10-10:0`]);
    expect(w.runs[0]).toMatchObject({ status: "done", error: "daily_turn_cap" });
  });

  test("with the stub agent: 'ok' gets a like tapback only; a question gets an echo", async () => {
    const w = makeWorld();
    const ok = w.msgs.addInbound(U, "ok");
    await runConversationTurn(U, job(), w.deps(stubAgentTurn));
    expect(w.replies()[0].input.plan).toEqual({
      bubbles: [],
      reactions: [{ targetMessageId: ok, type: "like", fallbackText: "👍" }],
    });
    w.msgs.addInbound(U, "whats due");
    await runConversationTurn(U, job(), w.deps(stubAgentTurn));
    expect(w.replies()[1].input.plan.bubbles[0].text).toBe("(stub) whats due");
  });
});

// ── pure helpers ────────────────────────────────────────────────────────────

describe("startWatchdog", () => {
  test("fires once after the delay; cancel before prevents it", async () => {
    const fire = jest.fn(async () => undefined);
    const wd = startWatchdog(8_000, fire);
    await jest.advanceTimersByTimeAsync(7_999);
    expect(wd.fired()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(wd.fired()).toBe(true);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fire).toHaveBeenCalledTimes(1);

    const fire2 = jest.fn(async () => undefined);
    const wd2 = startWatchdog(8_000, fire2);
    wd2.cancel();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fire2).not.toHaveBeenCalled();
    expect(wd2.fired()).toBe(false);
  });

  test("a rejecting fire is swallowed", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    startWatchdog(10, async () => {
      throw new Error("boom");
    });
    await jest.advanceTimersByTimeAsync(20);
    expect(err).toHaveBeenCalled();
  });
});

describe("selectReactionWindow", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, s));
  const rows = [
    { id: "a", messageId: "m1", type: "like", createdAt: t(1), removedAt: null },
    { id: "b", messageId: "m1", type: "love", createdAt: t(5), removedAt: null },
    { id: "c", messageId: "m2", type: "laugh", createdAt: t(2), removedAt: t(6) },
    { id: "d", messageId: "m2", type: "👍", createdAt: t(9), removedAt: null },
  ];
  test("(since, until] by add time, removals at their removal time", () => {
    const got = selectReactionWindow(rows, t(3), t(8));
    expect(got.map((r) => [r.id, r.removed])).toEqual([
      ["b", false],
      ["c", true],
    ]);
    expect(got[1].createdAt).toEqual(t(6));
  });
  test("no previous run → everything up to `until`", () => {
    expect(selectReactionWindow(rows, null, t(5)).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("side-effect rule", () => {
  const MUT = new Set(["create_reminder", "draft_email"]);
  test("mutatingToolSucceeded: only an ok call of a mutating tool counts", () => {
    expect(mutatingToolSucceeded([{ name: "create_reminder", iteration: 1, ok: true, ms: 40 }], MUT)).toBe(true);
    expect(mutatingToolSucceeded([{ name: "create_reminder", iteration: 1, ok: false, ms: 40 }], MUT)).toBe(false);
    expect(mutatingToolSucceeded([{ name: "get_agenda", iteration: 1, ok: true, ms: 40 }], MUT)).toBe(false);
    expect(mutatingToolSucceeded(null, MUT)).toBe(false);
    expect(mutatingToolSucceeded([null, "x", { ok: true }], MUT)).toBe(false);
  });

  test("mutatingToolSucceeded: a timed-out mutating call counts (it may have landed)", () => {
    expect(mutatingToolSucceeded([{ name: "create_reminder", iteration: 1, ok: false, ms: 10000, timedOut: true }], MUT)).toBe(true);
    expect(mutatingToolSucceeded([{ name: "get_agenda", iteration: 1, ok: false, ms: 10000, timedOut: true }], MUT)).toBe(false);
    expect(mutatingToolSucceeded([{ name: "create_reminder", iteration: 1, ok: false, ms: 10000, timedOut: false }], MUT)).toBe(false);
  });
  test("replaySafe: only with nothing sent and nothing mutated", () => {
    expect(replaySafe({ sent: false, mutated: false })).toBe(true);
    expect(replaySafe({ sent: true, mutated: false })).toBe(false);
    expect(replaySafe({ sent: false, mutated: true })).toBe(false);
  });
});

describe("parseInboundMedia", () => {
  test("keeps well-formed entries, defaults unknown kinds to other", () => {
    expect(
      parseInboundMedia([
        { url: "https://x/y.pdf", kind: "pdf", filename: "syllabus.pdf", size: 10 },
        { url: "https://x/z", kind: "weird" },
        { kind: "pdf" },
        "nope",
      ]),
    ).toEqual([
      { url: "https://x/y.pdf", kind: "pdf", filename: "syllabus.pdf", size: 10 },
      { url: "https://x/z", kind: "other" },
    ]);
    expect(parseInboundMedia(null)).toEqual([]);
  });
});

describe("stub agent + agent selection", () => {
  test("isStubAck", () => {
    for (const s of ["ok", "OK!", "ty", "bet", "thanks", "k", "sounds good 👍"]) expect(isStubAck(s)).toBe(true);
    for (const s of ["ok but what about friday", "whats due", "", null]) expect(isStubAck(s)).toBe(false);
  });

  test("ARIA_AGENT: unset/stub → stub, anything else → real", () => {
    expect(agentMode(undefined)).toBe("stub");
    expect(agentMode("")).toBe("stub");
    expect(agentMode(" STUB ")).toBe("stub");
    expect(agentMode("real")).toBe("real");
    expect(agentMode("haiku")).toBe("real");
  });
});
