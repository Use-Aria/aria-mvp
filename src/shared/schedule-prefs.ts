/**
 * Briefing time and quiet-hours options for /setup (web plan §7.3, copy deck §9.2).
 * Pure and client-safe. DB `time` columns come back as "HH:MM:SS"; the form works in "HH:MM".
 */
import { z } from "zod";
import { isInDailyWindow, parseHHMM } from "@/shared/time/tz";

/** A `<select>` option. */
export interface ClockOption {
  value: string;
  label: string;
}

/** Value for "Don't send a briefing". */
export const BRIEFING_OFF = "off";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * "07:30" → "7:30 AM"; also accepts "07:30:00".
 * @param hhmm wall-clock time
 * @returns 12-hour clock text
 */
export function formatClock(hhmm: string): string {
  const t = parseHHMM(hhmm);
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h12}:${pad2(t.minute)} ${t.hour < 12 ? "AM" : "PM"}`;
}

/**
 * Normalizes a DB `time` value to "HH:MM".
 * @param value "8:00", "08:00:00", …
 * @returns "08:00"; throws RangeError on garbage
 */
export function toHHMM(value: string): string {
  const t = parseHHMM(value);
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

function clockOptions(hours: number[], stepMinutes: 30 | 60, through?: string): ClockOption[] {
  const out: ClockOption[] = [];
  for (const h of hours) {
    for (let m = 0; m < 60; m += stepMinutes) {
      const value = `${pad2(h)}:${pad2(m)}`;
      out.push({ value, label: formatClock(value) });
      if (value === through) return out;
    }
  }
  return out;
}

/** Briefing times 7:00 AM–12:00 PM every 30 minutes, plus "off". */
export const BRIEFING_OPTIONS: readonly ClockOption[] = [
  ...clockOptions([7, 8, 9, 10, 11, 12], 30, "12:00"),
  { value: BRIEFING_OFF, label: "Don't send a briefing" },
];

/** Quiet hours start: 9 PM–1 AM, hourly. */
export const QUIET_START_OPTIONS: readonly ClockOption[] = clockOptions([21, 22, 23, 0, 1], 60);

/** Quiet hours end: 6 AM–11 AM, hourly. */
export const QUIET_END_OPTIONS: readonly ClockOption[] = clockOptions([6, 7, 8, 9, 10, 11], 60);

/** Defaults (web plan §13 Q3). */
export const DEFAULT_SCHEDULE = { briefing: "08:00", quietStart: "22:00", quietEnd: "08:00" } as const;

function oneOf(options: readonly ClockOption[]) {
  const values = options.map((o) => o.value);
  return z.string().refine((v) => values.includes(v), { message: "not an offered option" });
}

/** Form input for the schedule action; rejects any value that isn't an offered option. */
export const SchedulePrefsInput = z.object({
  briefing: oneOf(BRIEFING_OPTIONS),
  quietStart: oneOf(QUIET_START_OPTIONS),
  quietEnd: oneOf(QUIET_END_OPTIONS),
});
export type SchedulePrefsInput = z.infer<typeof SchedulePrefsInput>;

/**
 * Whether the briefing time falls inside quiet hours (the window may wrap midnight;
 * start inclusive, end exclusive, same as `deliver()`'s guard).
 * @param briefing "HH:MM" (or "off", which is never inside)
 * @param quietStart "HH:MM"
 * @param quietEnd "HH:MM"
 * @returns true when the briefing would be deferred to `quietEnd`
 */
export function briefingInQuietHours(briefing: string, quietStart: string, quietEnd: string): boolean {
  if (briefing === BRIEFING_OFF) return false;
  return isInDailyWindow(parseHHMM(briefing), parseHHMM(quietStart), parseHHMM(quietEnd));
}

/**
 * Human name of a time zone, e.g. "Eastern Time" (falls back to the IANA id).
 * @param timeZone IANA zone
 * @param at instant used to resolve the name
 * @returns display label
 */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}
