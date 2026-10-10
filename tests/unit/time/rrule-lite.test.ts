/**
 * src/shared/time/rrule-lite.ts — RFC 5545 subset (V2-06 §10 rrule cases): DST-stable wall times,
 * BYMONTHDAY skipping, INTERVAL, COUNT/UNTIL, floating zone, round-trip, unsupported rules.
 */
import {
  describeRecurrence,
  nextOccurrence,
  parseRRuleString,
  toRRuleString,
  validateRecurrence,
  type RecurrenceSpec,
} from "@/shared/time/rrule-lite";

const NY = "America/New_York";
const LA = "America/Los_Angeles";

function spec(partial: Partial<RecurrenceSpec> & Pick<RecurrenceSpec, "freq">): RecurrenceSpec {
  return { dtstart: { year: 2026, month: 10, day: 12, hour: 9, minute: 0 }, interval: 1, ...partial };
}

/** Successive occurrences after `from` (ISO strings). */
function series(s: RecurrenceSpec, tz: string, from: string, n: number): (string | null)[] {
  const out: (string | null)[] = [];
  let after = new Date(from);
  for (let i = 0; i < n; i += 1) {
    const next = nextOccurrence(s, tz, after, i);
    out.push(next ? next.toISOString() : null);
    if (!next) break;
    after = next;
  }
  return out;
}

describe("nextOccurrence", () => {
  it("weekly MO,WE keeps 09:00 local across the Nov 1 fall-back (13:00Z → 14:00Z)", () => {
    const s = spec({ freq: "WEEKLY", byDay: ["MO", "WE"], dtstart: { year: 2026, month: 10, day: 26, hour: 9, minute: 0 } });
    expect(series(s, NY, "2026-10-25T00:00:00Z", 4)).toEqual([
      "2026-10-26T13:00:00.000Z",
      "2026-10-28T13:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
      "2026-11-04T14:00:00.000Z",
    ]);
  });

  it("daily 02:30 fires at 03:30 EDT on the spring-forward day, then 02:30 resumes", () => {
    const s = spec({ freq: "DAILY", dtstart: { year: 2026, month: 3, day: 7, hour: 2, minute: 30 } });
    expect(series(s, NY, "2026-03-07T00:00:00Z", 3)).toEqual([
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      "2026-03-08T07:30:00.000Z", // gap → 03:30 EDT
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
    ]);
  });

  it("monthly BYMONTHDAY=31 skips months without a 31st", () => {
    const s = spec({ freq: "MONTHLY", byMonthDay: 31, dtstart: { year: 2026, month: 10, day: 31, hour: 9, minute: 0 } });
    const got = series(s, NY, "2026-10-30T00:00:00Z", 4).map((x) => x?.slice(0, 10));
    expect(got).toEqual(["2026-10-31", "2026-12-31", "2027-01-31", "2027-03-31"]);
  });

  it("INTERVAL=2 weekly = every other Friday", () => {
    const s = spec({ freq: "WEEKLY", interval: 2, dtstart: { year: 2026, month: 10, day: 16, hour: 17, minute: 0 } });
    const got = series(s, NY, "2026-10-15T00:00:00Z", 3).map((x) => x?.slice(0, 10));
    expect(got).toEqual(["2026-10-16", "2026-10-30", "2026-11-13"]);
  });

  it("INTERVAL=3 daily from a long-ago start stays aligned to DTSTART", () => {
    const s = spec({ freq: "DAILY", interval: 3, dtstart: { year: 2025, month: 1, day: 1, hour: 8, minute: 0 } });
    // 2025-01-01 + 3k days; 2026-10-10 is day 647 → next aligned day is 648 = 2026-10-11.
    expect(nextOccurrence(s, NY, new Date("2026-10-10T15:00:00Z"), 0)?.toISOString()).toBe("2026-10-11T12:00:00.000Z");
  });

  it("COUNT is counted from DTSTART and exhausts to null", () => {
    const s = spec({ freq: "DAILY", count: 3 });
    expect(series(s, NY, "2026-10-11T00:00:00Z", 5)).toEqual([
      "2026-10-12T13:00:00.000Z",
      "2026-10-13T13:00:00.000Z",
      "2026-10-14T13:00:00.000Z",
      null,
    ]);
    // Missed occurrences still count (RFC): evaluated after the 3rd → nothing left.
    expect(nextOccurrence(s, NY, new Date("2026-10-20T00:00:00Z"), 0)).toBeNull();
    // firedCount reaching COUNT also ends it.
    expect(nextOccurrence(s, NY, new Date("2026-10-11T00:00:00Z"), 3)).toBeNull();
  });

  it("UNTIL is an inclusive local date", () => {
    const s = spec({ freq: "DAILY", dtstart: { year: 2026, month: 10, day: 18, hour: 21, minute: 0 }, until: { year: 2026, month: 10, day: 20 } });
    const got = series(s, NY, "2026-10-18T00:00:00Z", 5).map((x) => x?.slice(0, 13) ?? null);
    expect(got).toEqual(["2026-10-19T01", "2026-10-20T01", "2026-10-21T01", null]); // 21:00 EDT = 01:00Z next day
  });

  it("is floating: the same wall time in whichever zone is current", () => {
    const s = spec({ freq: "WEEKLY", byDay: ["MO"] });
    expect(nextOccurrence(s, NY, new Date("2026-10-11T00:00:00Z"), 0)?.toISOString()).toBe("2026-10-12T13:00:00.000Z");
    expect(nextOccurrence(s, LA, new Date("2026-10-11T00:00:00Z"), 0)?.toISOString()).toBe("2026-10-12T16:00:00.000Z");
  });

  it("DAILY with BYDAY = weekdays only", () => {
    const s = spec({ freq: "DAILY", byDay: ["MO", "TU", "WE", "TH", "FR"], dtstart: { year: 2026, month: 10, day: 9, hour: 8, minute: 30 } });
    const got = series(s, NY, "2026-10-09T13:00:00Z", 3).map((x) => x?.slice(0, 10));
    expect(got).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]); // Fri 8:30 already passed; skips the weekend
  });

  it("never returns an occurrence before DTSTART", () => {
    const s = spec({ freq: "WEEKLY", byDay: ["MO", "FR"], dtstart: { year: 2026, month: 10, day: 14, hour: 9, minute: 0 } });
    expect(nextOccurrence(s, NY, new Date("2026-10-01T00:00:00Z"), 0)?.toISOString().slice(0, 10)).toBe("2026-10-16");
  });
});

describe("serialize / parse", () => {
  it("round-trips", () => {
    const cases: RecurrenceSpec[] = [
      spec({ freq: "WEEKLY", byDay: ["WE", "MO"] }),
      spec({ freq: "DAILY", interval: 2, count: 10 }),
      spec({ freq: "MONTHLY", byMonthDay: 1, until: { year: 2027, month: 5, day: 1 } }),
    ];
    for (const c of cases) {
      const text = toRRuleString(c);
      const back = parseRRuleString(text);
      expect(toRRuleString(back)).toBe(text);
    }
    expect(toRRuleString(spec({ freq: "WEEKLY", byDay: ["WE", "MO"] }))).toBe("DTSTART:20261012T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE");
  });

  it("parses CRLF and INTERVAL/UNTIL forms", () => {
    const s = parseRRuleString("DTSTART:20261012T083000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20261231");
    expect(s).toMatchObject({ freq: "WEEKLY", interval: 2, byDay: ["FR"], until: { year: 2026, month: 12, day: 31 } });
    expect(s.dtstart).toEqual({ year: 2026, month: 10, day: 12, hour: 8, minute: 30 });
  });

  it.each([
    ["DTSTART:20261012T090000\nRRULE:FREQ=HOURLY", /FREQ=HOURLY/],
    ["DTSTART:20261012T090000\nRRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1", /BYSETPOS|byDay/],
    ["DTSTART;TZID=America/New_York:20261012T090000\nRRULE:FREQ=DAILY", /unsupported line/],
    ["DTSTART:20261012T090000\nRRULE:FREQ=MONTHLY;BYDAY=1MO", /BYDAY/],
    ["DTSTART:20261012T090000Z\nRRULE:FREQ=DAILY", /DTSTART/],
    ["DTSTART:20261012T090000\nRRULE:FREQ=DAILY;COUNT=2;UNTIL=20261231", /either count or until/],
    ["RRULE:FREQ=DAILY", /DTSTART/],
  ])("rejects %j", (text, re) => {
    expect(() => parseRRuleString(text)).toThrow(re);
  });
});

describe("validateRecurrence", () => {
  it("accepts the supported subset", () => {
    expect(validateRecurrence(spec({ freq: "MONTHLY", byMonthDay: 15 }))).toBeNull();
  });
  it.each<[Partial<RecurrenceSpec> & Pick<RecurrenceSpec, "freq">, RegExp]>([
    [{ freq: "DAILY", interval: 13 }, /interval/],
    [{ freq: "WEEKLY", byMonthDay: 3 }, /byMonthDay/],
    [{ freq: "MONTHLY", byDay: ["MO"] }, /byDay/],
    [{ freq: "DAILY", count: 2, until: { year: 2026, month: 12, day: 1 } }, /either count or until/],
    [{ freq: "DAILY", until: { year: 2026, month: 10, day: 1 } }, /before the first/],
    [{ freq: "DAILY", count: 400 }, /count/],
    [{ freq: "DAILY", dtstart: { year: 2026, month: 2, day: 30, hour: 9, minute: 0 } }, /start date/],
  ])("rejects %j", (partial, re) => {
    expect(validateRecurrence(spec(partial))).toMatch(re);
  });
});

describe("describeRecurrence", () => {
  it.each<[Partial<RecurrenceSpec> & Pick<RecurrenceSpec, "freq">, string]>([
    [{ freq: "WEEKLY", byDay: ["MO", "WE"] }, "every Mon & Wed at 9am"],
    [{ freq: "WEEKLY", byDay: ["MO", "TU", "WE", "TH", "FR"], dtstart: { year: 2026, month: 10, day: 12, hour: 8, minute: 30 } }, "every weekday at 8:30am"],
    [{ freq: "WEEKLY", interval: 2, byDay: ["FR"], dtstart: { year: 2026, month: 10, day: 16, hour: 17, minute: 0 } }, "every other Fri at 5pm"],
    [{ freq: "MONTHLY", byMonthDay: 1 }, "the 1st of every month at 9am"],
    [{ freq: "DAILY", dtstart: { year: 2026, month: 10, day: 12, hour: 22, minute: 0 } }, "every day at 10pm"],
    [{ freq: "DAILY", count: 5 }, "every day at 9am (5 times)"],
    [{ freq: "MONTHLY", byMonthDay: 22, until: { year: 2027, month: 3, day: 1 } }, "the 22nd of every month at 9am until Mar 1"],
  ])("%j → %s", (partial, text) => {
    expect(describeRecurrence(spec(partial))).toBe(text);
  });
});
