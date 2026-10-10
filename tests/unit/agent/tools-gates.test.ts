/**
 * Task 3.3 tools — the gates that run before any DB access: evidence rule (master plan §1.0.5:
 * user-authored m_/x_ alias of this run's batch; proactive runs fail closed), alias resolution
 * (only aliases shown in this run resolve), send_interim rules, frozen schema flags.
 */
import { AliasTable } from "@/server/agent/context/aliases";
import type { AgentTool } from "@/server/agent/tools/define";
import { cancelActionTool, runCancelAction } from "@/server/agent/tools/cancel-action";
import { confirmActionTool, runConfirmAction } from "@/server/agent/tools/confirm-action";
import { confirmPreferenceTool, runConfirmPreference } from "@/server/agent/tools/confirm-preference";
import { forgetTool, resolveForgetItems, runForget } from "@/server/agent/tools/forget";
import { getAgendaTool } from "@/server/agent/tools/get-agenda";
import { listMemoryTool } from "@/server/agent/tools/list-memory";
import { markDoneTool, runMarkDone } from "@/server/agent/tools/mark-done";
import { pauseTool, runPause } from "@/server/agent/tools/pause";
import { proposePreferenceTool, runProposePreference } from "@/server/agent/tools/propose-preference";
import { recallTool } from "@/server/agent/tools/recall";
import { requestAccountDeletionTool, runRequestAccountDeletion } from "@/server/agent/tools/request-account-deletion";
import { searchDeadlinesTool } from "@/server/agent/tools/search-deadlines";
import { runSendInterim, sendInterimTool } from "@/server/agent/tools/send-interim";
import { runSendLink, sendLinkTool } from "@/server/agent/tools/send-link";
import { runSignOutEverywhere, signOutEverywhereTool } from "@/server/agent/tools/sign-out-everywhere";
import { runUpdateProfile, updateProfileTool } from "@/server/agent/tools/update-profile";
import type { ToolCtx } from "@/server/agent/types";

const NOW = new Date("2026-10-12T16:00:00Z");
const USER = "00000000-0000-4000-8000-000000000001";
const MSG = "11111111-1111-4111-8111-111111111111";

function ctx(over: Partial<ToolCtx> = {}): ToolCtx & { aliases: AliasTable } {
  const aliases = new AliasTable();
  const ev = aliases.mint("m", MSG);
  return {
    userId: USER,
    runId: "22222222-2222-4222-8222-222222222222",
    now: NOW,
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
    evidence: new Set([ev]),
    userText: "",
    taint: { tainted: false, mark: () => undefined },
    links: { add: () => "L1", resolve: () => null },
    interim: { sent: false, send: async () => true },
    signal: new AbortController().signal,
    log: () => undefined,
    ...over,
  } as ToolCtx & { aliases: AliasTable };
}

const EV = "m_11111111";
const NOT_IN_BATCH = "m_99999999";
const PROACTIVE: ToolCtx["trigger"] = { kind: "proactive", reason: "reminder", event: "" };

/** Every mutating 3.3 tool, with a valid input template (evidence substituted per case). */
const MUTATORS: [string, (c: ToolCtx, ev: string) => Promise<{ ok: boolean; error?: string }>][] = [
  ["mark_done", (c, ev) => runMarkDone(c, { item: "t_12345678", status: "done", evidence: ev })],
  ["propose_preference", (c, ev) => runProposePreference(c, { key: "gym.latest", category: "schedule", statement: "no gym after 8pm", explicit: false, constraint: null, evidence: ev })],
  ["confirm_preference", (c, ev) => runConfirmPreference(c, { proposal: "p_12345678", decision: "confirm", evidence: ev })],
  ["forget", (c, ev) => runForget(c, { items: ["f_12345678"], evidence: ev })],
  ["update_profile", (c, ev) => runUpdateProfile(c, { field: "name", value: "Dan", evidence: ev })],
  ["confirm_action", (c, ev) => runConfirmAction(c, { action: "a_12345678", evidence: ev })],
  ["cancel_action", (c, ev) => runCancelAction(c, { action: "a_12345678", evidence: ev })],
  ["pause", (c, ev) => runPause(c, { until: "1h", evidence: ev })],
  ["sign_out_everywhere", (c, ev) => runSignOutEverywhere(c, { evidence: ev })],
  ["request_account_deletion", (c, ev) => runRequestAccountDeletion(c, { evidence: ev })],
];

describe("evidence gate (§1.0.5)", () => {
  it.each(MUTATORS)("%s refuses evidence that isn't in this run's batch", async (_name, run) => {
    const r = await run(ctx(), NOT_IN_BATCH);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/evidence/) });
  });

  it.each(MUTATORS)("%s fails closed on proactive runs (even with a known alias)", async (_name, run) => {
    const r = await run(ctx({ trigger: PROACTIVE }), EV);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/evidence/) });
  });

  it("an x_ tapback from the batch counts as evidence (confirm_preference), then the alias gate applies", async () => {
    const c = ctx();
    const x = c.aliases.mint("x", "33333333-3333-4333-8333-333333333333");
    const r = await runConfirmPreference({ ...c, evidence: new Set([x]) }, { proposal: "p_12345678", decision: "confirm", evidence: x });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/unknown proposal p_12345678/) });
  });
});

describe("aliases: only ids shown in this run resolve (§1.0.4)", () => {
  it("mark_done: unknown t_ alias", async () => {
    expect(await runMarkDone(ctx(), { item: "t_deadbeef", status: "done", evidence: EV })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown item t_deadbeef/) });
  });

  it("confirm_action / cancel_action: unknown a_ alias; a t_ alias with the same hex is a kind mismatch", async () => {
    const c = ctx();
    c.aliases.mint("t", "abcdef01-0000-4000-8000-000000000000");
    expect(await runConfirmAction(c, { action: "a_abcdef01", evidence: EV })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown action/) });
    expect(await runCancelAction(c, { action: "a_abcdef01", evidence: EV })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown action/) });
  });

  it("send_link(email_draft): unknown a_ alias is refused before any DB access", async () => {
    expect(await runSendLink(ctx(), { kind: "email_draft", action: "a_12345678" })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown action/) });
  });

  it("forget: one unknown id → nothing changes", async () => {
    const c = ctx();
    const f = c.aliases.mint("f", "44444444-4444-4444-8444-444444444444");
    const p = c.aliases.mint("p", "55555555-5555-4555-8555-555555555555");
    expect(resolveForgetItems(c, [f, p, f, "f_00000000"])).toEqual({
      facts: ["44444444-4444-4444-8444-444444444444"],
      prefs: ["55555555-5555-4555-8555-555555555555"],
      unknown: ["f_00000000"],
    });
    expect(await runForget(c, { items: [f, "p_00000000"], evidence: EV })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown ids p_00000000/) });
  });

  it("update_profile rejects a non-IANA timezone before writing", async () => {
    expect(await runUpdateProfile(ctx(), { field: "timezone", value: "EST", evidence: EV })).toMatchObject({ ok: false, error: expect.stringMatching(/IANA/) });
    expect(await runUpdateProfile(ctx(), { field: "timezone", value: "Mars/Olympus", evidence: EV })).toMatchObject({ ok: false });
  });
});

describe("send_interim", () => {
  it("is refused on proactive runs", async () => {
    expect((await runSendInterim(ctx({ trigger: PROACTIVE }), { text: "sec" })).ok).toBe(false);
  });

  it("sends once; reports already_sent when the watchdog/tool already sent one", async () => {
    const sent: string[] = [];
    let flag = false;
    const c = ctx({
      interim: {
        get sent() {
          return flag;
        },
        send: async (t: string) => {
          if (flag) return false;
          flag = true;
          sent.push(t);
          return true;
        },
      },
    });
    expect(await runSendInterim(c, { text: "  give me a sec 👀 " })).toEqual({ ok: true, data: "ok: sent" });
    expect(await runSendInterim(c, { text: "again" })).toMatchObject({ ok: true, data: expect.stringMatching(/^already_sent/) });
    expect(sent).toEqual(["give me a sec 👀"]);
  });
});

describe("frozen §1.4 shapes and flags", () => {
  const byName = (t: AgentTool) => t.spec.name;
  const tools: AgentTool[] = [
    sendInterimTool,
    sendLinkTool,
    getAgendaTool,
    searchDeadlinesTool,
    markDoneTool,
    recallTool,
    listMemoryTool,
    proposePreferenceTool,
    confirmPreferenceTool,
    forgetTool,
    updateProfileTool,
    confirmActionTool,
    cancelActionTool,
    pauseTool,
    signOutEverywhereTool,
    requestAccountDeletionTool,
  ];

  it("mutating tools take evidence; read tools don't", () => {
    const mut = tools.filter((t) => t.spec.mutates).map(byName).sort();
    expect(mut).toEqual(MUTATORS.map(([n]) => n).sort());
    for (const t of tools) {
      const keys = Object.keys(t.spec.input.shape);
      expect(keys.includes("evidence")).toBe(Boolean(t.spec.mutates));
    }
  });

  it("agenda + search are untrustedOutput; update_profile has no briefing_time", () => {
    expect(getAgendaTool.spec.untrustedOutput).toBe(true);
    expect(searchDeadlinesTool.spec.untrustedOutput).toBe(true);
    expect(updateProfileTool.spec.input.safeParse({ field: "briefing_time", value: "08:00", evidence: EV }).success).toBe(false);
  });

  it("aliases are 8–10 hex; raw UUIDs are rejected by the schema", () => {
    expect(markDoneTool.spec.input.safeParse({ item: "t_1234567890", evidence: EV }).success).toBe(true);
    expect(markDoneTool.spec.input.safeParse({ item: "12345678-1111-4111-8111-111111111111", evidence: EV }).success).toBe(false);
    expect(confirmActionTool.spec.input.safeParse({ action: "a_123", evidence: EV }).success).toBe(false);
  });
});
