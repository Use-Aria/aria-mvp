/**
 * src/server/reminders/render.ts — deterministic reminder/nudge/alert texts: local times,
 * coalescing, register variants, link stripping, "(from earlier)".
 */
import {
  renderConnectNudge,
  renderDueChangeAlert,
  renderNudge,
  renderUserReminder,
  stripUrls,
} from "@/server/reminders/render";

const NY = "America/New_York";
const NOW = new Date("2026-10-12T16:00:00Z"); // Mon 12:00 EDT
const at = (iso: string) => new Date(iso);
const URL_RE = /https?:\/\/|www\./;

describe("stripUrls", () => {
  const APP = "https://aria.vercel.app";
  it("keeps only links on the app origin", () => {
    expect(stripUrls(`see ${APP}/week and https://evil.example/x now`, APP)).toBe(`see ${APP}/week and now`);
  });
  it("drops www. links and keeps trailing punctuation", () => {
    expect(stripUrls("go to www.evil.example/path, ok?", APP)).toBe("go to, ok?");
  });
  it("drops everything when no origin is allowed", () => {
    expect(stripUrls(`x ${APP}/week y`, "")).toBe("x y");
  });
  it("rejects look-alike hosts and credentials", () => {
    expect(stripUrls("a https://aria.vercel.app.evil.example/x b", APP)).toBe("a b");
    expect(stripUrls("a https://u:p@aria.vercel.app/x b", APP)).toBe("a b");
  });
});

describe("renderUserReminder", () => {
  it("sends the stored text verbatim when on time", () => {
    expect(renderUserReminder("drink water 💧", { lateMinutes: 0 })).toBe("drink water 💧");
  });
  it("prefixes when more than 30 min late", () => {
    expect(renderUserReminder("call mom", { lateMinutes: 45 })).toBe("(from earlier) call mom");
    expect(renderUserReminder("call mom", { lateMinutes: 30 })).toBe("call mom");
  });
});

describe("renderNudge", () => {
  const item = { title: "pset 3", course: "CPSC 323", dueAt: at("2026-10-12T19:00:00Z") }; // 3pm EDT

  it("one item → one bubble with the local time, course prefix and time left", () => {
    const [b, ...rest] = renderNudge([item], NY, NOW, "casual", "seed");
    expect(rest).toHaveLength(0);
    expect(b).toContain("CPSC 323: pset 3");
    expect(b).toContain("today 3pm");
    expect(b).toContain("~3h");
    expect(b).not.toMatch(URL_RE);
  });

  it("does not double the course when the title already names it", () => {
    const [b] = renderNudge([{ ...item, title: "CPSC 323 pset 3" }], NY, NOW, "neutral", "s");
    expect(b).not.toContain("CPSC 323: CPSC 323");
  });

  it("is deterministic per seed and varies across seeds", () => {
    const a = renderNudge([item], NY, NOW, "casual", "r1:2026-10-12");
    expect(renderNudge([item], NY, NOW, "casual", "r1:2026-10-12")).toEqual(a);
    const variants = new Set(Array.from({ length: 20 }, (_, i) => renderNudge([item], NY, NOW, "casual", `s${i}`)[0]));
    expect(variants.size).toBeGreaterThan(1);
  });

  it("neutral register has no emoji and full sentences", () => {
    for (let i = 0; i < 10; i += 1) {
      const [b] = renderNudge([item], NY, NOW, "neutral", `n${i}`);
      expect(b).toMatch(/^(Reminder|Heads up)/);
      expect(b).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("coalesces several items into one list bubble, soonest first", () => {
    const items = [
      { title: "essay", course: null, dueAt: at("2026-10-12T21:00:00Z") },
      { title: "quiz", course: "MATH 120", dueAt: at("2026-10-12T19:30:00Z") },
      { title: "lab", course: null, dueAt: at("2026-10-12T20:00:00Z") },
    ];
    const out = renderNudge(items, NY, NOW, "casual", "x");
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(2);
    const text = out.join("\n");
    expect(text.indexOf("quiz")).toBeLessThan(text.indexOf("lab"));
    expect(text.indexOf("lab")).toBeLessThan(text.indexOf("essay"));
    expect(text).toContain("today 3:30pm");
  });

  it("caps the list with +N more", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, course: null, dueAt: at(`2026-10-12T2${i % 3}:00:00Z`) }));
    expect(renderNudge(many, NY, NOW, "casual", "x")[0]).toContain("+2 more");
  });

  it("strips links from titles and clips long ones", () => {
    const [b] = renderNudge([{ title: `read https://evil.example/x ${"a".repeat(200)}`, course: null, dueAt: item.dueAt }], NY, NOW, "casual", "s");
    expect(b).not.toMatch(URL_RE);
    expect(b).toContain("…");
  });

  it("no items → no bubbles", () => {
    expect(renderNudge([], NY, NOW, "casual", "s")).toEqual([]);
  });
});

describe("renderDueChangeAlert", () => {
  it("one change: 'moved Thu 11:59pm → Fri 5pm'", () => {
    const [b] = renderDueChangeAlert(
      [{ title: "pset 4", course: "CPSC 323", oldDueAt: at("2026-10-16T03:59:00Z"), newDueAt: at("2026-10-16T21:00:00Z") }],
      NY,
      NOW,
      "casual",
    );
    expect(b).toContain("moved");
    expect(b).toContain("Thu 11:59pm → Fri 5pm");
  });

  it("earlier move is called out", () => {
    const [b] = renderDueChangeAlert(
      [{ title: "pset 4", course: null, oldDueAt: at("2026-10-16T21:00:00Z"), newDueAt: at("2026-10-15T21:00:00Z") }],
      NY,
      NOW,
      "neutral",
    );
    expect(b).toContain("moved earlier");
    expect(b).toContain("Fri 5pm → Thu 5pm");
  });

  it("several changes → one list bubble; more than 5 → summary line", () => {
    const c = (i: number) => ({ title: `hw ${i}`, course: null, oldDueAt: null, newDueAt: at("2026-10-14T21:00:00Z") });
    const list = renderDueChangeAlert([c(1), c(2), c(3)], NY, NOW, "casual");
    expect(list).toHaveLength(1);
    expect(list[0].split("\n")).toHaveLength(4);
    expect(list[0]).toContain("now due Wed 5pm");
    const summary = renderDueChangeAlert([1, 2, 3, 4, 5, 6].map(c), NY, NOW, "neutral");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatch(/^6 due dates changed/);
  });

  it("no changes → no bubbles", () => {
    expect(renderDueChangeAlert([], NY, NOW, "casual")).toEqual([]);
  });
});

describe("renderConnectNudge", () => {
  it("has three distinct, link-free attempts per register", () => {
    for (const reg of ["casual", "neutral"] as const) {
      const texts = ([1, 2, 3] as const).map((n) => renderConnectNudge(n, reg)[0]);
      expect(new Set(texts).size).toBe(3);
      for (const t of texts) expect(t).not.toMatch(URL_RE);
    }
  });
});
