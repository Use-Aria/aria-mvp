/**
 * `propose_preference` replacing an active rule (5.F1, CR-3): the proposal takes the replaced
 * row's key, so the later confirm supersedes it (decide_preference closes the active row with the
 * same key) instead of leaving two active rules. Memory DB calls are mocked; the policy is real.
 */
import { AliasTable } from "@/server/agent/context/aliases";
import { runProposePreference } from "@/server/agent/tools/propose-preference";
import type { ToolCtx } from "@/server/agent/types";
import type { PreferenceRow } from "@/server/memory";

const mockActive: PreferenceRow[] = [];
const mockInserted: Record<string, unknown>[] = [];
const mockExplicit: Record<string, unknown>[] = [];

jest.mock("@/server/memory", () => {
  const policy = jest.requireActual("@/server/memory/preference-policy");
  const conversation = jest.requireActual("@/server/memory/conversation");
  return {
    decideProposal: policy.decideProposal,
    findReplacedPreference: policy.findReplacedPreference,
    askedInCurrentConversation: conversation.askedInCurrentConversation,
    listActivePreferences: async () => mockActive,
    getOpenQuestion: async () => null,
    insertProposal: async (a: Record<string, unknown>) => {
      mockInserted.push(a);
      return { id: "33333333-3333-4333-8333-333333333333", key: a.key, category: a.category, statement: a.statement, status: a.status, source: null, constraintJson: null, validFrom: new Date() };
    },
    saveExplicitPreference: async (a: Record<string, unknown>) => {
      mockExplicit.push(a);
      return { id: "44444444-4444-4444-8444-444444444444", key: a.key, category: a.category, statement: a.statement, status: "active", source: "explicit", constraintJson: null, validFrom: new Date() };
    },
  };
});
jest.mock("@/server/db", () => ({ db: () => ({}) }));

const MSG = "11111111-1111-4111-8111-111111111111";

function ctx(): ToolCtx {
  const aliases = new AliasTable();
  const ev = aliases.mint("m", MSG);
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    runId: "22222222-2222-4222-8222-222222222222",
    now: new Date("2026-10-12T16:00:00Z"),
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
  };
}

const gym = (time: string, applies: string[] = ["gym"]) => ({ applies_to: applies, constraint: { type: "not_after" as const, time }, waking: null, signoff: null });

function active(key: string, statement: string, constraintJson: unknown): PreferenceRow {
  return { id: "55555555-5555-4555-8555-555555555555", key, category: "schedule", statement, status: "active", source: "confirmed", constraintJson, validFrom: new Date() };
}

beforeEach(() => {
  mockActive.length = 0;
  mockInserted.length = 0;
  mockExplicit.length = 0;
});

describe("propose_preference supersede key", () => {
  it("a changed rule saved under another key takes the active row's key and says what it replaces", async () => {
    mockActive.push(active("gym.latest_time", "no gym after 8pm", gym("20:00")));
    const r = await runProposePreference(ctx(), {
      key: "workout.latest_time",
      category: "schedule",
      statement: "no workouts after 9pm",
      explicit: false,
      constraint: gym("21:00", ["workout", "gym"]),
      evidence: "m_11111111",
    });
    expect(r.ok).toBe(true);
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0]).toMatchObject({ key: "gym.latest_time", status: "proposed", statement: "no workouts after 9pm" });
    expect(r.ok && typeof r.data === "object" ? r.data.replaces : null).toBe("no gym after 8pm");
  });

  it("explicit saves supersede the same way", async () => {
    mockActive.push(active("email.signoff", "sign emails Best, Dan", { applies_to: ["email"], constraint: null, waking: null, signoff: "Best,\nDan" }));
    const r = await runProposePreference(ctx(), {
      key: "email.sign_off",
      category: "email",
      statement: "sign emails Cheers, Dan",
      explicit: true,
      constraint: { applies_to: ["email"], constraint: null, waking: null, signoff: "Cheers,\nDan" },
      evidence: "m_11111111",
    });
    expect(r).toEqual({ ok: true, data: 'ok: active (replaces "sign emails Best, Dan")' });
    expect(mockExplicit[0]).toMatchObject({ key: "email.signoff" });
  });

  it("an unrelated rule keeps the model's key and replaces nothing; an identical one is a no-op", async () => {
    mockActive.push(active("gym.latest_time", "no gym after 8pm", gym("20:00")));
    const r = await runProposePreference(ctx(), {
      key: "study.latest_time",
      category: "study",
      statement: "no studying after 11pm",
      explicit: false,
      constraint: { applies_to: ["study"], constraint: { type: "not_after", time: "23:00" }, waking: null, signoff: null },
      evidence: "m_11111111",
    });
    expect(mockInserted[0]).toMatchObject({ key: "study.latest_time" });
    expect(r.ok && typeof r.data === "object" ? r.data.replaces : undefined).toBeUndefined();

    const same = await runProposePreference(ctx(), {
      key: "workout.cutoff",
      category: "schedule",
      statement: "No gym after 8pm",
      explicit: false,
      constraint: gym("20:00"),
      evidence: "m_11111111",
    });
    expect(same).toEqual({ ok: true, data: "ok: already active" });
    expect(mockInserted).toHaveLength(1);
  });
});
