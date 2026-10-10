/**
 * src/server/briefing/snapshot.ts — deterministic briefing assembly (V2-06 §10 snapshot cases):
 * local-time rendering (V1 UTC bug regression), load thresholds, exam touchpoints by local day,
 * Monday week view, suggestion gaps, hash stability, empty detection, delivery decisions.
 */
import {
  buildBriefingSnapshot,
  computeLoad,
  decideBriefing,
  examTouchpoints,
  findSuggestion,
  isEmptySnapshot,
  itemLabel,
  noteText,
  snapshotHash,
  type BriefingHistory,
  type BriefingSnapshot,
} from "@/server/briefing/snapshot";
import { D, H, inputs, MIN, MON_8AM, NY, view } from "./helpers";

const NO_HISTORY: BriefingHistory = { previous: [], connectNudgesSent: 0, canvasHintsSent: 0, daysSinceSignup: 10 };
const TUE_8AM = new Date("2026-10-13T12:00:00Z");
const TUE = { year: 2026, month: 10, day: 13 };

describe("local times (V1 UTC display bug regression)", () => {
  it("03:59Z Oct 13 renders as Mon 11:59pm in New York, due today", () => {
    const s = buildBriefingSnapshot(
      inputs({ items: [view({ kind: "assignment", title: "pset 4", course: "CPSC 323", dueAt: new Date("2026-10-13T03:59:00Z") })] }),
    );
    expect(s.dueToday).toHaveLength(1);
    expect(s.dueToday[0]).toMatchObject({ label: "CPSC 323: pset 4", when: "11:59pm" });
    expect(JSON.stringify(s)).not.toMatch(/3:59am|Tue/);
    expect(s.localDateLabel).toBe("Mon Oct 12");
  });

  it("tomorrow-before-noon goes to dueNext; tomorrow afternoon does not", () => {
    const s = buildBriefingSnapshot(
      inputs({
        items: [
          view({ kind: "assignment", title: "quiz", dueAt: new Date("2026-10-13T13:00:00Z") }), // Tue 9am
          view({ kind: "assignment", title: "essay", dueAt: new Date("2026-10-13T17:00:00Z") }), // Tue 1pm
        ],
      }),
    );
    expect(s.dueNext.map((i) => i.title)).toEqual(["quiz"]);
    expect(s.dueNext[0].when).toBe("tmrw 9am");
  });

  it("all-day items land on their floating date and render without a clock time", () => {
    const s = buildBriefingSnapshot(
      inputs({
        items: [view({ kind: "assignment", title: "reading", allDay: true, timingKey: "D:20261012", dueAt: new Date("2026-10-13T03:59:59Z") })],
      }),
    );
    expect(s.dueToday[0].when).toBe("today");
  });
});

describe("computeLoad", () => {
  it.each([
    [0, "light"],
    [1, "light"],
    [2, "busy"],
    [3, "busy"],
    [4, "heavy"],
    [9, "heavy"],
  ] as const)("%i due in 48h → %s", (n, level) => {
    expect(computeLoad(n)).toBe(level);
  });

  it("counts only deadlines due within 48h", () => {
    const s = buildBriefingSnapshot(
      inputs({
        items: [
          view({ kind: "assignment", title: "a", dueAt: new Date(MON_8AM.getTime() + 5 * H) }),
          view({ kind: "exam", title: "b", dueAt: new Date(MON_8AM.getTime() + 47 * H) }),
          view({ kind: "assignment", title: "c", dueAt: new Date(MON_8AM.getTime() + 49 * H) }),
          view({ kind: "event", title: "party", startsAt: new Date(MON_8AM.getTime() + 2 * H) }),
        ],
      }),
    );
    expect(s.due48h).toBe(2);
    expect(s.load).toBe("busy");
    expect(s.weekCount).toBe(3);
  });
});

describe("examTouchpoints (local days)", () => {
  const day = { year: 2026, month: 10, day: 12 };
  it("an all-day exam stored at 03:59:59Z the next day is still 3 days out, not 4", () => {
    const e = view({ kind: "exam", title: "midterm", allDay: true, timingKey: "D:20261015", dueAt: new Date("2026-10-16T03:59:59Z") });
    expect(examTouchpoints([e], NY, day).map((x) => x.daysUntil)).toEqual([3]);
  });
  it("a timed exam at 11:30pm local is day 0 even though it is the next UTC day", () => {
    const e = view({ kind: "exam", title: "quiz", startsAt: new Date("2026-10-13T03:30:00Z"), dueAt: new Date("2026-10-13T03:30:00Z") });
    expect(examTouchpoints([e], NY, day).map((x) => x.daysUntil)).toEqual([0]);
  });
  it("only T-7/5/3/1/0 count; assignments are ignored", () => {
    const at = (d: number) => new Date(Date.UTC(2026, 9, 12 + d, 18));
    const items = [2, 4, 5, 7, 8].map((d) => view({ kind: "exam", title: `e${d}`, dueAt: at(d) }));
    items.push(view({ kind: "assignment", title: "hw", dueAt: at(1) }));
    expect(examTouchpoints(items, NY, day).map((x) => x.daysUntil)).toEqual([5, 7]);
  });
});

describe("Monday week view", () => {
  it("groups the next 7 local days by day and drops empty days", () => {
    const s = buildBriefingSnapshot(
      inputs({
        items: [
          view({ kind: "assignment", title: "pset 5", dueAt: new Date("2026-10-13T03:59:00Z") }), // Mon 11:59pm
          view({ kind: "assignment", title: "econ pset", dueAt: new Date("2026-10-15T03:59:00Z") }), // Wed 11:59pm
          view({ kind: "assignment", title: "next mon", dueAt: new Date("2026-10-19T16:00:00Z") }), // outside
        ],
      }),
    );
    expect(s.kind).toBe("monday");
    expect(s.week?.map((d) => [d.day, d.items.map((i) => i.title)])).toEqual([
      ["today", ["pset 5"]],
      ["Wed Oct 14", ["econ pset"]],
    ]);
  });
  it("is not built on other weekdays", () => {
    const s = buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE }));
    expect(s.week).toBeUndefined();
    expect(s.kind).toBe("empty");
  });
});

describe("findSuggestion", () => {
  const due = view({ kind: "assignment", title: "pset 4", course: "CPSC 323", dueAt: new Date("2026-10-13T03:59:00Z") });
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 12, h + 4, m)); // EDT → UTC
  it("picks the longest free gap between the briefing time and 22:00, before the due time", () => {
    const busy = [
      { start: at(9), end: at(10, 15) },
      { start: at(13), end: at(14) },
    ];
    expect(findSuggestion([due], busy, NY, MON_8AM, { hour: 8, minute: 0 })).toEqual({
      itemLabel: "CPSC 323: pset 4",
      gap: "today 2–10pm",
    });
  });
  it("returns null when the day is full or nothing is due", () => {
    expect(findSuggestion([due], [{ start: at(7), end: at(23) }], NY, MON_8AM, { hour: 8, minute: 0 })).toBeNull();
    expect(findSuggestion([], [], NY, MON_8AM, { hour: 8, minute: 0 })).toBeNull();
  });
  it("prefers the most urgent item, then the heavier syllabus weight", () => {
    const light = view({ kind: "assignment", title: "light", source: "syllabus", dueAt: new Date(MON_8AM.getTime() + 30 * H), raw: { weight_pct: 5 } });
    const heavy = view({ kind: "assignment", title: "heavy", source: "syllabus", dueAt: new Date(MON_8AM.getTime() + 30 * H), raw: { weight_pct: 30 } });
    expect(findSuggestion([light, heavy], [], NY, MON_8AM, { hour: 8, minute: 0 })?.itemLabel).toBe("heavy");
  });
  it("snaps gap edges to the quarter hour", () => {
    const busy = [{ start: at(8), end: at(10, 7) }];
    expect(findSuggestion([due], busy, NY, MON_8AM, { hour: 8, minute: 0 })?.gap).toBe("today 10:15am–10pm");
  });
});

describe("snapshotHash / isEmptySnapshot", () => {
  const base = () =>
    buildBriefingSnapshot(inputs({ items: [view({ id: "11111111-1111-4111-8111-111111111111", kind: "assignment", title: "a", dueAt: new Date(MON_8AM.getTime() + 3 * H) })] }));
  it("is stable for the same content regardless of key order", () => {
    const a = base();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as BriefingSnapshot;
    expect(snapshotHash(reordered)).toBe(snapshotHash(a));
    expect(snapshotHash(base())).toBe(snapshotHash(a));
  });
  it("changes when a due date moves", () => {
    const moved = buildBriefingSnapshot(
      inputs({ items: [view({ id: "11111111-1111-4111-8111-111111111111", kind: "assignment", title: "a", dueAt: new Date(MON_8AM.getTime() + 4 * H) })] }),
    );
    expect(snapshotHash(moved)).not.toBe(snapshotHash(base()));
  });
  it("empty detection", () => {
    const empty = buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE }));
    expect(isEmptySnapshot(empty)).toBe(true);
    const withNote = buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE, notes: [{ id: "n1", kind: "other", payload: { text: "hi" } }] }));
    expect(isEmptySnapshot(withNote)).toBe(false);
    expect(withNote.kind).toBe("daily");
  });
});

describe("catch-up mode", () => {
  it("keeps deadlines still ahead today plus anything due ≤36h; no emails, exams or suggestion", () => {
    const noon = new Date("2026-10-13T17:00:00Z"); // Tue 1pm
    const s = buildBriefingSnapshot(
      inputs({
        now: noon,
        localDate: TUE,
        mode: "catchup",
        items: [
          view({ kind: "assignment", title: "passed", dueAt: new Date("2026-10-13T15:00:00Z") }, noon),
          view({ kind: "assignment", title: "tonight", dueAt: new Date("2026-10-14T03:59:00Z") }, noon),
          view({ kind: "assignment", title: "tmrw pm", dueAt: new Date("2026-10-14T20:00:00Z") }, noon),
          view({ kind: "assignment", title: "far", dueAt: new Date("2026-10-16T20:00:00Z") }, noon),
        ],
        emails: [{ id: "e1", from: "Prof", subject: "hi", kind: null, importance: "high", course: null, newDue: null, summaryUntrusted: "", permalink: null }],
      }),
    );
    expect(s.kind).toBe("catchup");
    expect(s.dueToday.map((i) => i.title)).toEqual(["tonight"]);
    expect(s.dueNext.map((i) => i.title)).toEqual(["tmrw pm"]);
    expect(s.emails).toEqual([]);
    expect(s.suggestion).toBeNull();
  });
});

describe("notes, labels, emails", () => {
  it("renders note texts in local time and strips links from labels", () => {
    expect(
      noteText({ id: "n", kind: "due_changed", payload: { title: "pset", course: "CS 1", oldDue: "2026-10-15T03:59:00Z", newDue: "2026-10-16T21:00:00Z" } }, NY, MON_8AM),
    ).toBe("CS 1: pset moved: Wed 11:59pm → Fri 5pm");
    expect(noteText({ id: "n", kind: "item_removed", payload: { count: 7 } }, NY, MON_8AM)).toMatch(/^7 deadlines disappeared/);
    expect(noteText({ id: "n", kind: "preference_proposal", payload: {} }, NY, MON_8AM)).toBeNull();
    expect(itemLabel("click https://evil.example/x now", "CS 1")).toBe("CS 1: click now");
  });
  it("keeps at most 3 emails", () => {
    const emails = [1, 2, 3, 4].map((i) => ({ id: `e${i}`, from: `p${i}`, subject: `s${i}`, kind: null, importance: "high" as const, course: null, newDue: null, summaryUntrusted: "", permalink: null }));
    expect(buildBriefingSnapshot(inputs({ emails })).emails).toHaveLength(3);
  });
});

describe("decideBriefing", () => {
  const emptyTue = () => buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE }));
  it("empty weekday → one check-in, but not a third in a row", () => {
    expect(decideBriefing(emptyTue(), NO_HISTORY)).toMatchObject({ action: "send", kind: "empty" });
    const streak: BriefingHistory = {
      ...NO_HISTORY,
      previous: [
        { localDate: "2026-10-12", kind: "empty", status: "sent" },
        { localDate: "2026-10-11", kind: "empty", status: "sent" },
      ],
    };
    expect(decideBriefing(emptyTue(), streak)).toEqual({ action: "skip", reason: "empty_streak" });
  });
  it("empty weekend → skip; Monday always sends", () => {
    const sat = buildBriefingSnapshot(inputs({ now: new Date("2026-10-17T12:00:00Z"), localDate: { year: 2026, month: 10, day: 17 } }));
    expect(decideBriefing(sat, NO_HISTORY)).toEqual({ action: "skip", reason: "empty_weekend" });
    expect(decideBriefing(buildBriefingSnapshot(inputs()), NO_HISTORY)).toMatchObject({ action: "send", kind: "monday" });
  });
  it("nothing connected + nothing to say → connect nudge on days 1/3/7 (max 3), else skip", () => {
    const s = buildBriefingSnapshot(inputs({ now: TUE_8AM, localDate: TUE, integrations: { canvas: false, google: false } }));
    expect(decideBriefing(s, { ...NO_HISTORY, daysSinceSignup: 0 })).toEqual({ action: "skip", reason: "nothing_connected" });
    expect(decideBriefing(s, { ...NO_HISTORY, daysSinceSignup: 1 })).toMatchObject({ action: "send", kind: "connect_nudge", connectAttempt: 1 });
    expect(decideBriefing(s, { ...NO_HISTORY, daysSinceSignup: 2, connectNudgesSent: 1 })).toEqual({ action: "skip", reason: "nothing_connected" });
    expect(decideBriefing(s, { ...NO_HISTORY, daysSinceSignup: 9, connectNudgesSent: 2 })).toMatchObject({ connectAttempt: 3 });
    expect(decideBriefing(s, { ...NO_HISTORY, daysSinceSignup: 30, connectNudgesSent: 3 })).toEqual({ action: "skip", reason: "nothing_connected" });
  });
  it("Google-only users with content get the Canvas hint at most 3 times", () => {
    const s = buildBriefingSnapshot(
      inputs({ now: TUE_8AM, localDate: TUE, integrations: { canvas: false, google: true }, items: [view({ kind: "event", title: "lecture", startsAt: new Date(TUE_8AM.getTime() + 2 * H), endsAt: new Date(TUE_8AM.getTime() + 3 * H) }, TUE_8AM)] }),
    );
    expect(decideBriefing(s, NO_HISTORY)).toMatchObject({ action: "send", kind: "daily", canvasHint: true });
    expect(decideBriefing(s, { ...NO_HISTORY, canvasHintsSent: 3 })).toMatchObject({ canvasHint: false });
  });
  it("catch-up with nothing → skip", () => {
    const s = buildBriefingSnapshot(inputs({ now: new Date("2026-10-13T17:00:00Z"), localDate: TUE, mode: "catchup" }));
    expect(decideBriefing(s, NO_HISTORY)).toEqual({ action: "skip", reason: "empty_catchup" });
  });
});

describe("events today", () => {
  it("renders compact local ranges, all-day first", () => {
    const s = buildBriefingSnapshot(
      inputs({
        now: TUE_8AM,
        localDate: TUE,
        items: [
          view({ kind: "class", title: "CPSC 323 lecture", startsAt: new Date("2026-10-13T13:00:00Z"), endsAt: new Date("2026-10-13T14:15:00Z") }, TUE_8AM),
          view({ kind: "event", title: "career fair", source: "gcal", allDay: true, timingKey: "D:20261013", startsAt: new Date("2026-10-13T04:00:00Z") }, TUE_8AM),
          view({ kind: "event", title: "dinner", source: "gcal", startsAt: new Date("2026-10-13T22:30:00Z"), endsAt: new Date("2026-10-14T00:00:00Z") }, TUE_8AM),
        ],
      }),
    );
    expect(s.events).toEqual([
      { label: "career fair", when: "all day", source: "gcal" },
      { label: "CPSC 323 lecture", when: "9–10:15am", source: "canvas" },
      { label: "dinner", when: "6:30–8pm", source: "gcal" },
    ]);
    void D;
    void MIN;
  });
});
