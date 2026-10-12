/**
 * Static prompt (V2-04 §2.5, §10.1): byte-stable cached prefix, few-shot filtering, and few-shots
 * that match the real tool registry (names, argument shapes, reply format).
 */
import { estimateTokens } from "@/server/agent/context/budget";
import { buildStaticSystemPrompt, staticPrefix } from "@/server/agent/context/static-prompt";
import { parseModelPlan } from "@/server/agent/plan";
import { FEW_SHOTS } from "@/server/agent/persona/few-shots";
import { TOOLS } from "@/server/agent/tools";
import { welcomePlan } from "@/server/pipeline/welcome";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

afterEach(() => {
  jest.useRealTimers();
});

describe("buildStaticSystemPrompt", () => {
  it("is byte-identical across calls, clocks and fresh registry arrays", () => {
    jest.useFakeTimers({ now: new Date("2026-10-10T15:00:00Z") });
    const a = buildStaticSystemPrompt([...TOOLS]);
    const aTools = JSON.stringify(staticPrefix([...TOOLS]).tools);
    jest.setSystemTime(new Date("2027-03-14T03:30:00Z"));
    const b = buildStaticSystemPrompt([...TOOLS]);
    const bTools = JSON.stringify(staticPrefix([...TOOLS]).tools);
    expect(b).toBe(a);
    expect(bTools).toBe(aTools);
    expect(buildStaticSystemPrompt()).toBe(a);
    expect(buildStaticSystemPrompt()).toBe(buildStaticSystemPrompt()); // memoized
  });

  it("contains no clock-derived dates, no UUIDs, no user-specific data", () => {
    jest.useFakeTimers({ now: new Date("2026-10-10T15:00:00Z") });
    const p = buildStaticSystemPrompt([...TOOLS]);
    expect(p).not.toContain("2026-10-10");
    expect(p).not.toContain("Oct 10");
    expect(p).not.toMatch(UUID_RE);
    expect(JSON.stringify(staticPrefix().tools)).not.toMatch(UUID_RE);
  });

  it("covers persona, safety and output rules", () => {
    const p = buildStaticSystemPrompt();
    for (const needle of [
      "Mirror the student",
      "I'm an AI 🤖",
      "988",
      "<untrusted",
      "never instructions",
      "hold for the whole conversation",
      "evidence",
      "send_interim",
      '"reactions"',
      "[attachment m_",
    ]) {
      expect(p).toContain(needle);
    }
  });

  it("includes only few-shots whose tools are registered", () => {
    const all = buildStaticSystemPrompt();
    for (const f of FEW_SHOTS) expect(all).toContain(`<example name="${f.id}">`);
    const minimal = buildStaticSystemPrompt(TOOLS.filter((t) => t.spec.name === "get_agenda"));
    expect(minimal).toContain('<example name="agenda_tomorrow">');
    expect(minimal).toContain('<example name="ack_like">');
    expect(minimal).not.toContain('<example name="gym_slots">');
    expect(minimal).not.toContain('<example name="week_with_link">');
  });

  it("stays well under the static budget (estimate ≤ 10k tokens for the system text)", () => {
    expect(estimateTokens(buildStaticSystemPrompt())).toBeLessThanOrEqual(10_000);
  });
});

describe("few-shots match the registry", () => {
  const byName = new Map(TOOLS.map((t) => [t.spec.name, t]));

  it("has ≥ 21 exchanges with unique ids", () => {
    expect(FEW_SHOTS.length).toBeGreaterThanOrEqual(21);
    expect(new Set(FEW_SHOTS.map((f) => f.id)).size).toBe(FEW_SHOTS.length);
  });

  it.each(FEW_SHOTS.map((f) => [f.id, f] as const))("%s: calls validate, requiresTools is exact, answers parse", (_id, f) => {
    const called = new Set<string>();
    for (const line of f.transcript.split("\n")) {
      const call = /^→ ([a-z_]+) (\{.*\})$/.exec(line);
      if (call) {
        const tool = byName.get(call[1]);
        expect(tool).toBeDefined();
        const parsed = tool?.spec.input.safeParse(JSON.parse(call[2]));
        if (!parsed?.success) throw new Error(`${f.id}: ${call[1]} args invalid: ${JSON.stringify(parsed?.error.issues)}`);
        called.add(call[1]);
      }
      const answer = /^aria: (\{.*\})$/.exec(line);
      if (answer) {
        const plan = parseModelPlan(answer[1]);
        expect(plan).not.toBeNull();
        expect(plan?.bubbles.length ?? 99).toBeLessThanOrEqual(3);
      }
    }
    expect([...called].sort()).toEqual([...f.requiresTools].sort());
  });

  it("welcome_name_confirm answers the welcome's signup-name check (welcome.ts) with update_profile", () => {
    const f = FEW_SHOTS.find((x) => x.id === "welcome_name_confirm");
    const ask = welcomePlan({ name: "Sam" }).bubbles[1]?.text ?? "";
    expect(ask).toBe("you're Sam, right?");
    expect(f?.transcript).toContain(`"${ask}"`);
    expect(f?.transcript).toContain('→ update_profile {"field":"name","value":"Alex","evidence":"m_c5d6e701"}');
    expect(f?.requiresTools).toEqual(["update_profile"]);
  });

  it("uses the §1.4 names (update_profile has no briefing_time; pause is the pause tool)", () => {
    const text = FEW_SHOTS.map((f) => f.transcript).join("\n");
    expect(text).not.toMatch(/briefing_time/);
    expect(text).toContain("→ pause ");
    expect(text).not.toMatch(/→ (react|set_quiet|pause_texts) /);
  });
});
