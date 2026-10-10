/**
 * A tiny RFC 5545 recurrence subset (V2-06 §2.2). Pure, client-safe, `Intl` only via `tz.ts`.
 *
 * Supported: `FREQ=DAILY|WEEKLY|MONTHLY`, `INTERVAL` 1–12, `BYDAY` (plain weekdays, no ordinals;
 * DAILY/WEEKLY), `BYMONTHDAY` (one value 1–31, MONTHLY; months without that day are skipped, per
 * RFC 5545), `COUNT` 1–365 **or** `UNTIL` (inclusive local date). Weeks start on Monday (WKST=MO).
 *
 * `DTSTART` is **floating** (no TZID): the wall-clock time is evaluated in the user's *current*
 * zone at compute time, so a recurring reminder follows a timezone change and stays at the same
 * local time across DST (a wall time inside a spring-forward gap shifts forward, per `zonedToUtc`).
 *
 * Stored form (`reminders.rrule`): `DTSTART:20261012T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE`.
 * The model never writes this text; code serializes a structured `RecurrenceSpec`.
 */
import {
  addLocalDays,
  compareLocalDate,
  localDateOf,
  weekdayOf,
  zonedToUtc,
  type LocalDate,
  type LocalDateTime,
  type Weekday,
} from "@/shared/time/tz";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY";

/** Structured recurrence (what tools and the DB layer pass around). */
export interface RecurrenceSpec {
  /** floating first occurrence / time of day */
  dtstart: LocalDateTime;
  freq: Freq;
  /** 1..12 */
  interval: number;
  /** WEEKLY (or a DAILY filter) */
  byDay?: Weekday[];
  /** MONTHLY, 1..31 */
  byMonthDay?: number;
  /** 1..365 (total occurrences counted from DTSTART) */
  count?: number;
  /** inclusive, local */
  until?: LocalDate;
}

const WEEK_ORDER: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_NAME: Record<Weekday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};
const MONTH_SHORT: readonly string[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAY_MS = 86_400_000;
/** Periods scanned past the starting period before giving up (e.g. BYMONTHDAY=31 + INTERVAL=12 from Feb). */
const MAX_PERIODS = 1_000;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function epochDay(d: LocalDate): number {
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / DAY_MS);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isRealDate(d: LocalDate): boolean {
  return (
    Number.isInteger(d.year) &&
    Number.isInteger(d.month) &&
    Number.isInteger(d.day) &&
    d.month >= 1 &&
    d.month <= 12 &&
    d.day >= 1 &&
    d.day <= daysInMonth(d.year, d.month)
  );
}

function sortedDays(days: readonly Weekday[]): Weekday[] {
  return WEEK_ORDER.filter((w) => days.includes(w));
}

/** Monday of the week containing `d`. */
function mondayOf(d: LocalDate): LocalDate {
  return addLocalDays(d, -WEEK_ORDER.indexOf(weekdayOf(d)));
}

/**
 * Validate a recurrence against the supported subset.
 * @param spec candidate recurrence
 * @returns a short, model-readable error message, or null when valid
 */
export function validateRecurrence(spec: RecurrenceSpec): string | null {
  const s = spec.dtstart;
  if (!isRealDate(s)) return "invalid start date";
  if (!Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23 || !Number.isInteger(s.minute) || s.minute < 0 || s.minute > 59) {
    return "invalid start time";
  }
  if (spec.freq !== "DAILY" && spec.freq !== "WEEKLY" && spec.freq !== "MONTHLY") {
    return "keep it simple: daily, weekly or monthly";
  }
  if (!Number.isInteger(spec.interval) || spec.interval < 1 || spec.interval > 12) return "interval must be 1–12";
  if (spec.byDay !== undefined) {
    if (spec.freq === "MONTHLY") return "byDay only works with daily or weekly";
    if (spec.byDay.length === 0 || spec.byDay.length > 7) return "byDay needs 1–7 weekdays";
    if (new Set(spec.byDay).size !== spec.byDay.length) return "byDay has duplicate weekdays";
    if (spec.byDay.some((d) => !WEEK_ORDER.includes(d))) return "byDay has an unknown weekday";
  }
  if (spec.byMonthDay !== undefined) {
    if (spec.freq !== "MONTHLY") return "byMonthDay only works with monthly";
    if (!Number.isInteger(spec.byMonthDay) || spec.byMonthDay < 1 || spec.byMonthDay > 31) return "byMonthDay must be 1–31";
  }
  if (spec.count !== undefined && spec.until !== undefined) return "use either count or until, not both";
  if (spec.count !== undefined && (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 365)) {
    return "count must be 1–365";
  }
  if (spec.until !== undefined) {
    if (!isRealDate(spec.until)) return "invalid until date";
    if (compareLocalDate(spec.until, s) < 0) return "until is before the first occurrence";
  }
  return null;
}

/**
 * Serialize to the stored RFC 5545 text (floating DTSTART + RRULE).
 * @param spec a valid recurrence
 * @returns e.g. "DTSTART:20261012T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE"
 */
export function toRRuleString(spec: RecurrenceSpec): string {
  const s = spec.dtstart;
  const dt = `${pad(s.year, 4)}${pad(s.month)}${pad(s.day)}T${pad(s.hour)}${pad(s.minute)}00`;
  const parts = [`FREQ=${spec.freq}`];
  if (spec.interval > 1) parts.push(`INTERVAL=${spec.interval}`);
  if (spec.byDay?.length) parts.push(`BYDAY=${sortedDays(spec.byDay).join(",")}`);
  if (spec.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${spec.byMonthDay}`);
  if (spec.count !== undefined) parts.push(`COUNT=${spec.count}`);
  if (spec.until) parts.push(`UNTIL=${pad(spec.until.year, 4)}${pad(spec.until.month)}${pad(spec.until.day)}T235959`);
  return `DTSTART:${dt}\nRRULE:${parts.join(";")}`;
}

function parseDateTimeValue(v: string): LocalDateTime {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (!m) throw new Error(`unsupported DTSTART value "${v}" (floating local date-time only)`);
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
}

function parseUntilValue(v: string): LocalDate {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T\d{6})?$/.exec(v);
  if (!m) throw new Error(`unsupported UNTIL value "${v}"`);
  return { year: +m[1], month: +m[2], day: +m[3] };
}

/**
 * Parse the stored text back into a spec.
 * @param s "DTSTART:...\nRRULE:..." (CRLF tolerated)
 * @returns the recurrence
 * @throws Error on anything outside the supported subset (TZID, HOURLY, BYSETPOS, ordinals, …)
 */
export function parseRRuleString(s: string): RecurrenceSpec {
  let dtstart: LocalDateTime | null = null;
  let rule: string | null = null;
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("DTSTART:")) dtstart = parseDateTimeValue(line.slice(8));
    else if (line.startsWith("RRULE:")) rule = line.slice(6);
    else throw new Error(`unsupported line "${line.split(":")[0]}"`);
  }
  if (!dtstart) throw new Error("missing DTSTART");
  if (!rule) throw new Error("missing RRULE");

  const spec: RecurrenceSpec = { dtstart, freq: "DAILY", interval: 1 };
  let freqSeen = false;
  for (const part of rule.split(";")) {
    const [key, value] = part.split("=");
    if (!key || value === undefined) throw new Error(`malformed RRULE part "${part}"`);
    switch (key) {
      case "FREQ":
        if (value !== "DAILY" && value !== "WEEKLY" && value !== "MONTHLY") throw new Error(`unsupported FREQ=${value}`);
        spec.freq = value;
        freqSeen = true;
        break;
      case "INTERVAL":
        if (!/^\d+$/.test(value)) throw new Error(`bad INTERVAL=${value}`);
        spec.interval = Number(value);
        break;
      case "BYDAY": {
        const days = value.split(",");
        for (const d of days) {
          if (!WEEK_ORDER.includes(d as Weekday)) throw new Error(`unsupported BYDAY value "${d}"`);
        }
        spec.byDay = days as Weekday[];
        break;
      }
      case "BYMONTHDAY":
        if (!/^\d+$/.test(value)) throw new Error(`unsupported BYMONTHDAY=${value}`);
        spec.byMonthDay = Number(value);
        break;
      case "COUNT":
        if (!/^\d+$/.test(value)) throw new Error(`bad COUNT=${value}`);
        spec.count = Number(value);
        break;
      case "UNTIL":
        spec.until = parseUntilValue(value);
        break;
      case "WKST":
        if (value !== "MO") throw new Error(`unsupported WKST=${value}`);
        break;
      default:
        throw new Error(`unsupported RRULE part ${key}`);
    }
  }
  if (!freqSeen) throw new Error("missing FREQ");
  const err = validateRecurrence(spec);
  if (err) throw new Error(err);
  return spec;
}

/** Occurrence dates of period `p` (ascending), not yet filtered by DTSTART/UNTIL. */
function periodDates(spec: RecurrenceSpec, p: number): LocalDate[] {
  const start: LocalDate = spec.dtstart;
  if (spec.freq === "DAILY") {
    const d = addLocalDays(start, p * spec.interval);
    return !spec.byDay || spec.byDay.includes(weekdayOf(d)) ? [d] : [];
  }
  if (spec.freq === "WEEKLY") {
    const monday = addLocalDays(mondayOf(start), p * 7 * spec.interval);
    const days = spec.byDay?.length ? sortedDays(spec.byDay) : [weekdayOf(start)];
    return days.map((w) => addLocalDays(monday, WEEK_ORDER.indexOf(w)));
  }
  const monthIndex = start.year * 12 + (start.month - 1) + p * spec.interval;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const day = spec.byMonthDay ?? start.day;
  return day <= daysInMonth(year, month) ? [{ year, month, day }] : [];
}

/** Period index (≥ 0) whose span contains local date `d` (or the last period before it). */
function periodOf(spec: RecurrenceSpec, d: LocalDate): number {
  const start: LocalDate = spec.dtstart;
  let raw: number;
  if (spec.freq === "DAILY") raw = Math.floor((epochDay(d) - epochDay(start)) / spec.interval);
  else if (spec.freq === "WEEKLY") raw = Math.floor((epochDay(mondayOf(d)) - epochDay(mondayOf(start))) / (7 * spec.interval));
  else raw = Math.floor((d.year * 12 + d.month - (start.year * 12 + start.month)) / spec.interval);
  return Math.max(0, raw);
}

/**
 * Next occurrence strictly after `after`, evaluated in `tz` (floating DTSTART, DST-safe).
 * @param spec recurrence
 * @param tz IANA zone the wall-clock time is evaluated in
 * @param after exclusive lower bound (usually now, or the occurrence that just fired)
 * @param firedCount occurrences already fired; with COUNT, `firedCount >= count` → null
 * @returns the instant, or null when the rule is exhausted (COUNT/UNTIL) or yields nothing
 */
export function nextOccurrence(spec: RecurrenceSpec, tz: string, after: Date, firedCount: number): Date | null {
  if (validateRecurrence(spec) !== null) return null;
  if (spec.count !== undefined && firedCount >= spec.count) return null;
  const start: LocalDate = spec.dtstart;
  const time = { hour: spec.dtstart.hour, minute: spec.dtstart.minute };
  // Local dates before (localDate(after) − 1) can't produce an instant > after (offsets < 26h).
  const floor = addLocalDays(localDateOf(after, tz), -1);
  let index = 0; // occurrence index from DTSTART (COUNT)
  const firstPeriod = spec.count !== undefined ? 0 : periodOf(spec, floor);
  const lastPeriod = Math.max(firstPeriod, periodOf(spec, floor)) + MAX_PERIODS;
  for (let p = firstPeriod; p <= lastPeriod; p += 1) {
    for (const d of periodDates(spec, p)) {
      if (compareLocalDate(d, start) < 0) continue;
      if (spec.until && compareLocalDate(d, spec.until) > 0) return null;
      if (spec.count !== undefined && index >= spec.count) return null;
      index += 1;
      if (compareLocalDate(d, floor) < 0) continue;
      const at = zonedToUtc({ ...d, ...time }, tz).instant;
      if (at.getTime() > after.getTime()) return at;
    }
  }
  return null;
}

/** "9am", "8:30pm" (lowercase, no leading zero). */
function clock(h: number, m: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m === 0 ? "" : `:${pad(m)}`}${h < 12 ? "am" : "pm"}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function dayList(days: Weekday[]): string {
  const sorted = sortedDays(days);
  const key = sorted.join(",");
  if (key === "MO,TU,WE,TH,FR") return "weekday";
  if (key === "SA,SU") return "weekend day";
  if (sorted.length === 7) return "day";
  const names = sorted.map((d) => WEEKDAY_NAME[d]);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/**
 * Short human description for chat/tool output.
 * @param spec recurrence
 * @returns e.g. "every Mon & Wed at 9am", "every other Fri at 5pm", "the 1st of every month at 9am"
 */
export function describeRecurrence(spec: RecurrenceSpec): string {
  const at = `at ${clock(spec.dtstart.hour, spec.dtstart.minute)}`;
  const n = spec.interval;
  let base: string;
  if (spec.freq === "DAILY") {
    if (spec.byDay?.length && spec.byDay.length < 7) base = `every ${dayList(spec.byDay)}${n > 1 ? ` (every ${n} days)` : ""} ${at}`;
    else base = n === 1 ? `every day ${at}` : n === 2 ? `every other day ${at}` : `every ${n} days ${at}`;
  } else if (spec.freq === "WEEKLY") {
    const days = dayList(spec.byDay?.length ? spec.byDay : [weekdayOf(spec.dtstart)]);
    base = n === 1 ? `every ${days} ${at}` : n === 2 ? `every other ${days} ${at}` : `every ${n} weeks on ${days} ${at}`;
  } else {
    const day = ordinal(spec.byMonthDay ?? spec.dtstart.day);
    base = n === 1 ? `the ${day} of every month ${at}` : n === 2 ? `the ${day} of every other month ${at}` : `the ${day} every ${n} months ${at}`;
  }
  if (spec.until) return `${base} until ${MONTH_SHORT[spec.until.month - 1]} ${spec.until.day}`;
  if (spec.count !== undefined) return `${base} (${spec.count} time${spec.count === 1 ? "" : "s"})`;
  return base;
}
