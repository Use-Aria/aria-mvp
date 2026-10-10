/** Briefing and quiet-hours options (web plan §10 schedule-prefs.test). */
import {
  BRIEFING_OFF,
  BRIEFING_OPTIONS,
  QUIET_END_OPTIONS,
  QUIET_START_OPTIONS,
  SchedulePrefsInput,
  briefingInQuietHours,
  formatClock,
  timeZoneLabel,
  toHHMM,
} from "@/shared/schedule-prefs";

describe("option lists", () => {
  it("briefing: 7:00 AM–12:00 PM every 30 min, then off", () => {
    const values = BRIEFING_OPTIONS.map((o) => o.value);
    expect(values[0]).toBe("07:00");
    expect(values).toContain("11:30");
    expect(values.at(-2)).toBe("12:00");
    expect(values.at(-1)).toBe(BRIEFING_OFF);
    expect(values).toHaveLength(12);
    expect(BRIEFING_OPTIONS[0].label).toBe("7:00 AM");
  });

  it("quiet start 9 PM–1 AM and end 6–11 AM, hourly", () => {
    expect(QUIET_START_OPTIONS.map((o) => o.value)).toEqual(["21:00", "22:00", "23:00", "00:00", "01:00"]);
    expect(QUIET_END_OPTIONS.map((o) => o.value)).toEqual(["06:00", "07:00", "08:00", "09:00", "10:00", "11:00"]);
    expect(QUIET_START_OPTIONS[3].label).toBe("12:00 AM");
  });
});

describe("briefingInQuietHours", () => {
  it("wrapping window 22:00–08:00", () => {
    expect(briefingInQuietHours("07:30", "22:00", "08:00")).toBe(true);
    expect(briefingInQuietHours("08:00", "22:00", "08:00")).toBe(false);
    expect(briefingInQuietHours("09:00", "22:00", "08:00")).toBe(false);
  });

  it("window starting after midnight 01:00–06:00", () => {
    expect(briefingInQuietHours("07:00", "01:00", "06:00")).toBe(false);
    expect(briefingInQuietHours("05:30", "01:00", "06:00")).toBe(true);
  });

  it("non-wrapping and off", () => {
    expect(briefingInQuietHours("09:30", "09:00", "11:00")).toBe(true);
    expect(briefingInQuietHours("11:00", "09:00", "11:00")).toBe(false);
    expect(briefingInQuietHours(BRIEFING_OFF, "22:00", "08:00")).toBe(false);
  });
});

describe("SchedulePrefsInput", () => {
  it("accepts offered values and rejects others", () => {
    expect(SchedulePrefsInput.safeParse({ briefing: "08:30", quietStart: "22:00", quietEnd: "08:00" }).success).toBe(true);
    expect(SchedulePrefsInput.safeParse({ briefing: "off", quietStart: "00:00", quietEnd: "06:00" }).success).toBe(true);
    for (const bad of [
      { briefing: "06:30", quietStart: "22:00", quietEnd: "08:00" },
      { briefing: "08:15", quietStart: "22:00", quietEnd: "08:00" },
      { briefing: "08:00", quietStart: "20:00", quietEnd: "08:00" },
      { briefing: "08:00", quietStart: "22:00", quietEnd: "12:00" },
      { briefing: "08:00", quietStart: "22:00" },
    ]) {
      expect(SchedulePrefsInput.safeParse(bad).success).toBe(false);
    }
  });
});

describe("formatting", () => {
  it("formatClock and toHHMM", () => {
    expect(formatClock("00:00")).toBe("12:00 AM");
    expect(formatClock("12:30")).toBe("12:30 PM");
    expect(formatClock("21:00:00")).toBe("9:00 PM");
    expect(toHHMM("8:00:00")).toBe("08:00");
    expect(() => toHHMM("25:00")).toThrow();
  });

  it("timeZoneLabel", () => {
    expect(timeZoneLabel("America/New_York")).toBe("Eastern Time");
    expect(timeZoneLabel("Not/AZone")).toBe("Not/AZone");
  });
});
