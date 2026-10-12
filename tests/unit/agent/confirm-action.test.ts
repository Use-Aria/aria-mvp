/**
 * `confirm_action` (5.5 review #3 and #4): the chat confirm threads the cited evidence into
 * `confirmPendingAction` (a "yes" received before the draft was shown is refused), and a confirm
 * that finishes after the loop stopped waiting posts its outcome into the chat. The pending-action
 * DB path is mocked at its source module; `evidencePostdatesAction` stays real.
 */
import { AliasTable } from "@/server/agent/context/aliases";
import type { ConfirmOptions, ConfirmResult } from "@/server/agent/pending/actions";
import { CONFIRM_RUNNING, CONFIRM_UNCONFIRMED, confirmErrorMessage, keepAlive, runConfirmAction } from "@/server/agent/tools/confirm-action";
import type { ToolCtx } from "@/server/agent/types";

const mockConfirms: { id: string; o: ConfirmOptions }[] = [];
const mockPosts: { id: string; r: ConfirmResult; reason: string }[] = [];
const mockNext: { result: ConfirmResult; beforeReturn?: () => void; view: { status: string; error: string | null } | null } = {
  result: { ok: true, summary: "Sent your reply to Kim" },
  view: null,
};

// `after()` from next/server: by default it throws like the real one outside a request scope;
// a test swaps in a recorder to see the in-flight confirm registered.
const mockAfter: { calls: unknown[]; inScope: boolean } = { calls: [], inScope: false };
jest.mock("next/server", () => ({
  after: (task: unknown) => {
    if (!mockAfter.inScope) throw new Error("`after` was called outside a request scope.");
    mockAfter.calls.push(task);
  },
}));

// Only what confirm-action.ts uses (+ GOOGLE_DISCONNECTED, read at load by gmail/send.ts through
// the executors import cycle); `evidencePostdatesAction` is loaded for real below.
jest.mock("@/server/agent/pending/actions", () => {
  return {
    GOOGLE_DISCONNECTED: "google_disconnected",
    confirmPendingAction: async (_userId: string, id: string, o: ConfirmOptions) => {
      mockConfirms.push({ id, o });
      mockNext.beforeReturn?.();
      return mockNext.result;
    },
    getPendingAction: async () => mockNext.view,
    isOutcomeUnknown: (e: string) => e === "send_unconfirmed" || e.startsWith("send_unconfirmed:"),
    postConfirmOutcome: async (_userId: string, id: string, r: ConfirmResult, reason: string) => {
      mockPosts.push({ id, r, reason });
    },
  };
});

const { evidencePostdatesAction, isOutcomeUnknown, SEND_UNCONFIRMED_PREFIX } = jest.requireActual<typeof import("@/server/agent/pending/actions")>("@/server/agent/pending/actions");

const U = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const ACTION = "66666666-6666-4666-8666-666666666666";
const MSG = "1a2b3c4d-0000-4000-8000-000000000000";
const REACTION = "7a7b7c7d-0000-4000-8000-000000000000";

function ctxWith(signal: AbortSignal = new AbortController().signal) {
  const aliases = new AliasTable();
  const m = aliases.mint("m", MSG);
  const x = aliases.mint("x", REACTION);
  const a = aliases.mint("a", ACTION);
  const ctx: ToolCtx = {
    userId: U,
    runId: RUN,
    now: new Date("2026-10-11T15:00:00Z"),
    timezone: "America/New_York",
    channel: {
      channelId: "c1",
      provider: "dev",
      kind: "imessage",
      service: "imessage",
      handleKind: "phone",
      capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
      windowOpen: true,
    },
    trigger: { kind: "inbound" },
    aliases,
    evidence: new Set([m, x]),
    userText: "yes send it",
    taint: { tainted: false, mark: () => undefined },
    links: { add: () => "L1", resolve: () => null },
    interim: { sent: false, send: async () => false },
    signal,
    log: () => undefined,
  };
  return { ctx, m, x, a };
}

beforeEach(() => {
  mockConfirms.length = 0;
  mockPosts.length = 0;
  mockNext.result = { ok: true, summary: "Sent your reply to Kim" };
  mockNext.beforeReturn = undefined;
  mockNext.view = null;
  mockAfter.calls.length = 0;
  mockAfter.inScope = false;
});

describe("evidencePostdatesAction (pure)", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 11, 15, 0, s));
  it.each([
    ["a yes sent while the draft was being written (before the row)", t(5), t(10), null, false],
    ["a yes at the same instant as the row", t(10), t(10), null, false],
    ["a yes after the row, no reply recorded", t(11), t(10), null, true],
    ["a yes after the row but before the draft bubble went out", t(12), t(10), t(15), false],
    ["a yes after the draft bubble", t(20), t(10), t(15), true],
    ["evidence not found", null, t(10), null, false],
  ] as const)("%s", (_label, evidenceAt, createdAt, shownAt, ok) => {
    expect(evidencePostdatesAction(evidenceAt, createdAt, shownAt)).toBe(ok);
  });
});

describe("runConfirmAction", () => {
  it("threads the cited message (m_) or tapback (x_) into confirmPendingAction", async () => {
    const { ctx, m, x, a } = ctxWith();
    expect(await runConfirmAction(ctx, { action: a, evidence: m })).toEqual({ ok: true, data: "ok: Sent your reply to Kim" });
    expect(await runConfirmAction(ctx, { action: a, evidence: x })).toMatchObject({ ok: true });
    expect(mockConfirms).toEqual([
      { id: ACTION, o: { via: "chat", runId: RUN, evidence: { kind: "m", id: MSG } } },
      { id: ACTION, o: { via: "chat", runId: RUN, evidence: { kind: "x", id: REACTION } } },
    ]);
    expect(mockPosts).toEqual([]); // the loop was still waiting: the reply carries the outcome
  });

  it("an older 'yes' (refused as same_run) tells the model to ask again", async () => {
    const { ctx, m, a } = ctxWith();
    mockNext.result = { ok: false, code: "same_run" };
    const r = await runConfirmAction(ctx, { action: a, evidence: m });
    expect(r).toEqual({ ok: false, error: confirmErrorMessage("same_run") });
    expect(confirmErrorMessage("same_run")).toMatch(/next message/);
    expect(confirmErrorMessage("same_run")).toMatch(/before they saw it/);
  });

  it("posts the outcome into the chat when the loop stopped waiting (timeout/abort) before the confirm finished", async () => {
    const ac = new AbortController();
    const { ctx, m, a } = ctxWith(ac.signal);
    mockNext.beforeReturn = () => ac.abort();
    await runConfirmAction(ctx, { action: a, evidence: m });
    expect(mockPosts).toEqual([{ id: ACTION, r: { ok: true, summary: "Sent your reply to Kim" }, reason: "action_confirmed_late" }]);

    mockPosts.length = 0;
    const ac2 = new AbortController();
    const c2 = ctxWith(ac2.signal);
    mockNext.result = { ok: false, code: "executor_failed" };
    mockNext.beforeReturn = () => ac2.abort();
    await runConfirmAction(c2.ctx, { action: c2.a, evidence: c2.m });
    expect(mockPosts).toEqual([{ id: ACTION, r: { ok: false, code: "executor_failed" }, reason: "action_confirmed_late" }]);
  });
});

describe("send_unconfirmed (agent A change request)", () => {
  it("the pending module's prefix matches gmail/send's SEND_UNCONFIRMED", () => {
    const { SEND_UNCONFIRMED } = jest.requireActual<typeof import("@/server/integrations/google/gmail/send")>("@/server/integrations/google/gmail/send");
    expect(SEND_UNCONFIRMED_PREFIX).toBe(SEND_UNCONFIRMED);
    expect(isOutcomeUnknown(`${SEND_UNCONFIRMED}:503`)).toBe(true);
    expect(isOutcomeUnknown(SEND_UNCONFIRMED)).toBe(true);
    expect(isOutcomeUnknown("send_rejected:400")).toBe(false);
    expect(isOutcomeUnknown("google_disconnected")).toBe(false);
  });

  it("an unconfirmed send (row left executing) tells the model not to resend and to check the Sent folder", async () => {
    const { ctx, m, a } = ctxWith();
    mockNext.result = { ok: false, code: "not_pending" };
    mockNext.view = { status: "executing", error: "send_unconfirmed:timeout" };
    const r = await runConfirmAction(ctx, { action: a, evidence: m });
    expect(r).toEqual({ ok: true, data: CONFIRM_UNCONFIRMED });
    expect(CONFIRM_UNCONFIRMED).toMatch(/Don't resend/);
    expect(CONFIRM_UNCONFIRMED).toMatch(/Sent folder/);
    expect(CONFIRM_UNCONFIRMED).not.toMatch(/retryable/);
    expect(CONFIRM_UNCONFIRMED).toMatch(/may already have gone out/);
    expect(CONFIRM_UNCONFIRMED).toMatch(/draft page shows the final status/);
    // recovery never posts into the chat, so the model must not promise a later confirmation
    expect(CONFIRM_UNCONFIRMED).not.toMatch(/you'll confirm|will confirm once/i);
  });

  it("a confirm already running elsewhere reads as in progress; a done/cancelled row keeps the old copy", async () => {
    const { ctx, m, a } = ctxWith();
    mockNext.result = { ok: false, code: "not_pending" };
    mockNext.view = { status: "executing", error: null };
    expect(await runConfirmAction(ctx, { action: a, evidence: m })).toEqual({ ok: true, data: CONFIRM_RUNNING });
    mockNext.view = { status: "done", error: null };
    expect(await runConfirmAction(ctx, { action: a, evidence: m })).toEqual({ ok: false, error: confirmErrorMessage("not_pending") });
    mockNext.result = { ok: false, code: "executor_failed" };
    mockNext.view = { status: "failed", error: "send_rejected:400" };
    expect(await runConfirmAction(ctx, { action: a, evidence: m })).toEqual({ ok: false, error: "it failed (send_rejected:400); tell the student it didn't go through" });
  });
});

describe("send_unconfirmed confirm code (Wave 5R follow-up)", () => {
  it("maps to CONFIRM_UNCONFIRMED (not a failure) without reading the row back", async () => {
    const { ctx, m, a } = ctxWith();
    mockNext.result = { ok: false, code: "send_unconfirmed" };
    mockNext.view = { status: "done", error: null }; // would give "already handled" if it were read
    expect(await runConfirmAction(ctx, { action: a, evidence: m })).toEqual({ ok: true, data: CONFIRM_UNCONFIRMED });
    expect(confirmErrorMessage("send_unconfirmed")).toBe(CONFIRM_UNCONFIRMED);
  });

  it("a late unconfirmed send goes to postConfirmOutcome, which posts nothing for it (smoke-checked)", async () => {
    const ac = new AbortController();
    const { ctx, m, a } = ctxWith(ac.signal);
    mockNext.result = { ok: false, code: "send_unconfirmed" };
    mockNext.beforeReturn = () => ac.abort();
    expect(await runConfirmAction(ctx, { action: a, evidence: m })).toEqual({ ok: true, data: CONFIRM_UNCONFIRMED });
    expect(mockPosts).toEqual([{ id: ACTION, r: { ok: false, code: "send_unconfirmed" }, reason: "action_confirmed_late" }]);
  });
});

describe("keepAlive (background confirm survives the end of the request)", () => {
  it("registers the in-flight confirm with after() inside a request scope", async () => {
    mockAfter.inScope = true;
    const { ctx, m, a } = ctxWith();
    const r = await runConfirmAction(ctx, { action: a, evidence: m });
    expect(r).toEqual({ ok: true, data: "ok: Sent your reply to Kim" });
    expect(mockAfter.calls).toHaveLength(1);
    const task = mockAfter.calls[0] as Promise<unknown>;
    expect(typeof task.then).toBe("function");
    await expect(task).resolves.toEqual(r);
  });

  it("is a no-op outside a request scope (Jest, tsx scripts): the confirm still runs", async () => {
    expect(keepAlive(Promise.resolve())).toBe(false);
    const { ctx, m, a } = ctxWith();
    expect(await runConfirmAction(ctx, { action: a, evidence: m })).toMatchObject({ ok: true });
    expect(mockConfirms).toHaveLength(1);
    expect(mockAfter.calls).toHaveLength(0);
  });

  it("the real next/server after() throws outside a request scope (what keepAlive swallows)", () => {
    const real = jest.requireActual<typeof import("next/server")>("next/server");
    expect(() => real.after(Promise.resolve())).toThrow(/outside a request scope/);
  });
});
