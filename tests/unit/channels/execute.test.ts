/**
 * channels/execute.ts — with a fake provider and fake sleep: idempotent skip, inline-reply
 * retry, reaction disabling + fallback, abort, no resend on timeout, declined stops later sends.
 */
import { executeSteps, REPLY_REJECTED, type ExecuteIo } from "@/server/channels/execute";
import { renderPlan, type RenderStep, type SendStep } from "@/server/channels/render";
import type {
  ChannelCapabilities,
  ChannelProvider,
  OutboundTarget,
  ReactionType,
  SendInput,
  SendResult,
} from "@/server/channels/types";

const TARGET: OutboundTarget = { handle: "+15550100001", line: "+15550109999", service: "imessage" };
const CAPS: ChannelCapabilities = { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 };

interface FakeOpts {
  send?: (input: SendInput, n: number) => SendResult;
  react?: (n: number) => { ok: boolean; disable?: boolean };
}

function fakeProvider(o: FakeOpts = {}) {
  const sends: SendInput[] = [];
  const reacts: { id: string; reaction: ReactionType }[] = [];
  const typing: string[] = [];
  let reactionsOn = true;
  const provider: ChannelProvider = {
    name: "dev",
    capabilities: () => ({ ...CAPS, reactions: reactionsOn }),
    async send(_to, input) {
      sends.push(input);
      return o.send ? o.send(input, sends.length) : { providerMessageId: `p${sends.length}`, status: "sent" };
    },
    async react(_to, id, reaction) {
      reacts.push({ id, reaction });
      const r = o.react ? o.react(reacts.length) : { ok: true };
      if (r.disable) reactionsOn = false;
      return r.ok;
    },
    async typing(_to, state) {
      typing.push(state);
    },
    parseWebhook: () => ({ ok: false, status: 401 }),
  };
  return { provider, sends, reacts, typing };
}

function fakeIo(provider: ChannelProvider, over: Partial<ExecuteIo> = {}) {
  const rows: { step: SendStep; id: string }[] = [];
  const results = new Map<string, SendResult>();
  const recorded: string[] = [];
  const sleeps: number[] = [];
  const existing = new Set<number>();
  const io: ExecuteIo = {
    provider,
    target: TARGET,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    beforeSend: async (step) => {
      if (existing.has(step.bubbleIndex)) return null;
      const id = `row${step.bubbleIndex}`;
      rows.push({ step, id });
      existing.add(step.bubbleIndex);
      return { messageId: id };
    },
    afterSend: async (id, r) => {
      results.set(id, r);
    },
    resolveProviderId: async (id) => `prov-${id}`,
    recordReaction: async (target, reaction) => {
      recorded.push(`${target}:${reaction}`);
    },
    ...over,
  };
  return { io, rows, results, recorded, sleeps, existing };
}

const plan2 = renderPlan({ bubbles: [{ text: "one" }, { text: "two" }] }, CAPS, { elapsedMs: 0, snippets: {} });

describe("executeSteps", () => {
  it("runs typing, pause and sends in order and records results", async () => {
    const f = fakeProvider();
    const { io, results, sleeps } = fakeIo(f.provider);
    const r = await executeSteps(plan2, io);
    expect(f.sends.map((s) => s.text)).toEqual(["one", "two"]);
    expect(f.typing).toEqual(["start", "start"]);
    expect(sleeps).toEqual([800, 800]);
    expect(r).toMatchObject({ sent: 2, failed: 0, skipped: 0, aborted: false, messageIds: ["row0", "row1"] });
    expect(results.get("row1")).toEqual({ providerMessageId: "p2", status: "sent" });
  });

  it("skips a step whose idempotency key already exists (beforeSend → null)", async () => {
    const f = fakeProvider();
    const { io, existing } = fakeIo(f.provider);
    existing.add(0);
    const r = await executeSteps(plan2, io);
    expect(f.sends.map((s) => s.text)).toEqual(["two"]);
    expect(r.skipped).toBe(1);
    expect(r.sent).toBe(1);
  });

  it("a re-run after a full send sends nothing twice", async () => {
    const f = fakeProvider();
    const { io } = fakeIo(f.provider);
    await executeSteps(plan2, io);
    const again = await executeSteps(plan2, io);
    expect(f.sends).toHaveLength(2);
    expect(again.skipped).toBe(2);
  });

  it("inline reply rejected → resent once without reply_to, on the same row", async () => {
    const f = fakeProvider({
      send: (input, n) =>
        input.replyToProviderId
          ? { providerMessageId: null, status: "failed", errorKey: REPLY_REJECTED }
          : { providerMessageId: `p${n}`, status: "sent" },
    });
    const { io, rows, results } = fakeIo(f.provider);
    const steps = renderPlan({ bubbles: [{ text: "yes", replyToMessageId: "in1" }] }, CAPS, { elapsedMs: 0, snippets: {} });
    const r = await executeSteps(steps, io);
    expect(f.sends).toEqual([{ text: "yes", replyToProviderId: "prov-in1" }, { text: "yes" }]);
    expect(rows).toHaveLength(1);
    expect(results.get("row0")?.status).toBe("sent");
    expect(r.sent).toBe(1);
  });

  it("other failures on an inline reply are not retried", async () => {
    const f = fakeProvider({ send: () => ({ providerMessageId: null, status: "failed", errorKey: "http_500" }) });
    const { io } = fakeIo(f.provider);
    const steps = renderPlan({ bubbles: [{ text: "yes", replyToMessageId: "in1" }] }, CAPS, { elapsedMs: 0, snippets: {} });
    const r = await executeSteps(steps, io);
    expect(f.sends).toHaveLength(1);
    expect(r.failed).toBe(1);
  });

  it("no resend on timeout; later bubbles still go", async () => {
    const f = fakeProvider({
      send: (_i, n) => (n === 1 ? { providerMessageId: null, status: "failed", errorKey: "timeout" } : { providerMessageId: "ok", status: "sent" }),
    });
    const { io, results } = fakeIo(f.provider);
    const r = await executeSteps(plan2, io);
    expect(f.sends.map((s) => s.text)).toEqual(["one", "two"]);
    expect(results.get("row0")).toEqual({ providerMessageId: null, status: "failed", errorKey: "timeout" });
    expect(r).toMatchObject({ sent: 1, failed: 1 });
  });

  it("a provider that throws is recorded as failed, not resent", async () => {
    const f = fakeProvider({
      send: () => {
        throw new Error("boom");
      },
    });
    const { io, results } = fakeIo(f.provider);
    const r = await executeSteps(plan2.slice(0, 3), io);
    expect(f.sends).toHaveLength(1);
    expect(results.get("row0")?.status).toBe("failed");
    expect(r.failed).toBe(1);
  });

  it("declined (opted out) stops later sends", async () => {
    const f = fakeProvider({ send: () => ({ providerMessageId: null, status: "declined", errorKey: "OPTED_OUT" }) });
    const { io } = fakeIo(f.provider);
    const r = await executeSteps(plan2, io);
    expect(f.sends).toHaveLength(1);
    expect(r.declined).toBe("OPTED_OUT");
  });

  it("reaction sent → recorded", async () => {
    const f = fakeProvider();
    const { io, recorded } = fakeIo(f.provider);
    const steps = renderPlan({ bubbles: [], reactions: [{ targetMessageId: "in1", type: "love" }] }, CAPS, { elapsedMs: 0, snippets: {} });
    const r = await executeSteps(steps, io);
    expect(f.reacts).toEqual([{ id: "prov-in1", reaction: "love" }]);
    expect(recorded).toEqual(["in1:love"]);
    expect(f.typing).toEqual(["stop"]);
    expect(r.reactionsSent).toBe(1);
  });

  it("reaction 422 unsupported_on_this_line disables reactions afterward; fallbackText is sent instead", async () => {
    const f = fakeProvider({ react: () => ({ ok: false, disable: true }) });
    const { io } = fakeIo(f.provider);
    const steps = renderPlan(
      {
        bubbles: [{ text: "done" }],
        reactions: [
          { targetMessageId: "in1", type: "love" },
          { targetMessageId: "in2", type: "like", fallbackText: "👍" },
        ],
      },
      CAPS,
      { elapsedMs: 0, snippets: {} },
    );
    const r = await executeSteps(steps, io);
    expect(f.reacts).toHaveLength(1); // the second reaction never hits the provider
    expect(f.sends.map((s) => s.text)).toEqual(["👍", "done"]);
    expect(r).toMatchObject({ reactionsSent: 0, reactionsFailed: 2, sent: 2 });
  });

  it("a one-off reaction failure doesn't send the fallback text", async () => {
    const f = fakeProvider({ react: () => ({ ok: false }) });
    const { io } = fakeIo(f.provider);
    const steps = renderPlan(
      { bubbles: [], reactions: [{ targetMessageId: "in1", type: "like", fallbackText: "👍" }] },
      CAPS,
      { elapsedMs: 0, snippets: {} },
    );
    await executeSteps(steps, io);
    expect(f.sends).toHaveLength(0);
  });

  it("an unknown reaction target is skipped without calling the provider", async () => {
    const f = fakeProvider();
    const { io } = fakeIo(f.provider, { resolveProviderId: async () => null });
    const steps: RenderStep[] = [{ t: "react", targetMessageId: "gone", reaction: "like", bubbleIndex: 0 }];
    const r = await executeSteps(steps, io);
    expect(f.reacts).toHaveLength(0);
    expect(r.reactionsFailed).toBe(1);
  });

  it("abort signal stops later sends (checked after each pause)", async () => {
    const f = fakeProvider();
    const controller = new AbortController();
    const { io } = fakeIo(f.provider, {
      signal: controller.signal,
      sleep: async () => {
        if (f.sends.length === 1) controller.abort();
      },
    });
    const r = await executeSteps(plan2, io);
    expect(f.sends.map((s) => s.text)).toEqual(["one"]);
    expect(r.aborted).toBe(true);
  });

  it("already-aborted signal sends nothing", async () => {
    const f = fakeProvider();
    const controller = new AbortController();
    controller.abort();
    const { io } = fakeIo(f.provider, { signal: controller.signal });
    const r = await executeSteps(plan2, io);
    expect(f.sends).toHaveLength(0);
    expect(f.typing).toHaveLength(0);
    expect(r.aborted).toBe(true);
  });

  it("typing errors are swallowed", async () => {
    const f = fakeProvider();
    f.provider.typing = async () => {
      throw new Error("503");
    };
    const { io } = fakeIo(f.provider);
    const r = await executeSteps(plan2, io);
    expect(r.sent).toBe(2);
  });
});
