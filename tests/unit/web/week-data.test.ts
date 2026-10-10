/** /week DAL pure helpers (task 4.4): `?w=` parsing, link allow-list, view mapping, DST-safe range. */
import type { TimelineItemView } from "@/server/timeline";
import { parseOffsetWeeks, toWeekItem, weekAllowHosts, weekQueryRange } from "@/server/web/week-data";
import { safeExternalUrl } from "@/shared/safe-url";
import { groupWeek } from "@/shared/week";

function view(over: Partial<TimelineItemView>): TimelineItemView {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    ref: "t_00000000",
    source: "canvas",
    kind: "assignment",
    title: "Pset 3",
    course: "CPSC 323",
    courseKey: "cpsc323",
    startsAt: null,
    endsAt: null,
    dueAt: new Date("2026-10-14T03:59:00Z"),
    allDay: false,
    allDayDate: null,
    url: null,
    status: "upcoming",
    urgency: "this_week",
    urgencyScore: 1,
    hoursUntil: 10,
    label: "Tue 11:59pm",
    ...over,
  };
}

describe("parseOffsetWeeks", () => {
  it("accepts only 0 and 1; everything else falls back to 0", () => {
    expect(parseOffsetWeeks("1")).toBe(1);
    expect(parseOffsetWeeks("0")).toBe(0);
    expect(parseOffsetWeeks(undefined)).toBe(0);
    for (const bad of ["2", "-1", "1.0", " 1", "01", "abc", ""]) expect(parseOffsetWeeks(bad)).toBe(0);
    expect(parseOffsetWeeks(["1", "0"])).toBe(1);
  });
});

describe("weekAllowHosts", () => {
  it("allows Canvas hosts and Google Calendar links, plus the connected host", () => {
    const hosts = weekAllowHosts("canvas.myschool.edu");
    expect(safeExternalUrl("https://yale.instructure.com/courses/1", hosts)).not.toBeNull();
    expect(safeExternalUrl("https://canvas.myschool.edu/courses/1", hosts)).not.toBeNull();
    expect(safeExternalUrl("https://www.google.com/calendar/event?eid=abc", hosts)).not.toBeNull();
    expect(safeExternalUrl("https://canvas.brown.edu/courses/1", hosts)).not.toBeNull();
    expect(safeExternalUrl("https://instructure.com.evil.io/x", hosts)).toBeNull();
    expect(safeExternalUrl("https://evil.example/x", hosts)).toBeNull();
  });

  it("ignores a junk Canvas host", () => {
    expect(weekAllowHosts("evil host/<x>")).toEqual(weekAllowHosts(null));
    expect(new Set(weekAllowHosts(null)).size).toBe(weekAllowHosts(null).length);
  });
});

describe("toWeekItem", () => {
  it("serializes dates and strips spoofing characters from untrusted text", () => {
    const w = toWeekItem(view({ title: "Pset‮ 3​", course: "⁦CPSC 323" }));
    expect(w.title).toBe("Pset 3");
    expect(w.course).toBe("CPSC 323");
    expect(w.dueAt).toBe("2026-10-14T03:59:00.000Z");
    expect(w.startsAt).toBeNull();
    expect(w).not.toHaveProperty("ref");
    expect(w).not.toHaveProperty("urgency");
  });

  it("keeps the floating date only for all-day items and never shows an empty title", () => {
    expect(toWeekItem(view({ allDay: false, allDayDate: "2026-10-14" })).allDayDate).toBeNull();
    expect(toWeekItem(view({ allDay: true, allDayDate: "2026-10-14" })).allDayDate).toBe("2026-10-14");
    expect(toWeekItem(view({ title: "​" })).title).toBe("Untitled");
    expect(toWeekItem(view({ course: null })).course).toBeNull();
  });
});

describe("weekQueryRange", () => {
  it("pads one local day each side and starts the overdue tail 8 days back (this week)", () => {
    const r = weekQueryRange(new Date("2026-10-10T16:00:00Z"), "America/New_York", 0);
    expect(r.from.toISOString()).toBe("2026-10-09T04:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-18T04:00:00.000Z");
    expect(r.overdueSince?.toISOString()).toBe("2026-10-02T04:00:00.000Z");
  });

  it("uses local midnights across the fall-back DST change", () => {
    const r = weekQueryRange(new Date("2026-10-30T16:00:00Z"), "America/New_York", 0);
    expect(r.from.toISOString()).toBe("2026-10-29T04:00:00.000Z"); // EDT
    expect(r.to.toISOString()).toBe("2026-11-07T05:00:00.000Z"); // EST
  });

  it("shifts a week for ?w=1 and drops the overdue tail", () => {
    const r = weekQueryRange(new Date("2026-10-10T16:00:00Z"), "America/New_York", 1);
    expect(r.from.toISOString()).toBe("2026-10-16T04:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-25T04:00:00.000Z");
    expect(r.overdueSince).toBeUndefined();
  });

  it("uses the user's local day, not UTC's (late evening in Los Angeles)", () => {
    const r = weekQueryRange(new Date("2026-10-11T05:30:00Z"), "America/Los_Angeles", 0); // Oct 10, 10:30pm PDT
    expect(r.from.toISOString()).toBe("2026-10-09T07:00:00.000Z");
  });
});

describe("all-day items through the DAL mapping", () => {
  it("land on their floating date for a UTC−10 user even when the anchor is the previous local day", () => {
    // Canvas all-day "Oct 14" whose stored anchor is 2026-10-14T04:00Z (= Oct 13, 6pm in Honolulu).
    const items = [
      toWeekItem(view({ allDay: true, allDayDate: "2026-10-14", dueAt: new Date("2026-10-14T04:00:00Z") })),
      toWeekItem(view({ id: "00000000-0000-4000-8000-000000000002", dueAt: new Date("2026-10-14T04:00:00Z") })),
    ];
    const week = groupWeek(items, { timeZone: "Pacific/Honolulu", now: new Date("2026-10-12T20:00:00Z"), offsetWeeks: 0 });
    const byKey = Object.fromEntries(week.days.map((d) => [d.key, d.deadlines.map((i) => i.id)]));
    expect(byKey["2026-10-14"]).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(byKey["2026-10-13"]).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });
});
