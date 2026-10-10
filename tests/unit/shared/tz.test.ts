import {
  DEFAULT_TIME_ZONE,
  addLocalDays,
  compareLocalDate,
  formatForChat,
  formatForTool,
  formatLocalDate,
  formatTimeRange,
  isInDailyWindow,
  isValidTimeZone,
  localDateOf,
  localDatesBetween,
  offsetMinutes,
  parseHHMM,
  parseLocalDate,
  parseLocalDateTime,
  safeTimeZone,
  startOfLocalDay,
  toLocal,
  weekdayOf,
  zonedToUtc,
  type LocalDateTime,
} from "@/shared/time/tz";

function ldt(s: string): LocalDateTime {
  const v = parseLocalDateTime(s);
  if (!v) throw new Error(`bad fixture ${s}`);
  return v;
}

const NY = "America/New_York";

describe("zonedToUtc DST vectors (V2-06 §10, V2-07 §10, V2-03 §10.1)", () => {
  const cases: [tz: string, local: string, utc: string, adjusted: "none" | "gap_shifted" | "overlap_earlier"][] = [
    [NY, "2026-03-07T08:00", "2026-03-07T13:00:00.000Z", "none"],
    [NY, "2026-03-08T08:00", "2026-03-08T12:00:00.000Z", "none"],
    [NY, "2026-03-08T02:30", "2026-03-08T07:30:00.000Z", "gap_shifted"],
    [NY, "2026-03-08T02:00", "2026-03-08T07:00:00.000Z", "gap_shifted"],
    [NY, "2026-03-08T03:00", "2026-03-08T07:00:00.000Z", "none"],
    [NY, "2026-10-31T08:00", "2026-10-31T12:00:00.000Z", "none"],
    [NY, "2026-11-01T08:00", "2026-11-01T13:00:00.000Z", "none"],
    [NY, "2026-11-01T01:30", "2026-11-01T05:30:00.000Z", "overlap_earlier"],
    [NY, "2026-11-01T00:59", "2026-11-01T04:59:00.000Z", "none"],
    [NY, "2026-11-01T02:00", "2026-11-01T07:00:00.000Z", "none"],
    ["America/Los_Angeles", "2026-11-01T08:00", "2026-11-01T16:00:00.000Z", "none"],
    ["Australia/Sydney", "2026-10-04T02:30", "2026-10-03T16:30:00.000Z", "gap_shifted"],
    ["Australia/Sydney", "2026-10-04T08:00", "2026-10-03T21:00:00.000Z", "none"],
    ["Australia/Sydney", "2026-04-05T02:30", "2026-04-04T15:30:00.000Z", "overlap_earlier"],
    ["Australia/Lord_Howe", "2026-10-04T02:15", "2026-10-03T15:45:00.000Z", "gap_shifted"],
    ["Australia/Lord_Howe", "2026-10-04T08:00", "2026-10-03T21:00:00.000Z", "none"],
    ["Australia/Lord_Howe", "2026-04-05T01:45", "2026-04-04T14:45:00.000Z", "overlap_earlier"],
    ["Asia/Kolkata", "2026-10-12T08:00", "2026-10-12T02:30:00.000Z", "none"],
    ["Europe/London", "2026-10-25T01:30", "2026-10-25T00:30:00.000Z", "overlap_earlier"],
    ["Europe/London", "2026-03-29T01:30", "2026-03-29T01:30:00.000Z", "gap_shifted"],
    ["America/Phoenix", "2026-03-08T08:00", "2026-03-08T15:00:00.000Z", "none"],
    ["America/Phoenix", "2026-03-08T02:30", "2026-03-08T09:30:00.000Z", "none"],
    ["Pacific/Auckland", "2026-07-01T08:00", "2026-06-30T20:00:00.000Z", "none"],
    ["Pacific/Auckland", "2026-01-15T08:00", "2026-01-14T19:00:00.000Z", "none"],
    ["Pacific/Auckland", "2026-09-27T02:30", "2026-09-26T14:30:00.000Z", "gap_shifted"],
    ["Pacific/Auckland", "2026-04-05T02:30", "2026-04-04T13:30:00.000Z", "overlap_earlier"],
  ];

  it.each(cases)("%s %s → %s (%s)", (tz, local, utc, adjusted) => {
    const r = zonedToUtc(ldt(local), tz);
    expect(r.instant.toISOString()).toBe(utc);
    expect(r.adjusted).toBe(adjusted);
  });

  it("gap times land on the shifted wall clock (02:30 → 03:30 EDT, Lord Howe 02:15 → 02:45)", () => {
    const ny = toLocal(zonedToUtc(ldt("2026-03-08T02:30"), NY).instant, NY);
    expect([ny.hour, ny.minute]).toEqual([3, 30]);
    const lh = toLocal(zonedToUtc(ldt("2026-10-04T02:15"), "Australia/Lord_Howe").instant, "Australia/Lord_Howe");
    expect([lh.hour, lh.minute]).toEqual([2, 45]);
  });

  it("stepping the local date across fall-back gives a 25h gap, never +24h", () => {
    const a = zonedToUtc(ldt("2026-10-31T08:00"), NY).instant;
    const b = zonedToUtc({ ...addLocalDays(localDateOf(a, NY), 1), hour: 8, minute: 0 }, NY).instant;
    expect(b.getTime() - a.getTime()).toBe(25 * 3600_000);
  });
});

describe("offsets and toLocal", () => {
  it("offsetMinutes handles half-hour, 30-min DST and negative zones", () => {
    expect(offsetMinutes("Asia/Kolkata", new Date("2026-10-12T00:00:00Z"))).toBe(330);
    expect(offsetMinutes(NY, new Date("2026-01-10T12:00:00Z"))).toBe(-300);
    expect(offsetMinutes(NY, new Date("2026-07-10T12:00:00Z"))).toBe(-240);
    expect(offsetMinutes("Australia/Lord_Howe", new Date("2026-01-10T12:00:00Z"))).toBe(660);
    expect(offsetMinutes("Australia/Lord_Howe", new Date("2026-07-10T12:00:00Z"))).toBe(630);
    expect(offsetMinutes("UTC", new Date("2026-07-10T12:00:00Z"))).toBe(0);
  });

  it("toLocal gives local fields and weekday", () => {
    expect(toLocal(new Date("2026-10-13T03:59:00Z"), NY)).toEqual({
      year: 2026, month: 10, day: 12, hour: 23, minute: 59, weekday: "MO",
    });
    expect(toLocal(new Date("2026-10-12T02:30:00Z"), "Asia/Kolkata")).toMatchObject({ hour: 8, minute: 0 });
    expect(toLocal(new Date("2026-01-01T00:00:00Z"), "UTC")).toMatchObject({ hour: 0, weekday: "TH" });
  });

  it("localDateOf around UTC midnight (V2-03 localDateKey)", () => {
    expect(formatLocalDate(localDateOf(new Date("2026-10-10T03:59:00Z"), NY))).toBe("2026-10-09");
    expect(formatLocalDate(localDateOf(new Date("2026-10-10T04:00:00Z"), NY))).toBe("2026-10-10");
    expect(formatLocalDate(localDateOf(new Date("2026-10-09T18:29:00Z"), "Asia/Kolkata"))).toBe("2026-10-09");
    expect(formatLocalDate(localDateOf(new Date("2026-10-09T18:30:00Z"), "Asia/Kolkata"))).toBe("2026-10-10");
  });
});

describe("property: toLocal → zonedToUtc round-trips (10k instants × 6 zones, seeded)", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const zones = [NY, "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata", "Pacific/Auckland", "America/Phoenix"];
  const from = Date.UTC(1990, 0, 1);
  const to = Date.UTC(2060, 0, 1);

  it.each(zones)("%s", (tz) => {
    const rand = mulberry32(0xa11a + tz.length);
    let overlaps = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const t = Math.floor((from + rand() * (to - from)) / 60_000) * 60_000;
      const local = toLocal(new Date(t), tz);
      const r = zonedToUtc(local, tz);
      if (r.instant.getTime() !== t) {
        // Only the later half of a fall-back overlap may resolve elsewhere: to the earlier instant.
        expect(r.adjusted).toBe("overlap_earlier");
        expect(r.instant.getTime()).toBeLessThan(t);
        const back = toLocal(r.instant, tz);
        expect([back.year, back.month, back.day, back.hour, back.minute]).toEqual([
          local.year, local.month, local.day, local.hour, local.minute,
        ]);
        overlaps += 1;
      } else {
        expect(r.adjusted).not.toBe("gap_shifted");
      }
      // Local fields are exactly the UTC fields shifted by the offset.
      const shifted = new Date(t + offsetMinutes(tz, new Date(t)) * 60_000);
      expect(local.hour).toBe(shifted.getUTCHours());
      expect(local.day).toBe(shifted.getUTCDate());
    }
    expect(overlaps).toBeLessThan(100);
  });
});

describe("day helpers", () => {
  it("startOfLocalDay on 23h and 25h days", () => {
    const spring = startOfLocalDay(new Date("2026-03-08T20:00:00Z"), NY);
    const springNext = startOfLocalDay(new Date("2026-03-09T20:00:00Z"), NY);
    expect(spring.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(springNext.getTime() - spring.getTime()).toBe(23 * 3600_000);
    const fall = startOfLocalDay(new Date("2026-11-01T20:00:00Z"), NY);
    const fallNext = startOfLocalDay(new Date("2026-11-02T20:00:00Z"), NY);
    expect(fall.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fallNext.getTime() - fall.getTime()).toBe(25 * 3600_000);
  });

  it("startOfLocalDay when midnight itself is skipped (Santiago 2026-09-06 → 01:00)", () => {
    const s = startOfLocalDay(new Date("2026-09-06T18:00:00Z"), "America/Santiago");
    expect(toLocal(s, "America/Santiago")).toMatchObject({ day: 6, hour: 1, minute: 0 });
  });

  it("localDatesBetween across DST has no skipped or duplicated dates", () => {
    const days = localDatesBetween(new Date("2026-10-31T12:00:00Z"), new Date("2026-11-03T12:00:00Z"), NY).map(formatLocalDate);
    expect(days).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
    const spring = localDatesBetween(
      startOfLocalDay(new Date("2026-03-07T12:00:00Z"), NY),
      startOfLocalDay(new Date("2026-03-10T12:00:00Z"), NY),
      NY,
    ).map(formatLocalDate);
    expect(spring).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    const akl = localDatesBetween(new Date("2026-09-25T12:00:00Z"), new Date("2026-09-29T12:00:00Z"), "Pacific/Auckland");
    expect(new Set(akl.map(formatLocalDate)).size).toBe(akl.length);
    expect(akl.map(formatLocalDate)).toEqual(["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(localDatesBetween(new Date("2026-10-10T00:00:00Z"), new Date("2026-10-10T00:00:00Z"), NY)).toEqual([]);
  });

  it("addLocalDays / weekdayOf / compareLocalDate are pure calendar math", () => {
    expect(addLocalDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addLocalDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(addLocalDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(weekdayOf({ year: 2026, month: 10, day: 10 })).toBe("SA");
    expect(weekdayOf({ year: 2026, month: 10, day: 12 })).toBe("MO");
    expect(compareLocalDate({ year: 2026, month: 1, day: 2 }, { year: 2026, month: 1, day: 10 })).toBe(-1);
    expect(compareLocalDate({ year: 2026, month: 1, day: 2 }, { year: 2026, month: 1, day: 2 })).toBe(0);
    expect(compareLocalDate({ year: 2027, month: 1, day: 1 }, { year: 2026, month: 12, day: 31 })).toBe(1);
  });
});

describe("validation and parsing", () => {
  it("isValidTimeZone / safeTimeZone", () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(safeTimeZone("Mars/Base")).toBe(DEFAULT_TIME_ZONE);
    expect(safeTimeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(safeTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(safeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(DEFAULT_TIME_ZONE).toBe("America/New_York");
  });

  it("parseHHMM accepts Postgres time text and rejects junk", () => {
    expect(parseHHMM("08:00")).toEqual({ hour: 8, minute: 0 });
    expect(parseHHMM("22:00:00")).toEqual({ hour: 22, minute: 0 });
    expect(parseHHMM("7:05")).toEqual({ hour: 7, minute: 5 });
    expect(parseHHMM("23:59:59.999")).toEqual({ hour: 23, minute: 59 });
    expect(() => parseHHMM("24:00")).toThrow(RangeError);
    expect(() => parseHHMM("12:60")).toThrow(RangeError);
    expect(() => parseHHMM("noon")).toThrow(RangeError);
  });

  it("parseLocalDate / parseLocalDateTime are strict", () => {
    expect(parseLocalDate("2026-10-12")).toEqual({ year: 2026, month: 10, day: 12 });
    expect(parseLocalDate("2026-02-30")).toBeNull();
    expect(parseLocalDate("2026-1-5")).toBeNull();
    expect(parseLocalDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseLocalDateTime("2026-10-12T21:30")).toEqual({ year: 2026, month: 10, day: 12, hour: 21, minute: 30 });
    expect(parseLocalDateTime("2026-10-12 21:30:15")).toEqual({ year: 2026, month: 10, day: 12, hour: 21, minute: 30 });
    expect(parseLocalDateTime("2026-10-12T21:30Z")).toBeNull();
    expect(parseLocalDateTime("2026-10-12T21:30-04:00")).toBeNull();
    expect(parseLocalDateTime("2026-10-12T25:00")).toBeNull();
    expect(parseLocalDateTime("2026-13-12T10:00")).toBeNull();
  });

  it("isInDailyWindow: midnight-spanning and non-spanning windows", () => {
    const q = [parseHHMM("22:00"), parseHHMM("08:00")] as const;
    expect(isInDailyWindow(parseHHMM("23:59"), ...q)).toBe(true);
    expect(isInDailyWindow(parseHHMM("22:00"), ...q)).toBe(true);
    expect(isInDailyWindow(parseHHMM("07:59"), ...q)).toBe(true);
    expect(isInDailyWindow(parseHHMM("08:00"), ...q)).toBe(false);
    expect(isInDailyWindow(parseHHMM("21:59"), ...q)).toBe(false);
    const lunch = [parseHHMM("13:00"), parseHHMM("14:00")] as const;
    expect(isInDailyWindow(parseHHMM("13:00"), ...lunch)).toBe(true);
    expect(isInDailyWindow(parseHHMM("13:59"), ...lunch)).toBe(true);
    expect(isInDailyWindow(parseHHMM("14:00"), ...lunch)).toBe(false);
    expect(isInDailyWindow(parseHHMM("12:59"), ...lunch)).toBe(false);
    expect(isInDailyWindow(parseHHMM("10:00"), parseHHMM("09:00"), parseHHMM("09:00"))).toBe(false);
  });
});

describe("formatting", () => {
  const now = new Date("2026-10-13T14:00:00Z"); // Tue Oct 13, 10:00 EDT

  it("formatForChat examples: lowercase, no leading zero", () => {
    expect(formatForChat(new Date("2026-10-14T03:59:00Z"), NY, now)).toBe("today 11:59pm");
    expect(formatForChat(new Date("2026-10-14T13:00:00Z"), NY, now)).toBe("tmrw 9am");
    expect(formatForChat(new Date("2026-10-16T03:59:00Z"), NY, now)).toBe("Thu 11:59pm");
    expect(formatForChat(new Date("2026-10-15T16:00:00Z"), NY, now, { allDay: true })).toBe("Thu Oct 15");
    expect(formatForChat(new Date("2026-10-14T16:00:00Z"), NY, now, { allDay: true })).toBe("tmrw");
    expect(formatForChat(new Date("2026-10-30T13:00:00Z"), NY, now)).toBe("Fri Oct 30");
    expect(formatForChat(new Date("2026-10-13T13:05:00Z"), NY, now)).toBe("today 9:05am");
    expect(formatForChat(new Date("2026-10-13T16:00:00Z"), NY, now)).toBe("today 12pm");
    expect(formatForChat(new Date("2026-10-14T04:00:00Z"), NY, now)).toBe("tmrw 12am");
    expect(formatForChat(new Date("2026-10-12T21:00:00Z"), NY, now)).toBe("yesterday 5pm");
  });

  it("formatForChat renders UTC-stored items as local (V1 regression: 03:59Z Oct 13 = Mon 11:59pm)", () => {
    const sat = new Date("2026-10-10T16:00:00Z");
    expect(formatForChat(new Date("2026-10-13T03:59:00Z"), NY, sat)).toBe("Mon 11:59pm");
  });

  it("formatForChat adds the year only for far dates in another year", () => {
    expect(formatForChat(new Date("2027-03-02T15:00:00Z"), NY, now)).toBe("Tue Mar 2, 2027");
    const dec = new Date("2026-12-28T15:00:00Z");
    expect(formatForChat(new Date("2027-01-08T15:00:00Z"), NY, dec)).toBe("Fri Jan 8");
  });

  it("formatForTool is unambiguous", () => {
    expect(formatForTool(new Date("2026-10-14T01:00:00Z"), NY)).toBe("Tue Oct 13, 9:00 PM EDT");
    expect(formatForTool(new Date("2026-11-02T14:05:00Z"), NY)).toBe("Mon Nov 2, 9:05 AM EST");
    expect(formatForTool(new Date("2026-10-14T01:00:00Z"), "Asia/Kolkata")).toBe("Wed Oct 14, 6:30 AM GMT+5:30");
  });

  it("formatTimeRange (V2-07 slot labels)", () => {
    const sat = new Date("2026-10-10T16:00:00Z");
    expect(formatTimeRange(new Date("2026-10-14T20:00:00Z"), new Date("2026-10-14T21:30:00Z"), NY, sat)).toBe(
      "Wed Oct 14, 4–5:30pm",
    );
    const tue = new Date("2026-10-13T14:00:00Z");
    expect(formatTimeRange(new Date("2026-10-14T20:00:00Z"), new Date("2026-10-14T21:30:00Z"), NY, tue)).toBe(
      "tmrw 4–5:30pm",
    );
    expect(formatTimeRange(new Date("2026-10-13T15:00:00Z"), new Date("2026-10-13T16:30:00Z"), NY, tue)).toBe(
      "today 11am–12:30pm",
    );
    expect(formatTimeRange(new Date("2026-10-15T03:00:00Z"), new Date("2026-10-15T05:00:00Z"), NY, tue)).toBe(
      "tmrw 11pm–Thu 1am",
    );
  });
});
