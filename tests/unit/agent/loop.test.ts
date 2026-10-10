/**
 * Agent loop + `runAgentTurn` orchestration (V2-04 §10.1 loop tests 1–10; master plan §1.2, §5
 * row 3.2). A scripted fake `call` drives the real loop logic — no network, no DB.
 * (Loop test 11, the 8s watchdog, lives in the pipeline: task 3.1.)
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AliasTable } from "@/server/agent/context/aliases";
import type { BuiltContext } from "@/server/agent/context/build";
import type { EscalationReason } from "@/server/agent/escalation";
import { runAgentTurnWith, followupsFor, type AgentDeps, type FollowupJobs } from "@/server/agent/index";
import {
  CANNED,
  createInterim,
  createLinkSlots,
  createTaint,
  lenientParsePlan,
  newLoopStats,
  runLoop,
  serializeToolData,
  stableStringify,
  unknownAliases,
  type LoopContext,
  type LoopDeps,
  type LoopStart,
} from "@/server/agent/loop";
import { REPLY_FORMAT } from "@/server/agent/plan";
import type { RunStatsPatch } from "@/server/agent/runs";
import { defineTool, EV, requireEvidence, type AgentTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import type { ChannelContext } from "@/server/channels/types";
import { LlmUnavailableError, type LlmRequest, type LlmResponse } from "@/server/llm";
import { AgentUnavailableError, type AgentTurnInput } from "@/server/pipeline/types";
import { computeRegisterHint } from "@/shared/register";

// ---------------------------------------------------------------- fixtures

const U = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const MSG_ID = "1a2b3c4d-0000-4000-8000-000000000000";
const ITEM_ID = "5e6f7a8b-0000-4000-8000-000000000000";
const NOW = new Date("2026-10-10T15:00:00Z");

const CHANNEL: ChannelContext = {
  channelId: "c1",
  provider: "dev",
  kind: "imessage",
  service: "imessage",
  handleKind: "phone",
  capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
  windowOpen: true,
};

const REGISTER = computeRegisterHint(["yo whats due tmrw", "ok bet"]);

function planJson(bubbles: string[], extra: Partial<{ reactions: { target: string; type: string }[]; reply_to: string | null; link: string | null }> = {}): string {
  return JSON.stringify({ reactions: extra.reactions ?? [], bubbles, reply_to: extra.reply_to ?? null, link: extra.link ?? null });
}

const text = (t: string): Anthropic.TextBlock => ({ type: "text", text: t, citations: null });
const thinking = (t: string, sig: string): Anthropic.ThinkingBlock => ({ type: "thinking", thinking: t, signature: sig });
let useSeq = 0;
const toolUse = (name: string, input: unknown, id = `toolu_${++useSeq}`): Anthropic.ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
  caller: { type: "direct" },
});

function resp(content: Anthropic.ContentBlock[], stopReason: Anthropic.StopReason | null = null, cost = 0.001): LlmResponse {
  const hasTool = content.some((b) => b.type === "tool_use");
  return {
    model: "claude-haiku-5-5",
    content,
    text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    stopReason: stopReason ?? (hasTool ? "tool_use" : "end_turn"),
    refusal: null,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, costUsd: cost },
    latencyMs: 5,
    requestId: null,
  };
}

const final = (bubbles: string[], extra?: Parameters<typeof planJson>[1]) => resp([text(planJson(bubbles, extra))]);

/** Scripted model: returns `script` in order; records a JSON snapshot of every request at call time. */
function fakeCall(script: (LlmResponse | Error | ((req: LlmRequest) => LlmResponse))[]) {
  const requests: LlmRequest[] = [];
  const snapshots: string[] = [];
  let i = 0;
  const call = async (req: LlmRequest): Promise<LlmResponse> => {
    requests.push(req);
    snapshots.push(JSON.stringify(req.messages));
    const next = script[i++];
    if (next === undefined) throw new Error(`fake call: script exhausted at call ${i}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  };
  return { call, requests, snapshots };
}

/** Execution log shared by the fake tools. */
let events: string[] = [];

function tool(
  name: string,
  run: (ctx: ToolCtx, input: Record<string, unknown>) => Promise<ToolResult>,
  opts: { mutates?: boolean; untrustedOutput?: boolean; input?: z.ZodObject } = {},
): AgentTool {
  return defineTool({
    name,
    description: `Test tool ${name}: call it whenever the scripted fake model decides to use it in a test.`,
    input: opts.input ?? z.strictObject({ q: z.string().optional() }),
    ...(opts.mutates ? { mutates: true } : {}),
    ...(opts.untrustedOutput ? { untrustedOutput: true } : {}),
    run: async (ctx, input) => run(ctx, input as Record<string, unknown>),
  });
}

const okTool = (name: string, data: string | Record<string, unknown> = { ok: 1 }) =>
  tool(name, async () => {
    events.push(name);
    return { ok: true, data };
  });

const interimTool = tool(
  "send_interim",
  async (ctx, input) => {
    events.push("send_interim");
    const sent = await ctx.interim.send(String(input.text));
    return sent ? { ok: true, data: "sent" } : { ok: false, error: "already_sent" };
  },
  { input: z.strictObject({ text: z.string().min(1).max(120) }) },
);

const throwingTool = tool("explode", async () => {
  events.push("explode");
  throw new Error("boom with secret detail");
});

const markTool = tool(
  "mark_item",
  async (ctx, input) => {
    const gate = requireEvidence(ctx, String(input.evidence));
    if ("ok" in gate && gate.ok === false) return gate;
    const id = ctx.aliases.resolve(String(input.item), "t");
    if (!id) return { ok: false, error: "unknown item" };
    events.push(`mark:${id}`);
    return { ok: true, data: { done: true } };
  },
  { mutates: true, input: z.strictObject({ item: z.string().regex(/^t_[0-9a-f]{8,10}$/), evidence: EV }) },
);

interface Harness {
  ctx: ToolCtx;
  built: LoopContext;
  aliases: AliasTable;
  msgAlias: string;
  itemAlias: string;
  interimSent: string[];
}

function harness(opts: { interimOk?: boolean; signal?: AbortSignal } = {}): Harness {
  const aliases = new AliasTable();
  const msgAlias = aliases.mint("m", MSG_ID);
  const itemAlias = aliases.mint("t", ITEM_ID);
  const interimSent: string[] = [];
  const ctx: ToolCtx = {
    userId: U,
    runId: RUN,
    now: NOW,
    timezone: "America/New_York",
    channel: CHANNEL,
    trigger: { kind: "inbound" },
    aliases,
    evidence: new Set([msgAlias]),
    userText: "mark the pset done",
    taint: createTaint(),
    links: createLinkSlots(),
    interim: createInterim(async (t) => {
      interimSent.push(t);
      return opts.interimOk ?? true;
    }),
    signal: opts.signal ?? new AbortController().signal,
    log: () => undefined,
  };
  const built: LoopContext = {
    system: "STATIC SYSTEM PROMPT",
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "<aria_profile>…</aria_profile>" }] },
      { role: "user", content: [{ type: "text", text: `<aria_now>…</aria_now>\n<new_messages>[${msgAlias}] hi</new_messages>` }] },
    ],
    historyBreakpointIndex: 0,
    register: REGISTER,
  };
  return { ctx, built, aliases, msgAlias, itemAlias, interimSent };
}

const HAIKU: LoopStart = { model: "claude-haiku-5-5", escalated: false, escalationReason: null };

function deps(call: LoopDeps["call"], tools: AgentTool[], claim: (r: EscalationReason) => Promise<boolean> = async () => false, extra: Partial<LoopDeps> = {}) {
  const claims: EscalationReason[] = [];
  let t = 0;
  const d: LoopDeps = {
    call,
    tools,
    claimEscalation: async (r) => {
      claims.push(r);
      return claim(r);
    },
    now: () => (t += 10),
    ...extra,
  };
  return { d, claims };
}

const lastUserBlocks = (req: LlmRequest): Anthropic.ContentBlockParam[] => {
  const last = req.messages[req.messages.length - 1];
  expect(last.role).toBe("user");
  return typeof last.content === "string" ? [] : last.content;
};

const toolResults = (req: LlmRequest) =>
  lastUserBlocks(req).filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");

beforeEach(() => {
  events = [];
  useSeq = 0;
});

// ---------------------------------------------------------------- loop tests 1–10

describe("runLoop", () => {
  it("(1) end_turn JSON → plan, one call with the reply format and cache settings", async () => {
    const h = harness();
    const { call, requests } = fakeCall([final(["hey!"], { reactions: [{ target: h.msgAlias, type: "love" }] })]);
    const { d } = deps(call, []);
    const out = await runLoop(h.ctx, h.built, d, HAIKU);
    expect(out.end).toBe("final");
    expect(out.plan.bubbles).toEqual(["hey!"]);
    expect(out.plan.reactions).toEqual([{ target: h.msgAlias, type: "love" }]);
    expect(out.llmCalls).toBe(1);
    expect(out.iterations).toBe(0);
    expect(out.costUsd).toBeCloseTo(0.001);
    const r = requests[0];
    expect(r.route).toBe("chat");
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.outputFormat).toBe(REPLY_FORMAT);
    expect(r.autoCacheTail).toBe(true);
    expect(r.historyBreakpointIndex).toBe(0);
    expect(r.toolChoice).toBeUndefined();
    expect(r.system).toBe("STATIC SYSTEM PROMPT");
    expect(r.log).toEqual({ userId: U, runId: RUN, iteration: 0 });
  });

  it("(2) tool_use → executes every tool; all results in ONE user message, in tool_use order", async () => {
    const h = harness();
    const a = toolUse("get_a", {});
    const b = toolUse("get_b", { q: "x" });
    const { call, requests } = fakeCall([resp([a, b]), final(["done"])]);
    const { d } = deps(call, [okTool("get_a", "A-data"), okTool("get_b", { z: 2, a: 1 })]);
    const out = await runLoop(h.ctx, h.built, d, HAIKU);
    expect(out.end).toBe("final");
    expect(events.sort()).toEqual(["get_a", "get_b"]);
    const results = toolResults(requests[1]);
    expect(results.map((r) => r.tool_use_id)).toEqual([a.id, b.id]);
    expect(results[0].content).toBe("A-data");
    expect(results[1].content).toBe('{"a":1,"z":2}'); // sorted keys
    expect(results.every((r) => r.is_error === undefined)).toBe(true);
    expect(requests[1].messages).toHaveLength(h.built.messages.length + 2);
    expect(out.iterations).toBe(1);
    expect(out.toolCalls.map((t) => [t.name, t.iteration, t.ok])).toEqual(
      expect.arrayContaining([
        ["get_a", 1, true],
        ["get_b", 1, true],
      ]),
    );
  });

  it("(3) append-only: each request extends the previous one; thinking blocks pass through verbatim", async () => {
    const h = harness();
    const th1 = thinking("", "sig-empty-1"); // empty thinking text still round-trips
    const th2 = thinking("considering the agenda", "sig-2");
    const first = resp([th1, toolUse("get_a", {})]);
    const second = resp([th2, text("let me check"), toolUse("get_b", {})]);
    const { call, requests, snapshots } = fakeCall([first, second, final(["ok"])]);
    const { d } = deps(call, [okTool("get_a"), okTool("get_b")]);
    const original = JSON.stringify(h.built.messages);
    await runLoop(h.ctx, h.built, d, HAIKU);

    expect(requests).toHaveLength(3);
    for (let i = 1; i < snapshots.length; i++) {
      const prev = JSON.parse(snapshots[i - 1]) as unknown[];
      const cur = JSON.parse(snapshots[i]) as unknown[];
      expect(cur.length).toBeGreaterThan(prev.length);
      expect(cur.slice(0, prev.length)).toEqual(prev);
    }
    // Earlier request objects were never mutated afterwards.
    requests.forEach((r, i) => expect(JSON.stringify(r.messages)).toBe(snapshots[i]));
    // Context messages untouched.
    expect(JSON.stringify(h.built.messages)).toBe(original);
    // Assistant turns are the response content, verbatim (same objects, same order).
    const m = requests[2].messages;
    const n = h.built.messages.length;
    expect(m[n]).toEqual({ role: "assistant", content: first.content });
    expect(m[n].content).toBe(first.content);
    expect(m[n + 2]).toEqual({ role: "assistant", content: second.content });
    expect((m[n + 2].content as Anthropic.ContentBlockParam[])[0]).toBe(th2);
  });

  it("(4) after MAX_TOOL_ITERATIONS (6) the next call is forced with tool_choice none", async () => {
    const h = harness();
    const script: LlmResponse[] = [];
    for (let i = 0; i < 6; i++) script.push(resp([toolUse("get_a", { q: `q${i}` })]));
    // The forced response even tries a tool (ignored): only its text counts.
    script.push(resp([text(planJson(["here's what i found"])), toolUse("get_a", { q: "again" })], "end_turn"));
    const { call, requests } = fakeCall(script);
    const { d } = deps(call, [okTool("get_a")]);
    const out = await runLoop(h.ctx, h.built, d, HAIKU);
    expect(requests).toHaveLength(7);
    requests.slice(0, 6).forEach((r) => expect(r.toolChoice).toBeUndefined());
    expect(requests[6].toolChoice).toEqual({ type: "none" });
    const note = lastUserBlocks(requests[6]).find((b) => b.type === "text");
    expect(note && note.type === "text" && note.text).toMatch(/Tool limit reached/);
    expect(events).toHaveLength(6);
    expect(out.end).toBe("forced_limit");
    expect(out.iterations).toBe(6);
    expect(out.plan.bubbles).toEqual(["here's what i found"]);
  });

  it("(5) send_interim runs before the other tools of the same response", async () => {
    const h = harness();
    const slow = toolUse("search_slow", {});
    const interim = toolUse("send_interim", { text: "give me a sec 👀" });
    const { call, requests } = fakeCall([resp([slow, interim]), final(["found it"])]);
    const { d } = deps(call, [okTool("search_slow"), interimTool]);
    await runLoop(h.ctx, h.built, d, HAIKU);
    expect(events).toEqual(["send_interim", "search_slow"]);
    expect(h.interimSent).toEqual(["give me a sec 👀"]);
    expect(h.ctx.interim.sent).toBe(true);
    expect(toolResults(requests[1]).map((r) => r.tool_use_id)).toEqual([slow.id, interim.id]);
  });

  describe("(6) tool failures and mid-run escalation", () => {
    it("a throwing tool becomes an is_error result (no message text leaked)", async () => {
      const h = harness();
      const { call, requests } = fakeCall([resp([toolUse("explode", {})]), final(["sorry"])]);
      const { d } = deps(call, [throwingTool]);
      const out = await runLoop(h.ctx, h.built, d, HAIKU);
      const [r] = toolResults(requests[1]);
      expect(r.is_error).toBe(true);
      expect(r.content).toBe("tool failed (Error); retryable=false");
      expect(out.toolCalls).toEqual([{ name: "explode", iteration: 1, ok: false, ms: expect.any(Number) }]);
    });

    it("2 failing iterations → claimEscalation; granted → later calls use Sonnet on the escalate route", async () => {
      const h = harness();
      const { call, requests } = fakeCall([resp([toolUse("explode", { q: "1" })]), resp([toolUse("explode", { q: "2" })]), final(["ok"])]);
      const { d, claims } = deps(call, [throwingTool], async () => true);
      const out = await runLoop(h.ctx, h.built, d, HAIKU);
      expect(claims).toEqual(["tool_failures"]);
      expect(requests.map((r) => [r.route, r.model])).toEqual([
        ["chat", "claude-haiku-5-5"],
        ["chat", "claude-haiku-5-5"],
        ["escalate", "claude-sonnet-5-5"],
      ]);
      expect(out).toMatchObject({ escalated: true, escalationReason: "tool_failures", model: "claude-sonnet-5-5", end: "final" });
    });

    it("denied → stays on Haiku, claims once, and 3 failed iterations force a final answer", async () => {
      const h = harness();
      const { call, requests } = fakeCall([
        resp([toolUse("explode", { q: "1" })]),
        resp([toolUse("explode", { q: "2" })]),
        resp([toolUse("explode", { q: "3" })]),
        final(["i'm having trouble with that one"]),
      ]);
      const { d, claims } = deps(call, [throwingTool], async () => false);
      const out = await runLoop(h.ctx, h.built, d, HAIKU);
      expect(claims).toEqual(["tool_failures"]);
      expect(requests.every((r) => r.model === "claude-haiku-5-5" && r.route === "chat")).toBe(true);
      expect(requests[3].toolChoice).toEqual({ type: "none" });
      expect(out).toMatchObject({ escalated: false, end: "forced_failures" });
    });

    it("the same tool with the same args twice escalates", async () => {
      const h = harness();
      const { call } = fakeCall([resp([toolUse("get_a", { q: "same" })]), resp([toolUse("get_a", { q: "same" })]), final(["ok"])]);
      const { d, claims } = deps(call, [okTool("get_a")], async () => true);
      const out = await runLoop(h.ctx, h.built, d, HAIKU);
      expect(claims).toEqual(["tool_failures"]);
      expect(out.escalated).toBe(true);
    });

    it("a run that started escalated never claims again", async () => {
      const h = harness();
      const { call, requests } = fakeCall([resp([toolUse("explode", { q: "1" })]), resp([toolUse("explode", { q: "2" })]), final(["ok"])]);
      const { d, claims } = deps(call, [throwingTool], async () => true);
      await runLoop(h.ctx, h.built, d, { model: "claude-sonnet-5-5", escalated: true, escalationReason: "frustration" });
      expect(claims).toEqual([]);
      expect(requests.every((r) => r.route === "escalate" && r.model === "claude-sonnet-5-5")).toBe(true);
    });

    it("stub tools (not_implemented) and a second interim don't count as failures", async () => {
      const h = harness({ interimOk: true });
      const stub = tool("stubbed", async () => ({ ok: false, error: "not_implemented" }));
      const { call, requests } = fakeCall([
        resp([toolUse("stubbed", { q: "1" }), toolUse("send_interim", { text: "one sec" })]),
        resp([toolUse("stubbed", { q: "2" }), toolUse("send_interim", { text: "still going" })]),
        final(["can't do that yet"]),
      ]);
      const { d, claims } = deps(call, [stub, interimTool], async () => true);
      await runLoop(h.ctx, h.built, d, HAIKU);
      expect(claims).toEqual([]);
      expect(toolResults(requests[1])[0]).toMatchObject({ is_error: true, content: "not_implemented" });
      expect(toolResults(requests[2])[1]).toMatchObject({ is_error: true, content: "already_sent" });
      expect(h.interimSent).toEqual(["one sec"]);
    });

    it("a tool that hangs past the timeout returns a retryable error", async () => {
      const h = harness();
      const hang = tool("hang", () => new Promise<ToolResult>(() => undefined));
      const { call, requests } = fakeCall([resp([toolUse("hang", {})]), final(["slow today"])]);
      const { d } = deps(call, [hang], undefined, { toolTimeoutMs: 20 });
      await runLoop(h.ctx, h.built, d, HAIKU);
      expect(toolResults(requests[1])[0]).toMatchObject({ is_error: true, content: "tool timed out; retryable=true" });
    });
  });

  it("(7) refusal → canned persona bubble, no retry", async () => {
    const h = harness();
    const refusal: LlmResponse = { ...resp([]), stopReason: "refusal", refusal: { type: "refusal", category: "general_harms", explanation: null } };
    const { call, requests } = fakeCall([refusal]);
    const { d } = deps(call, []);
    const out = await runLoop(h.ctx, h.built, d, HAIKU);
    expect(requests).toHaveLength(1);
    expect(out.end).toBe("refusal");
    expect(out.refusalCategory).toBe("general_harms");
    expect(out.plan.bubbles).toEqual([CANNED.refusal.casual]);
  });

  describe("(8) max_tokens", () => {
    it("cut off mid tool_use → the partial response is dropped and a forced final runs on the same history", async () => {
      const h = harness();
      const cut = resp([thinking("…", "sig"), toolUse("get_a", { q: "partial" })], "max_tokens");
      const { call, requests, snapshots } = fakeCall([cut, final(["short answer"])]);
      const { d } = deps(call, [okTool("get_a")]);
      const out = await runLoop(h.ctx, h.built, d, HAIKU);
      expect(events).toEqual([]); // the truncated tool call never ran
      expect(snapshots[1]).toBe(snapshots[0]); // nothing appended, nothing edited
      expect(requests[1].toolChoice).toEqual({ type: "none" });
      expect(out.end).toBe("forced_max_tokens");
      expect(out.plan.bubbles).toEqual(["short answer"]);
    });

    it("cut off in the final JSON → complete bubbles are salvaged", async () => {
      const h = harness();
      const cut = resp([text('{"reactions":[],"bubbles":["first bubble","second bub')], "max_tokens");
      const { call } = fakeCall([cut]);
      const { d } = deps(call, []);
      const out = await runLoop(h.ctx, h.built, d, HAIKU);
      expect(out.end).toBe("partial");
      expect(out.plan.bubbles).toEqual(["first bubble"]);
    });

    it("unsalvageable → canned bubble", async () => {
      const h = harness();
      const { call } = fakeCall([resp([text('{"reactions":[{"tar')], "max_tokens")]);
      const { d } = deps(call, []);
      const out = await runLoop(h.ctx, h.built, d, HAIKU);
      expect(out.end).toBe("unparseable");
      expect(out.plan.bubbles).toEqual([CANNED.trouble.casual]);
    });
  });

  it("(9) zod-invalid input → is_error listing the issues; the tool never runs", async () => {
    const h = harness();
    const { call, requests } = fakeCall([resp([toolUse("mark_item", { item: "nope", extra: 1 })]), final(["hm"])]);
    const { d } = deps(call, [markTool]);
    await runLoop(h.ctx, h.built, d, HAIKU);
    const [r] = toolResults(requests[1]);
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toMatch(/^invalid input: /);
    expect(String(r.content)).toMatch(/item/);
    expect(events).toEqual([]);
  });

  it("(10) an alias not shown in this run → is_error; shown aliases resolve and run", async () => {
    const h = harness();
    const bad = toolUse("mark_item", { item: "t_deadbeef", evidence: h.msgAlias });
    const good = toolUse("mark_item", { item: h.itemAlias, evidence: h.msgAlias });
    const { call, requests } = fakeCall([resp([bad, good]), final(["done ✅"])]);
    const { d } = deps(call, [markTool]);
    await runLoop(h.ctx, h.built, d, HAIKU);
    const [r1, r2] = toolResults(requests[1]);
    expect(r1).toMatchObject({ is_error: true, content: "unknown id t_deadbeef; use an id from context or a tool result" });
    expect(r2.is_error).toBeUndefined();
    expect(events).toEqual([`mark:${ITEM_ID}`]);
  });

  it("unknown tool names become is_error results", async () => {
    const h = harness();
    const { call, requests } = fakeCall([resp([toolUse("react", {})]), final(["ok"])]);
    const { d } = deps(call, []);
    await runLoop(h.ctx, h.built, d, HAIKU);
    expect(toolResults(requests[1])[0]).toMatchObject({ is_error: true, content: 'unknown tool "react"' });
  });

  it("mutators run one at a time; reads run concurrently", async () => {
    const h = harness();
    let active = 0;
    let maxActiveMutators = 0;
    const slowMut = (name: string) =>
      tool(
        name,
        async () => {
          active++;
          maxActiveMutators = Math.max(maxActiveMutators, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          events.push(name);
          return { ok: true, data: "ok" };
        },
        { mutates: true },
      );
    const { call } = fakeCall([resp([toolUse("mut_a", {}), toolUse("read_x", {}), toolUse("mut_b", {})]), final(["ok"])]);
    const { d } = deps(call, [slowMut("mut_a"), slowMut("mut_b"), okTool("read_x")]);
    await runLoop(h.ctx, h.built, d, HAIKU);
    expect(maxActiveMutators).toBe(1);
    expect(events.indexOf("mut_a")).toBeLessThan(events.indexOf("mut_b"));
  });

  it("untrusted-output tools taint the run", async () => {
    const h = harness();
    const agenda = tool("get_agenda", async () => ({ ok: true, data: "<untrusted source=\"canvas\">…</untrusted>" }), { untrustedOutput: true });
    const { call } = fakeCall([resp([toolUse("get_agenda", {})]), final(["here"])]);
    const { d } = deps(call, [agenda]);
    expect(h.ctx.taint.tainted).toBe(false);
    await runLoop(h.ctx, h.built, d, HAIKU);
    expect(h.ctx.taint.tainted).toBe(true);
  });

  it("LlmUnavailableError propagates with partial stats in the caller's accumulator", async () => {
    const h = harness();
    const { call } = fakeCall([resp([toolUse("get_a", {})]), new LlmUnavailableError("anthropic unavailable (529)", { status: 529 })]);
    const { d } = deps(call, [okTool("get_a")]);
    const stats = newLoopStats(HAIKU);
    await expect(runLoop(h.ctx, h.built, d, HAIKU, stats)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(stats).toMatchObject({ llmCalls: 1, iterations: 1 });
    expect(stats.toolCalls).toHaveLength(1);
  });

  it("an aborted run signal stops the loop before the next call", async () => {
    const ac = new AbortController();
    const h = harness({ signal: ac.signal });
    const abortingTool = tool("get_a", async () => {
      ac.abort(new Error("lease lost"));
      return { ok: true, data: "x" };
    });
    const { call, requests } = fakeCall([resp([toolUse("get_a", {})]), final(["never"])]);
    const { d } = deps(call, [abortingTool]);
    await expect(runLoop(h.ctx, h.built, d, HAIKU)).rejects.toThrow("lease lost");
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- pure helpers

describe("loop helpers", () => {
  it("lenientParsePlan: strict, fenced, partial, garbage", () => {
    expect(lenientParsePlan(planJson(["a"]))?.bubbles).toEqual(["a"]);
    expect(lenientParsePlan("```json\n" + planJson(["b"]) + "\n```")?.bubbles).toEqual(["b"]);
    expect(lenientParsePlan('{"bubbles": ["x \\"quoted\\"", "y"')?.bubbles).toEqual(['x "quoted"', "y"]);
    expect(lenientParsePlan("sure thing")).toBeNull();
    expect(lenientParsePlan('{"bubbles": [')).toBeNull();
  });

  it("stableStringify sorts keys at every level; serializeToolData caps length", () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
    const big = serializeToolData("x".repeat(7000));
    expect(big.length).toBe(6000);
    expect(big.endsWith("…[truncated]")).toBe(true);
  });

  it("unknownAliases finds unshown alias-shaped strings (attachments by base alias)", () => {
    const shown = new Set(["m_1a2b3c4d", "t_5e6f7a8b"]);
    const has = (a: string) => shown.has(a);
    expect(unknownAliases({ a: "m_1a2b3c4d:0", b: ["t_5e6f7a8b", "t_00000000"], c: { d: "e_12345678" }, e: "L1", f: "plain" }, has)).toEqual([
      "t_00000000",
      "e_12345678",
    ]);
  });

  it("link slots hand out stable handles", () => {
    const l = createLinkSlots();
    expect(l.add("https://a.example/m/1")).toBe("L1");
    expect(l.add("https://a.example/m/2")).toBe("L2");
    expect(l.add("https://a.example/m/1")).toBe("L1");
    expect(l.resolve("L2")).toBe("https://a.example/m/2");
    expect(l.resolve("L3")).toBeNull();
    expect(l.resolve("https://evil")).toBeNull();
  });

  it("interim sends at most once and only flips `sent` on success", async () => {
    const sent: string[] = [];
    let ok = false;
    const i = createInterim(async (t) => {
      sent.push(t);
      return ok;
    });
    expect(await i.send("a")).toBe(false);
    expect(i.sent).toBe(false);
    ok = true;
    expect(await i.send("b")).toBe(true);
    expect(await i.send("c")).toBe(false);
    expect(sent).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------- runAgentTurn orchestration

function turnInput(over: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    userId: U,
    runId: RUN,
    now: NOW,
    timezone: "America/New_York",
    channel: CHANNEL,
    identity: { isNewUser: false, name: "Dan", timezone: "America/New_York", timezoneSource: "signup" },
    trigger: { kind: "inbound" },
    newMessages: [{ id: MSG_ID, body: "what's due tmrw", media: [], replyToMessageId: null, createdAt: NOW }],
    inboundReactions: [],
    isFollowUpPass: false,
    welcomeSent: false,
    isEval: false,
    signal: new AbortController().signal,
    interim: async () => true,
    ...over,
  };
}

function builtCtx(over: Partial<BuiltContext> = {}): BuiltContext {
  const aliases = new AliasTable();
  const m = aliases.mint("m", MSG_ID);
  return {
    system: "SYS",
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: `<new_messages>[${m}] what's due tmrw</new_messages>` }] }],
    historyBreakpointIndex: 0,
    aliases,
    evidence: new Set([m]),
    userMessageAliases: new Set([m]),
    lastInbound: m,
    userText: "what's due tmrw",
    register: REGISTER,
    tone: "mirror",
    signals: { newTexts: ["what's due tmrw"], recentUserTexts: [], recentRuns: [] },
    openQuestion: false,
    pendingCount: 0,
    lastAriaAskedQuestion: false,
    ack: null,
    needsSummary: false,
    ...over,
  };
}

function agentDeps(built: BuiltContext, call: AgentDeps["call"], over: Partial<AgentDeps> = {}) {
  const log: string[] = [];
  const patches: RunStatsPatch[] = [];
  const followups: FollowupJobs[] = [];
  let t = 1000;
  const d: AgentDeps = {
    buildContext: async () => built,
    call: async (req) => {
      log.push(`call:${req.route}:${req.model}`);
      return call(req);
    },
    tools: [],
    updateRunStats: async (runId, patch) => {
      expect(runId).toBe(RUN);
      log.push(`stats:${Object.keys(patch).sort().join(",")}${patch.model !== undefined ? `=${patch.model}` : ""}`);
      patches.push(patch);
      return true;
    },
    claimEscalation: async (runId, reason) => {
      log.push(`claim:${reason}`);
      return false;
    },
    enqueueFollowups: async (userId, jobs) => {
      expect(userId).toBe(U);
      followups.push(jobs);
    },
    now: () => (t += 50),
    ...over,
  };
  return { d, log, patches, followups };
}

describe("runAgentTurnWith", () => {
  it("ack fast path: tapback plan, no LLM call, model null, memory_extract still enqueued", async () => {
    const built = builtCtx({ ack: "like" });
    const { call, requests } = fakeCall([]);
    const { d, patches, followups } = agentDeps(built, call);
    const r = await runAgentTurnWith(turnInput(), d);
    expect(requests).toHaveLength(0);
    expect(r).toEqual({
      plan: { bubbles: [], reactions: [{ targetMessageId: MSG_ID, type: "like" }] },
      model: null,
      escalated: false,
      interimSent: false,
      costUsd: 0,
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ model: null, llmCallCount: 0, iterations: 0, costUsd: 0, plan: r.plan });
    expect(followups).toEqual([{ memoryExtract: true, conversationSummary: false }]);
  });

  it("writes model before the first call, then the final stats + resolved plan", async () => {
    const built = builtCtx({ needsSummary: true });
    const { call } = fakeCall([final(["nothing due tmrw 🎉"], { reply_to: built.lastInbound })]);
    const { d, log, patches, followups } = agentDeps(built, call);
    const r = await runAgentTurnWith(turnInput(), d);
    expect(log[0]).toBe("stats:model=claude-haiku-5-5");
    expect(log[1]).toBe("call:chat:claude-haiku-5-5");
    expect(r.plan).toEqual({ bubbles: [{ text: "nothing due tmrw 🎉", replyToMessageId: MSG_ID }] });
    expect(r).toMatchObject({ model: "claude-haiku-5-5", escalated: false, interimSent: false });
    expect(r.costUsd).toBeCloseTo(0.001);
    const last = patches[patches.length - 1];
    expect(last).toMatchObject({ model: "claude-haiku-5-5", llmCallCount: 1, iterations: 0, escalated: false, plan: r.plan });
    expect(last.latencyMs).toBeGreaterThan(0);
    expect(followups).toEqual([{ memoryExtract: true, conversationSummary: true }]);
  });

  it("pre-run escalation: model recorded, then claimed, then Sonnet for the whole run", async () => {
    const built = builtCtx({ signals: { newTexts: ["wtf that's wrong"], recentUserTexts: [], recentRuns: [] } });
    const { call } = fakeCall([final(["my bad, fixing it"])]);
    const { d, log } = agentDeps(built, call, {
      claimEscalation: async (_runId, reason) => {
        log.push(`claim:${reason}`);
        return true;
      },
    });
    const r = await runAgentTurnWith(turnInput(), d);
    expect(log.slice(0, 4)).toEqual([
      "stats:model=claude-haiku-5-5",
      "claim:frustration",
      "stats:model=claude-sonnet-5-5",
      "call:escalate:claude-sonnet-5-5",
    ]);
    expect(r).toMatchObject({ model: "claude-sonnet-5-5", escalated: true });
  });

  it("denied pre-run escalation stays on Haiku", async () => {
    const built = builtCtx({ signals: { newTexts: ["wtf"], recentUserTexts: [], recentRuns: [] } });
    const { call } = fakeCall([final(["ok"])]);
    const { d, log } = agentDeps(built, call);
    const r = await runAgentTurnWith(turnInput(), d);
    expect(log).toContain("claim:frustration");
    expect(log).toContain("call:chat:claude-haiku-5-5");
    expect(r.escalated).toBe(false);
  });

  it("mid-run escalation records the Sonnet model after a granted claim", async () => {
    const built = builtCtx();
    const { call } = fakeCall([resp([toolUse("explode", { q: "1" })]), resp([toolUse("explode", { q: "2" })]), final(["ok"])]);
    const { d, log, patches } = agentDeps(built, call, {
      tools: [throwingTool],
      claimEscalation: async (_r, reason) => {
        log.push(`claim:${reason}`);
        return true;
      },
    });
    const r = await runAgentTurnWith(turnInput(), d);
    const i = log.indexOf("claim:tool_failures");
    expect(log[i + 1]).toBe("stats:model=claude-sonnet-5-5");
    expect(log[i + 2]).toBe("call:escalate:claude-sonnet-5-5");
    expect(r).toMatchObject({ escalated: true, model: "claude-sonnet-5-5" });
    expect(patches[patches.length - 1]).toMatchObject({ escalated: true, escalationReason: "tool_failures", llmCallCount: 3, iterations: 2 });
    expect(patches[patches.length - 1].toolCalls).toHaveLength(2);
  });

  it("send_interim through the tool context is reported as interimSent", async () => {
    const built = builtCtx();
    const sent: string[] = [];
    const { call } = fakeCall([resp([toolUse("send_interim", { text: "one sec" })]), final(["here"])]);
    const { d } = agentDeps(built, call, { tools: [interimTool] });
    const r = await runAgentTurnWith(
      turnInput({
        interim: async (t) => {
          sent.push(t);
          return true;
        },
      }),
      d,
    );
    expect(sent).toEqual(["one sec"]);
    expect(r.interimSent).toBe(true);
  });

  it("LLM unavailability → AgentUnavailableError (retryable), partial stats written, no follow-ups", async () => {
    const built = builtCtx();
    const { call } = fakeCall([new LlmUnavailableError("anthropic unavailable (529)", { status: 529 })]);
    const { d, patches, followups } = agentDeps(built, call);
    const err = await runAgentTurnWith(turnInput(), d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentUnavailableError);
    expect((err as AgentUnavailableError).retryable).toBe(true);
    expect(patches[patches.length - 1]).toMatchObject({ llmCallCount: 0, model: "claude-haiku-5-5" });
    expect(patches[patches.length - 1].plan).toBeUndefined();
    expect(followups).toEqual([]);
  });

  it("other errors propagate unchanged", async () => {
    const built = builtCtx();
    const { call } = fakeCall([new Error("bad request")]);
    const { d } = agentDeps(built, call);
    await expect(runAgentTurnWith(turnInput(), d)).rejects.toThrow("bad request");
  });

  it("proactive runs: no memory_extract (no user-authored text), the model still runs", async () => {
    const built = builtCtx({ evidence: new Set(), lastInbound: null, signals: { newTexts: [], recentUserTexts: [], recentRuns: [] } });
    const input = turnInput({ trigger: { kind: "proactive", reason: "deadline_change", event: "<untrusted …/>" }, newMessages: [] });
    expect(followupsFor(input, built)).toEqual({ memoryExtract: false, conversationSummary: false });
    const { call } = fakeCall([final(["heads up: econ pset moved to fri"])]);
    const { d, followups } = agentDeps(built, call);
    const r = await runAgentTurnWith(input, d);
    expect(r.plan.bubbles).toEqual([{ text: "heads up: econ pset moved to fri" }]);
    expect(followups).toEqual([{ memoryExtract: false, conversationSummary: false }]);
  });
});
