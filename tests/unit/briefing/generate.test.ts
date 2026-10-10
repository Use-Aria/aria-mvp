/**
 * src/server/briefing/generate.ts — LLM path with a fake model: URL stripping, bubble merge/clip,
 * two attempts then the template fallback, cost accounting.
 */
import { generateBriefingPlan, sanitizeBubbles, type BriefingModel } from "@/server/briefing/generate";
import { buildBriefingSnapshot } from "@/server/briefing/snapshot";
import { H, inputs, MON_8AM, view } from "./helpers";

const s = buildBriefingSnapshot(inputs({ items: [view({ kind: "assignment", title: "pset", dueAt: new Date(MON_8AM.getTime() + 3 * H) })] }));

function fake(...steps: (string[] | Error)[]): BriefingModel & { calls: number } {
  const f = Object.assign(
    async () => {
      const step = steps[Math.min(f.calls, steps.length - 1)];
      f.calls += 1;
      if (step instanceof Error) throw step;
      return { bubbles: step, costUsd: 0.0005 };
    },
    { calls: 0 },
  );
  return f;
}

describe("sanitizeBubbles", () => {
  it("strips every URL, drops empties, merges overflow into bubble 2, clips to 320", () => {
    const out = sanitizeBubbles(["see https://aria.vercel.app/week", "  ", "two", "three", "x".repeat(400)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("see");
    expect(out[1].startsWith("two\nthree\n")).toBe(true);
    expect(out[1].length).toBeLessThanOrEqual(320);
    expect(sanitizeBubbles(["https://evil.example"])).toEqual([]);
  });
});

describe("generateBriefingPlan", () => {
  it("uses the model output when valid", async () => {
    const m = fake(["morning! pset due 11am"]);
    const r = await generateBriefingPlan(s, "casual", "u1", { model: m });
    expect(r).toEqual({ bubbles: ["morning! pset due 11am"], costUsd: 0.0005, source: "llm" });
    expect(m.calls).toBe(1);
  });

  it("retries once, then falls back to the template", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = fake(new Error("boom"), ["second try"]);
    expect(await generateBriefingPlan(s, "casual", "u1", { model: ok })).toMatchObject({ bubbles: ["second try"], source: "llm" });
    const bad = fake(new Error("boom"), ["https://only-a-link.example"]);
    const r = await generateBriefingPlan(s, "casual", "u1", { model: bad });
    expect(bad.calls).toBe(2);
    expect(r.source).toBe("template");
    expect(r.costUsd).toBeCloseTo(0.0005);
    expect(r.bubbles[0]).toMatch(/^happy monday!/);
    warn.mockRestore();
  });
});
