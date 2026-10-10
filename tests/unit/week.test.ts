/**
 * /week grouping (web plan §10 week.test): DST-safe day keys, all-day floating dates,
 * window edges, "Still open", sorting, load thresholds, labels.
 */
import {
  dayLabel,
  dayLoad,
  formatItemTime,
  groupWeek,
  localDayKey,
  weekLoad,
  type WeekItem,
} from "@/shared/week";

const NY = "America/New_York";

let seq = 0;
function item(p: Partial<WeekItem>): WeekItem {
  seq += 1;
  return {
    id: `i${seq}`,
    source: "canvas",
    kind: "assignment",
    title: `Item ${seq}`,
    course: null,
    startsAt: null,
    endsAt: null,
    dueAt: null,
    allDay: false,
    allDayDate: null,
    url: null,
    status: "upcoming",
    ...p,
  };
}

describe("localDayKey", () => {
  it("handles NY fall-back (2026-11-01)", () => {
    expect(localDayKey("2026-11-01T03:59:00Z", NY)).toBe("2026-10-31");
    expect(localDayKey("2026-11-01T04:30:00Z", NY)).toBe("2026-11-01");
    expect(localDayKey("2026-11-01T05:30:00Z", NY)).toBe("2026-11-01"); // 01:30 EDT
    expect(localDayKey("2026-11-01T06:30:00Z", NY)).toBe("2026-11-01"); // 01:30 EST
    expect(localDayKey("2026-11-02T04:59:00Z", NY)).toBe("2026-11-01"); // 23:59 EST
    expect(localDayKey("2026-11-02T05:00:00Z", NY)).toBe("2026-11-02");
  });

  it("handles NY spring-forward (2027-03-14)", () => {
    expect(localDayKey("2027-03-14T04:59:00Z", NY)).toBe("2027-03-13");
    expect(localDayKey("2027-03-14T05:00:00Z", NY)).toBe("2027-03-14");
    expect(localDayKey("2027-03-14T06:59:00Z", NY)).toBe("2027-03-14"); // 01:59 EST
    expect(localDayKey("2027-03-14T07:00:00Z", NY)).toBe("2027-03-14"); // 03:00 EDT
    expect(localDayKey("2027-03-15T03:59:00Z", NY)).toBe("2027-03-14"); // 23:59 EDT
  });

  it("handles UTC+13 and UTC−10", () => {
    expect(localDayKey("2026-10-10T11:30:00Z", "Pacific/Tongatapu")).toBe("2026-10-11");
    expect(localDayKey("2026-10-10T10:59:00Z", "Pacific/Tongatapu")).toBe("2026-10-10");
    expect(localDayKey("2026-10-11T09:59:00Z", "Pacific/Honolulu")).toBe("2026-10-10");
    expect(localDayKey("2026-10-11T10:00:00Z", "Pacific/Honolulu")).toBe("2026-10-11");
  });
});

describe("groupWeek", () => {
  const now = new Date("2026-10-10T16:00:00Z"); // Sat 12:00 EDT

  it("builds 7 local days starting today", () => {
    const v = groupWeek([], { timeZone: NY, now, offsetWeeks: 0 });
    expect(v.days.map((d) => d.key)).toEqual([
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
    ]);
    expect(v.days[0].label).toBe("Today");
    expect(v.days[1].label).toBe("Tomorrow");
    expect(v.days[2].label).toBe("Mon, Oct 12");
    expect(v).toMatchObject({ stillOpen: [], dueCount: 0, load: "light" });
  });

  it("puts 23:59:59 local in today and 00:00 local in tomorrow", () => {
    const a = item({ dueAt: "2026-10-11T03:59:59Z" });
    const b = item({ dueAt: "2026-10-11T04:00:00Z" });
    const v = groupWeek([a, b], { timeZone: NY, now, offsetWeeks: 0 });
    expect(v.days[0].deadlines.map((i) => i.id)).toEqual([a.id]);
    expect(v.days[1].deadlines.map((i) => i.id)).toEqual([b.id]);
  });

  it("drops items past the last day and before the window", () => {
    const last = item({ dueAt: "2026-10-17T03:59:00Z" });
    const after = item({ dueAt: "2026-10-17T04:00:00Z" });
    const v = groupWeek([last, after], { timeZone: NY, now, offsetWeeks: 0 });
    expect(v.days[6].deadlines.map((i) => i.id)).toEqual([last.id]);
    expect(v.days.flatMap((d) => d.deadlines)).toHaveLength(1);
    expect(v.stillOpen).toHaveLength(0);
  });

  it("keeps all-day items on their floating date in any zone", () => {
    const allDay = item({ allDay: true, allDayDate: "2026-10-12", dueAt: "2026-10-12T00:00:00Z" });
    for (const tz of ["Pacific/Honolulu", "Pacific/Tongatapu", NY]) {
      const v = groupWeek([allDay], { timeZone: tz, now, offsetWeeks: 0 });
      const day = v.days.find((d) => d.deadlines.some((i) => i.id === allDay.id));
      expect(day?.key).toBe("2026-10-12");
    }
  });

  it("'Still open' holds upcoming deadlines from the previous 7 days only", () => {
    const open = item({ dueAt: "2026-10-05T15:00:00Z" });
    const tooOld = item({ dueAt: "2026-10-02T15:00:00Z" });
    const doneOld = item({ dueAt: "2026-10-05T15:00:00Z", status: "done" });
    const earlierToday = item({ dueAt: "2026-10-10T13:00:00Z" });
    const pastEvent = item({ kind: "event", startsAt: "2026-10-05T15:00:00Z" });
    const v = groupWeek([open, tooOld, doneOld, earlierToday, pastEvent], {
      timeZone: NY,
      now,
      offsetWeeks: 0,
    });
    expect(v.stillOpen.map((i) => i.id)).toEqual([open.id]);
    expect(v.days[0].deadlines.map((i) => i.id)).toEqual([earlierToday.id]);
  });

  it("sorts deadlines: time, exams first on ties, title, done last", () => {
    const at = "2026-10-12T15:00:00Z";
    const done = item({ dueAt: "2026-10-12T13:00:00Z", status: "done", title: "A done" });
    const late = item({ dueAt: "2026-10-12T20:00:00Z", title: "Late" });
    const asg = item({ dueAt: at, title: "Alpha" });
    const exam = item({ dueAt: at, kind: "exam", title: "Zeta exam" });
    const allDay = item({ allDay: true, allDayDate: "2026-10-12", title: "All day thing" });
    const v = groupWeek([done, late, asg, exam, allDay], { timeZone: NY, now, offsetWeeks: 0 });
    expect(v.days[2].deadlines.map((i) => i.title)).toEqual([
      "Zeta exam",
      "Alpha",
      "Late",
      "All day thing",
      "A done",
    ]);
  });

  it("splits schedule items and sorts them all-day first, then by start", () => {
    const cls = item({ kind: "class", startsAt: "2026-10-13T14:30:00Z", endsAt: "2026-10-13T15:45:00Z" });
    const early = item({ kind: "event", startsAt: "2026-10-13T12:00:00Z" });
    const allDay = item({ kind: "event", allDay: true, allDayDate: "2026-10-13" });
    const v = groupWeek([cls, early, allDay], { timeZone: NY, now, offsetWeeks: 0 });
    expect(v.days[3].schedule.map((i) => i.id)).toEqual([allDay.id, early.id, cls.id]);
    expect(v.days[3].deadlines).toHaveLength(0);
  });

  it("computes points, day load, week load, and dueCount; drops dismissed", () => {
    const items = [
      item({ dueAt: "2026-10-12T15:00:00Z", kind: "exam" }),
      item({ dueAt: "2026-10-12T16:00:00Z" }),
      item({ dueAt: "2026-10-12T17:00:00Z", status: "done" }),
      item({ dueAt: "2026-10-12T18:00:00Z", status: "dismissed" }),
      item({ dueAt: "2026-10-13T15:00:00Z" }),
      item({ dueAt: "2026-10-14T15:00:00Z" }),
      item({ dueAt: "2026-10-14T16:00:00Z" }),
    ];
    const v = groupWeek(items, { timeZone: NY, now, offsetWeeks: 0 });
    expect(v.days[2]).toMatchObject({ points: 3, load: "heavy" });
    expect(v.days[2].deadlines).toHaveLength(3);
    expect(v.days[3]).toMatchObject({ points: 1, load: "light" });
    expect(v.days[4]).toMatchObject({ points: 2, load: "busy" });
    expect(v.dueCount).toBe(5);
    expect(v.load).toBe("busy");
  });

  it("offsetWeeks=1 shows the following 7 days and no 'Still open'", () => {
    const open = item({ dueAt: "2026-10-05T15:00:00Z" });
    const next = item({ dueAt: "2026-10-18T15:00:00Z" });
    const v = groupWeek([open, next], { timeZone: NY, now, offsetWeeks: 1 });
    expect(v.days[0].key).toBe("2026-10-17");
    expect(v.days[6].key).toBe("2026-10-23");
    expect(v.days[1].deadlines.map((i) => i.id)).toEqual([next.id]);
    expect(v.stillOpen).toHaveLength(0);
  });
});

describe("load thresholds and labels", () => {
  it("weekLoad boundaries 3/4/6/7", () => {
    expect([0, 3, 4, 6, 7, 20].map(weekLoad)).toEqual(["light", "light", "busy", "busy", "heavy", "heavy"]);
  });

  it("dayLoad boundaries 1/2/3", () => {
    expect([0, 1, 2, 3, 9].map(dayLoad)).toEqual(["light", "light", "busy", "heavy", "heavy"]);
  });

  it("dayLabel crosses month and year ends", () => {
    expect(dayLabel("2026-11-01", "2026-10-31", NY)).toBe("Tomorrow");
    expect(dayLabel("2027-01-01", "2026-12-31", NY)).toBe("Tomorrow");
    expect(dayLabel("2027-01-02", "2026-12-31", NY)).toBe("Sat, Jan 2");
    expect(dayLabel("2026-10-14", "2026-10-14", NY)).toBe("Today");
  });

  it("formatItemTime", () => {
    expect(formatItemTime(item({ dueAt: "2026-10-13T03:59:00Z" }), NY)).toBe("Due 11:59 PM");
    expect(formatItemTime(item({ kind: "exam", dueAt: "2026-10-13T13:00:00Z" }), NY)).toBe("Exam 9:00 AM");
    expect(formatItemTime(item({ allDay: true, allDayDate: "2026-10-13" }), NY)).toBe("Due (all day)");
    expect(
      formatItemTime(item({ kind: "class", startsAt: "2026-10-13T14:30:00Z", endsAt: "2026-10-13T15:45:00Z" }), NY),
    ).toBe("10:30–11:45 AM");
    expect(
      formatItemTime(item({ kind: "event", startsAt: "2026-10-13T15:30:00Z", endsAt: "2026-10-13T16:45:00Z" }), NY),
    ).toBe("11:30 AM–12:45 PM");
    expect(formatItemTime(item({ kind: "event", allDay: true, allDayDate: "2026-10-13" }), NY)).toBe("All day");
  });
});
