/**
 * Slot engine (task 4.2; V2-07 §2.7, §10 `slots.test.ts`, 07a-5): the 14 core cases plus slot-id
 * round trips. Pure: every instant comes from the query; times are America/New_York unless noted.
 */
import {
  alignUp,
  allowedIntervalsForDay,
  findFreeSlots,
  findGaps,
  mergeIntervals,
  parseSlotId,
  slotIdFor,
  type Interval,
  type SlotQuery,
} from "@/server/integrations/google/calendar/slots";
import { parseLocalDate, parseLocalDateTime, toLocal, weekdayOf, zonedToUtc } from "@/shared/time/tz";

const TZ = "America/New_York";
const MIN = 60_000;

/** Local wall time → instant. */
function L(date: string, hhmm: string, tz = TZ): Date {
  const dt = parseLocalDateTime(`${date}T${hhmm}`);
  if (!dt) throw new Error(`bad local time ${date} ${hhmm}`);
  return zonedToUtc(dt, tz).instant;
}

function iv(date: string, from: string, to: string): Interval {
  return { start: L(date, from), end: L(date, to) };
}

function q(over: Partial<SlotQuery> = {}): SlotQuery {
  return {
    now: L("2026-10-14", "06:00"),
    tz: TZ,
    windowStart: L("2026-10-14", "00:00"),
    windowEnd: L("2026-10-15", "00:00"),
    durationMin: 60,
    busy: [],
    constraints: [],
    waking: { start: "08:00", end: "23:00" },
    bufferMin: 0,
    leadMin: 15,
    granularityMin: 15,
    maxResults: 5,
    ...over,
  };
}

/** "HH:MM" local start of each candidate. */
function hhmm(d: Date, tz = TZ): string {
  const l = toLocal(d, tz);
  return `${String(l.hour).padStart(2, "0")}:${String(l.minute).padStart(2, "0")}`;
}

function localDay(d: Date): string {
  const l = toLocal(d, TZ);
  return `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
}

describe("findFreeSlots — the 14 V2-07 cases", () => {
  it("(1) V1 parity: gaps between busy blocks, and no candidate overlaps busy time", () => {
    const allowed = iv("2026-10-14", "09:00", "17:00");
    const busy = [iv("2026-10-14", "13:00", "14:30"), iv("2026-10-14", "10:00", "11:00")];
    expect(findGaps(allowed, busy, 60)).toEqual([
      iv("2026-10-14", "09:00", "10:00"),
      iv("2026-10-14", "11:00", "13:00"),
      iv("2026-10-14", "14:30", "17:00"),
    ]);
    // busy clipped to the window; a gap shorter than the duration is skipped
    expect(findGaps(allowed, [iv("2026-10-14", "07:00", "09:30"), iv("2026-10-14", "10:00", "16:30")], 30)).toEqual([
      iv("2026-10-14", "09:30", "10:00"),
      iv("2026-10-14", "16:30", "17:00"),
    ]);

    const r = findFreeSlots(q({ busy }));
    expect(r.candidates.length).toBeGreaterThanOrEqual(3);
    for (const c of r.candidates) {
      expect(busy.some((b) => c.start < b.end && c.end > b.start)).toBe(false);
      expect(c.end.getTime() - c.start.getTime()).toBe(60 * MIN);
    }
  });

  it("(2) past-time filter: now=14:07 → nothing before 14:30 (15-min lead + grid)", () => {
    const r = findFreeSlots(q({ now: L("2026-10-14", "14:07") }));
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c) => c.start >= L("2026-10-14", "14:30"))).toBe(true);
    expect(r.candidates.map((c) => hhmm(c.start))).toContain("14:30");
  });

  it("(3) buffers: a 10-min pad around busy shrinks gaps", () => {
    const base = q({
      waking: { start: "09:00", end: "12:00" },
      busy: [iv("2026-10-14", "10:00", "11:00")],
    });
    expect(findFreeSlots({ ...base, bufferMin: 0 }).candidates.map((c) => hhmm(c.start))).toEqual(["09:00", "11:00"]);
    const padded = findFreeSlots({ ...base, bufferMin: 10 });
    expect(padded.candidates).toEqual([]);
    // a buffer_minutes constraint overrides the default buffer
    const override = findFreeSlots({ ...base, bufferMin: 10, constraints: [{ type: "buffer_minutes", minutes: 0 }] });
    expect(override.candidates.map((c) => hhmm(c.start))).toEqual(["09:00", "11:00"]);
  });

  it("(4) not_after 20:00 excludes a 19:30–20:30 slot", () => {
    const busy = [iv("2026-10-14", "08:00", "19:30")];
    const free = findFreeSlots(q({ busy, granularityMin: 30 }));
    expect(free.candidates.map((c) => hhmm(c.start))).toContain("19:30");
    const r = findFreeSlots(q({ busy, granularityMin: 30, constraints: [{ type: "not_after", time: "20:00" }] }));
    expect(r.candidates).toEqual([]);
    const early = findFreeSlots(q({ busy: [iv("2026-10-14", "08:00", "19:00")], granularityMin: 30, constraints: [{ type: "not_after", time: "20:00" }] }));
    expect(early.candidates.map((c) => hhmm(c.start))).toEqual(["19:00"]);
    expect(early.candidates.every((c) => c.end <= L("2026-10-14", "20:00"))).toBe(true);
    // `days` limits it: Wednesday rule doesn't apply on a Thursday window
    const thu = findFreeSlots(
      q({
        windowStart: L("2026-10-15", "00:00"),
        windowEnd: L("2026-10-16", "00:00"),
        busy: [iv("2026-10-15", "08:00", "19:30")],
        granularityMin: 30,
        constraints: [{ type: "not_after", time: "20:00", days: ["WE"] }],
      }),
    );
    expect(thu.candidates.map((c) => hhmm(c.start))).toContain("19:30");
  });

  it("(5) not_before, avoid_range (lunch), avoid_days weekend, only_days", () => {
    const nb = findFreeSlots(q({ constraints: [{ type: "not_before", time: "10:00" }] }));
    expect(nb.candidates.length).toBeGreaterThan(0);
    expect(nb.candidates.every((c) => c.start >= L("2026-10-14", "10:00"))).toBe(true);

    const lunch = findFreeSlots(
      q({ waking: { start: "11:00", end: "14:00" }, constraints: [{ type: "avoid_range", start: "12:00", end: "13:00" }] }),
    );
    expect(lunch.candidates.map((c) => hhmm(c.start))).toEqual(["11:00", "13:00"]);

    const weekendWindow = { windowStart: L("2026-10-16", "00:00"), windowEnd: L("2026-10-20", "00:00"), now: L("2026-10-16", "06:00") };
    const noWeekend = findFreeSlots(q({ ...weekendWindow, constraints: [{ type: "avoid_days", days: ["SA", "SU"] }] }));
    expect(noWeekend.candidates.length).toBeGreaterThan(0);
    for (const c of noWeekend.candidates) expect(["SA", "SU"]).not.toContain(toLocal(c.start, TZ).weekday);

    const only = findFreeSlots(q({ ...weekendWindow, constraints: [{ type: "only_days", days: ["MO"] }] }));
    expect(only.candidates.length).toBeGreaterThan(0);
    for (const c of only.candidates) expect(toLocal(c.start, TZ).weekday).toBe("MO");
  });

  it("(6) waking hours: default 08:00–23:00, and an override that crosses midnight (09:00–01:00)", () => {
    const night = { windowStart: L("2026-10-14", "22:00"), windowEnd: L("2026-10-15", "02:00") };
    const def = findFreeSlots(q(night));
    expect(def.candidates.map((c) => hhmm(c.start))).toEqual(["22:00"]);
    expect(def.candidates.every((c) => c.end <= L("2026-10-14", "23:00"))).toBe(true);

    const late = findFreeSlots(q({ ...night, waking: { start: "09:00", end: "01:00" } }));
    expect(late.candidates.map((c) => c.start.toISOString())).toContain(L("2026-10-15", "00:00").toISOString());
    expect(late.candidates.every((c) => c.end <= L("2026-10-15", "01:00"))).toBe(true);

    const day = findFreeSlots(q());
    expect(day.candidates.every((c) => c.start >= L("2026-10-14", "08:00") && c.end <= L("2026-10-14", "23:00"))).toBe(true);
  });

  it("(7) spread: a roomy 3-day window → ≥3 distinct days, none within 2h on the same day", () => {
    const r = findFreeSlots(q({ windowEnd: L("2026-10-17", "00:00"), maxResults: 5 }));
    expect(r.candidates).toHaveLength(5);
    expect(new Set(r.candidates.map((c) => localDay(c.start))).size).toBeGreaterThanOrEqual(3);
    for (const a of r.candidates) {
      for (const b of r.candidates) {
        if (a !== b && localDay(a.start) === localDay(b.start)) {
          expect(Math.abs(a.start.getTime() - b.start.getTime())).toBeGreaterThanOrEqual(120 * MIN);
        }
      }
    }
    // chronological output
    const starts = r.candidates.map((c) => c.start.getTime());
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
  });

  it("(8) part_of_day evening ranks evening first; around 16:00 picks 16:00 when free", () => {
    const evening = findFreeSlots(q({ maxResults: 3, preferred: { partOfDay: ["evening"] } }));
    expect(evening.candidates).toHaveLength(3);
    expect(evening.candidates.every((c) => toLocal(c.start, TZ).hour >= 17)).toBe(true);
    expect(evening.candidates[0]?.why).toContain("evening");

    const around = findFreeSlots(q({ windowEnd: L("2026-10-16", "00:00"), preferred: { around: "16:00" } }));
    const first = around.candidates.find((c) => localDay(c.start) === "2026-10-14" && hhmm(c.start) === "16:00");
    expect(first).toBeDefined();
    expect(first?.why).toContain("right at 4pm");
  });

  it("(9) the earliest gap isn't automatically picked (no 8am default for everyone)", () => {
    const r = findFreeSlots(q({ maxResults: 3, busy: [iv("2026-10-14", "09:00", "13:00")] }));
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates.map((c) => hhmm(c.start))).not.toContain("08:00");
    expect(hhmm(r.candidates[0]?.start as Date)).toBe("13:00");
  });

  it("(10) DST fall-back day (2026-11-01): a 90-min slot at 01:00 local has the right UTC length", () => {
    const r = findFreeSlots(
      q({
        now: L("2026-10-31", "20:00"),
        windowStart: L("2026-11-01", "00:30"),
        windowEnd: L("2026-11-01", "03:00"),
        waking: { start: "09:00", end: "03:00" },
        durationMin: 90,
        preferred: { around: "01:00" },
      }),
    );
    const one = r.candidates.find((c) => c.start.toISOString() === "2026-11-01T05:00:00.000Z"); // 01:00 EDT
    expect(one).toBeDefined();
    expect(one?.end.toISOString()).toBe("2026-11-01T06:30:00.000Z"); // 01:30 EST
    expect(one?.label).toContain("1–1:30am");
    for (const c of r.candidates) expect(c.end.getTime() - c.start.getTime()).toBe(90 * MIN);
    // the window really is 3.5h long (an extra hour on fall-back): local-date iteration, not 24h days
    expect(L("2026-11-01", "03:00").getTime() - L("2026-11-01", "00:30").getTime()).toBe(210 * MIN);
  });

  it("(11) fewer than 3 slots → notes populated", () => {
    const r = findFreeSlots(
      q({ busy: [iv("2026-10-14", "08:00", "12:00"), iv("2026-10-14", "13:00", "23:00")], constraints: [{ type: "not_after", time: "22:00" }] }),
    );
    expect(r.candidates.map((c) => hhmm(c.start))).toEqual(["12:00"]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^only 1 slot fit/);
    expect(r.notes[0]).toContain("not after 10pm");
  });

  it("(12) duration longer than any gap → empty + note", () => {
    const r = findFreeSlots(q({ durationMin: 120, busy: [iv("2026-10-14", "09:30", "11:00"), iv("2026-10-14", "12:30", "23:00")] }));
    expect(r.candidates).toEqual([]);
    expect(r.notes[0]).toMatch(/^no 120-minute opening fits/);
  });

  it("(13) overlapping / unsorted busy input is merged", () => {
    const merged = mergeIntervals(
      [iv("2026-10-14", "10:00", "11:00"), iv("2026-10-14", "13:00", "14:00"), iv("2026-10-14", "09:00", "10:30"), iv("2026-10-14", "10:45", "12:00")],
      0,
    );
    expect(merged).toEqual([iv("2026-10-14", "09:00", "12:00"), iv("2026-10-14", "13:00", "14:00")]);
    // touching intervals merge; padding expands both sides; inverted intervals are dropped
    expect(mergeIntervals([iv("2026-10-14", "09:00", "10:00"), iv("2026-10-14", "10:00", "11:00")], 0)).toEqual([iv("2026-10-14", "09:00", "11:00")]);
    expect(mergeIntervals([iv("2026-10-14", "09:00", "10:00"), iv("2026-10-14", "10:15", "11:00")], 10)).toEqual([iv("2026-10-14", "08:50", "11:10")]);
    expect(mergeIntervals([{ start: L("2026-10-14", "10:00"), end: L("2026-10-14", "09:00") }], 0)).toEqual([]);
    // the engine gives the same answer for scrambled input
    const busy = [iv("2026-10-14", "13:00", "14:00"), iv("2026-10-14", "09:00", "10:30"), iv("2026-10-14", "10:00", "12:00")];
    const a = findFreeSlots(q({ busy }));
    const b = findFreeSlots(q({ busy: [...busy].reverse() }));
    expect(a).toEqual(b);
  });

  it("(14) granularity alignment (local grid, also in a half-hour zone)", () => {
    const now = L("2026-10-14", "09:07");
    expect(hhmm(findFreeSlots(q({ now, leadMin: 0, waking: { start: "08:00", end: "11:00" } })).candidates[0]?.start as Date)).toBe("09:15");
    const r30 = findFreeSlots(q({ now, leadMin: 0, granularityMin: 30, waking: { start: "08:00", end: "12:00" } }));
    expect(r30.candidates.every((c) => toLocal(c.start, TZ).minute % 30 === 0)).toBe(true);
    expect(hhmm(r30.candidates[0]?.start as Date)).toBe("09:30");

    // Asia/Kolkata (+05:30): the grid is local :00/:30, not UTC :00/:30
    const k = "Asia/Kolkata";
    const t = L("2026-10-14", "10:10", k);
    expect(hhmm(alignUp(t, 30, k), k)).toBe("10:30");
    expect(alignUp(L("2026-10-14", "10:30", k), 30, k).toISOString()).toBe(L("2026-10-14", "10:30", k).toISOString());
  });
});

describe("allowedIntervalsForDay", () => {
  it("is waking ∩ window ∩ lead, minus constraints", () => {
    const query = q({ now: L("2026-10-14", "10:50"), constraints: [{ type: "avoid_range", start: "12:00", end: "13:00" }] });
    const d = parseLocalDate("2026-10-14");
    if (!d) throw new Error("date");
    expect(weekdayOf(d)).toBe("WE");
    expect(allowedIntervalsForDay(d, query)).toEqual([
      { start: L("2026-10-14", "11:05"), end: L("2026-10-14", "12:00") },
      { start: L("2026-10-14", "13:00"), end: L("2026-10-14", "23:00") },
    ]);
  });
});

describe("findFreeSlots determinism + window cap", () => {
  it("returns the same candidates for the same query and caps the window at 14 days", () => {
    const query = q({ windowEnd: L("2026-11-30", "00:00"), maxResults: 5 });
    expect(findFreeSlots(query)).toEqual(findFreeSlots(query));
    for (const c of findFreeSlots(query).candidates) expect(c.start < L("2026-10-28", "00:00")).toBe(true);
  });
});

describe("slot ids", () => {
  it("round-trip exact instants and reject anything else", () => {
    const slot = iv("2026-10-14", "16:00", "17:30");
    const id = slotIdFor(slot);
    expect(id).toBe("slot|2026-10-14T20:00:00.000Z|2026-10-14T21:30:00.000Z");
    expect(parseSlotId(id)).toEqual(slot);
    expect(parseSlotId("2026-10-14T20:00:00.000Z")).toBeNull();
    expect(parseSlotId("slot|2026-10-14T21:30:00.000Z|2026-10-14T20:00:00.000Z")).toBeNull();
    expect(parseSlotId("slot|nope|nope")).toBeNull();
    expect(parseSlotId("11111111-1111-4111-8111-111111111111")).toBeNull();
  });
});
