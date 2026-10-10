/**
 * Escalation rules (V2-04 §2.6, §10.1 escalation): frustration regex, repetition Jaccard,
 * scheduling counter + constraints, stickiness, mid-run rule, and `budgetAllows` mirroring the
 * `claim_escalation` SQL formula. Pure — no DB.
 */
import type { PreflightSignals, RecentRun } from "@/server/agent/context/build";
import {
  budgetAllows,
  countConstraints,
  escalationCapPct,
  isFrustrated,
  midRunEscalation,
  openNegotiationRuns,
  preflightEscalation,
  tokenJaccard,
} from "@/server/agent/escalation";

const NOW = new Date("2026-10-10T15:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function run(min: number, toolNames: string[], esc: { escalated?: boolean; reason?: string } = {}): RecentRun {
  return { startedAt: ago(min), escalated: esc.escalated ?? false, escalationReason: esc.reason ?? null, toolNames };
}

function signals(over: Partial<PreflightSignals> = {}): PreflightSignals {
  return { newTexts: [], recentUserTexts: [], recentRuns: [], ...over };
}

describe("isFrustrated", () => {
  it.each([
    "that's wrong",
    "thats not what i asked",
    "i already said thursday",
    "I told you no gym after 8",
    "wtf",
    "nooo!!",
    "why?! seriously?!",
    "STOP SCHEDULING THINGS ON FRIDAY",
    "are you even listening",
  ])("hits: %s", (t) => expect(isFrustrated(t)).toBe(true));

  it.each(["what's due tmrw", "no worries", "No.", "OK", "can you move it?", "I'm at YALE NYC", "lol that's funny!", "ECON 115 pset"])(
    "misses: %s",
    (t) => expect(isFrustrated(t)).toBe(false),
  );
});

describe("tokenJaccard / repetition", () => {
  it("computes token-set similarity", () => {
    expect(tokenJaccard("move my gym to thursday", "move my gym to thursday")).toBe(1);
    expect(tokenJaccard("a b c d", "a b x y")).toBeCloseTo(2 / 6);
    expect(tokenJaccard("", "")).toBe(0);
  });

  it("escalates when a new message repeats one from the last 15 minutes", () => {
    const s = signals({
      newTexts: ["can you move my gym block to thursday"],
      recentUserTexts: [{ text: "move my gym block to thursday", at: ago(5) }],
    });
    expect(preflightEscalation(s, NOW)).toBe("repetition");
  });

  it("ignores short or dissimilar messages", () => {
    expect(preflightEscalation(signals({ newTexts: ["ok thanks"], recentUserTexts: [{ text: "ok thanks", at: ago(2) }] }), NOW)).toBeNull();
    expect(
      preflightEscalation(signals({ newTexts: ["what's due this week"], recentUserTexts: [{ text: "move my gym block to thursday", at: ago(2) }] }), NOW),
    ).toBeNull();
  });
});

describe("scheduling", () => {
  it("counts open negotiation runs since the last booking", () => {
    expect(openNegotiationRuns([run(1, ["find_free_slots"]), run(5, ["find_free_slots", "get_agenda"])])).toBe(2);
    expect(openNegotiationRuns([run(1, ["find_free_slots"]), run(5, ["create_block"]), run(9, ["find_free_slots"])])).toBe(1);
    expect(openNegotiationRuns([run(1, ["find_free_slots", "create_block"])])).toBe(0);
  });

  it("the third back-and-forth escalates; the second doesn't", () => {
    expect(preflightEscalation(signals({ newTexts: ["hmm later?"], recentRuns: [run(2, ["find_free_slots"])] }), NOW)).toBeNull();
    expect(
      preflightEscalation(signals({ newTexts: ["hmm later?"], recentRuns: [run(2, ["find_free_slots"]), run(6, ["find_free_slots"])] }), NOW),
    ).toBe("scheduling");
  });

  it("> 2 explicit constraints in one message escalates", () => {
    const t = "find me 2 hours on thursday after 3pm but not after 8";
    expect(countConstraints(t)).toBeGreaterThan(2);
    expect(preflightEscalation(signals({ newTexts: [t] }), NOW)).toBe("scheduling");
    expect(countConstraints("what's due tomorrow")).toBe(1);
    expect(countConstraints("remind me 2h before the 323 pset")).toBe(1);
    expect(preflightEscalation(signals({ newTexts: ["gym tomorrow for an hour?"] }), NOW)).toBeNull();
  });

  it("stickiness: a scheduling escalation < 10 min ago with the negotiation still open stays on Sonnet", () => {
    const sticky = [run(4, ["find_free_slots"], { escalated: true, reason: "scheduling" })];
    expect(preflightEscalation(signals({ newTexts: ["what about 7"], recentRuns: sticky }), NOW)).toBe("scheduling_sticky");
    // too old
    expect(
      preflightEscalation(signals({ newTexts: ["what about 7"], recentRuns: [run(12, ["find_free_slots"], { escalated: true, reason: "scheduling" })] }), NOW),
    ).toBeNull();
    // negotiation closed (block created)
    expect(
      preflightEscalation(
        signals({ newTexts: ["thanks"], recentRuns: [run(4, ["find_free_slots", "create_block"], { escalated: true, reason: "scheduling" })] }),
        NOW,
      ),
    ).toBeNull();
    // escalated for another reason
    expect(
      preflightEscalation(signals({ newTexts: ["what about 7"], recentRuns: [run(4, ["find_free_slots"], { escalated: true, reason: "frustration" })] }), NOW),
    ).toBeNull();
  });

  it("small talk never escalates", () => {
    expect(preflightEscalation(signals({ newTexts: ["yo what's due tmrw"] }), NOW)).toBeNull();
    expect(preflightEscalation(signals(), NOW)).toBeNull();
  });
});

describe("midRunEscalation", () => {
  it("two failed iterations or a repeated call → tool_failures", () => {
    expect(midRunEscalation({ failedIterations: 0, repeatedCall: false })).toBeNull();
    expect(midRunEscalation({ failedIterations: 1, repeatedCall: false })).toBeNull();
    expect(midRunEscalation({ failedIterations: 2, repeatedCall: false })).toBe("tool_failures");
    expect(midRunEscalation({ failedIterations: 0, repeatedCall: true })).toBe("tool_failures");
  });
});

describe("budgetAllows (mirror of claim_escalation)", () => {
  it.each([
    [0, 9, false],
    [0, 10, true],
    [1, 19, false],
    [1, 20, true],
    [0, 1, false],
    [9, 100, true],
    [10, 100, false],
  ])("escalated=%i total=%i → %s at 10%%", (esc, total, ok) => expect(budgetAllows(esc, total, 10)).toBe(ok));

  it("respects other caps", () => {
    expect(budgetAllows(0, 4, 25)).toBe(true);
    expect(budgetAllows(0, 1000, 0)).toBe(false);
  });
});

describe("escalationCapPct", () => {
  const prev = process.env.AGENT_ESCALATION_CAP_PCT;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_ESCALATION_CAP_PCT;
    else process.env.AGENT_ESCALATION_CAP_PCT = prev;
  });

  it.each([
    [undefined, 10],
    ["", 10],
    ["5", 5],
    ["0", 0],
    ["100", 100],
    ["150", 10],
    ["-1", 10],
    ["7.5", 10],
    ["ten", 10],
  ])("AGENT_ESCALATION_CAP_PCT=%s → %i", (raw, want) => {
    if (raw === undefined) delete process.env.AGENT_ESCALATION_CAP_PCT;
    else process.env.AGENT_ESCALATION_CAP_PCT = raw;
    expect(escalationCapPct()).toBe(want);
  });
});
