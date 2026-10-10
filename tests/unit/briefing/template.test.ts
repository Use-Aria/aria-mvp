/**
 * src/server/briefing/template.ts — LLM-free fallback: 1–2 bubbles, never a URL, every due-today
 * item listed when ≤5 (else "+N more"), both registers.
 */
import { buildBriefingSnapshot } from "@/server/briefing/snapshot";
import { templateBriefing } from "@/server/briefing/template";
import { H, inputs, MON_8AM, view } from "./helpers";

const URL_RE = /https?:\/\/|www\./i;
const TUE_8AM = new Date("2026-10-13T12:00:00Z");
const TUE = { year: 2026, month: 10, day: 13 };

function due(n: number, now = TUE_8AM) {
  return Array.from({ length: n }, (_, i) =>
    view({ kind: "assignment", title: `task ${i + 1} https://evil.example/${i}`, course: "CS 1", dueAt: new Date(now.getTime() + (i + 2) * H) }, now),
  );
}

describe("templateBriefing", () => {
  it("lists every due-today item when ≤5, never emits URLs", () => {
    const s = buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE, items: due(4) }));
    const out = templateBriefing(s, "casual");
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(2);
    for (let i = 1; i <= 4; i += 1) expect(out.join("\n")).toContain(`task ${i}`);
    expect(out.join("\n")).not.toMatch(URL_RE);
  });

  it("caps at 5 with +N more", () => {
    const s = buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE, items: due(7) }));
    const text = templateBriefing(s, "casual").join("\n");
    expect(text).toContain("task 5");
    expect(text).not.toContain("task 6");
    expect(text).toContain("+2 more");
  });

  it("empty day: a single short bubble; neutral register uses sentences", () => {
    const s = buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE }));
    expect(templateBriefing(s, "casual")).toEqual(["morning!\nnothing due today 🙌 enjoy it"]);
    expect(templateBriefing(s, "neutral")).toEqual(["Good morning.\nNothing is due today."]);
  });

  it("Monday week view, suggestion, proposal question and Canvas hint", () => {
    const s = buildBriefingSnapshot(
      inputs({
        items: [view({ kind: "assignment", title: "pset 5", dueAt: new Date(MON_8AM.getTime() + 15 * H) })],
        proposal: { id: "p1", statement: "No studying after 11pm." },
        user: { name: "Dan", tz: "America/New_York", briefingTime: { hour: 8, minute: 0 }, register: "casual" },
      }),
    );
    const out = templateBriefing(s, "casual", { canvasHint: true });
    expect(out[0]).toMatch(/^happy monday Dan!\nthis week:\n• today: pset 5/);
    expect(out[1]).toContain("good window for pset 5");
    expect(out[1]).toContain('want me to remember this: "No studying after 11pm"?');
    expect(out[1]).toContain("Canvas");
    expect(out.join("\n")).not.toMatch(URL_RE);
  });
});
