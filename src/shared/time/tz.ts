/**
 * IANA time-zone and DST math. Pure, `Intl` only, no dependencies.
 *
 * This is the ONLY time-zone module in the app (master plan §1.10, V2-06 §7).
 * Store instants in UTC; compute calendar logic in the user's IANA zone.
 *
 * Semantics mirror Temporal's `disambiguation: "compatible"` so a later swap to
 * `Temporal.ZonedDateTime` is mechanical:
 *  - a wall time inside a spring-forward gap shifts forward by the gap length
 *    (NY 2026-03-08 02:30 → 03:30 EDT);
 *  - an ambiguous fall-back wall time resolves to the earlier instant
 *    (NY 2026-11-01 01:30 → 01:30 EDT).
 *
 * Never compute "tomorrow 08:00" as `+24h`: step the local date with
 * `addLocalDays` and re-solve with `zonedToUtc`.
 */

/** A calendar date with no zone. `month` is 1–12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** A wall-clock time with no zone. `hour` 0–23, `minute` 0–59. */
export interface LocalTime {
  hour: number;
  minute: number;
}

/** A floating (zone-less) wall-clock date-time, minute precision. */
export interface LocalDateTime extends LocalDate, LocalTime {}

/** RFC 5545 weekday codes. */
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

/** Fallback zone for users without a valid `users.timezone`. */
export const DEFAULT_TIME_ZONE = "America/New_York";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Wide enough that the true instant (wall ± 14h) and any transition near it are bracketed. */
const PROBE_MS = 48 * HOUR_MS;

const WEEKDAYS_BY_UTC_DAY: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WEEKDAY_SHORT: Record<Weekday, string> = {
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

// ── formatter caches ────────────────────────────────────────────────────────

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>();
const validity = new Map<string, boolean>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

function zoneNameFormatter(tz: string): Intl.DateTimeFormat {
  let f = zoneNameFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
    zoneNameFormatters.set(tz, f);
  }
  return f;
}

interface WallParts extends LocalDateTime {
  second: number;
}

/** Wall-clock parts of `ms` in `tz` (seconds included). */
function wallParts(tz: string, ms: number): WallParts {
  const out: WallParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  let bc = false;
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    switch (p.type) {
      case "year":
        out.year = Number(p.value);
        break;
      case "month":
        out.month = Number(p.value);
        break;
      case "day":
        out.day = Number(p.value);
        break;
      case "hour":
        out.hour = Number(p.value) % 24; // some ICU builds emit "24" at midnight
        break;
      case "minute":
        out.minute = Number(p.value);
        break;
      case "second":
        out.second = Number(p.value);
        break;
      case "era":
        bc = p.value === "BC" || p.value === "B";
        break;
      default:
        break;
    }
  }
  if (bc) out.year = 1 - out.year;
  return out;
}

/** UTC epoch ms of a wall clock read as if it were UTC (years 0–99 handled). */
function wallMs(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  return dt.getTime();
}

/** Zone offset in ms at instant `ms` (positive east of UTC). */
function offsetMs(tz: string, ms: number): number {
  const truncated = Math.floor(ms / 1000) * 1000;
  const p = wallParts(tz, truncated);
  return wallMs(p.year, p.month, p.day, p.hour, p.minute, p.second) - truncated;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(wallMs(y, m, d, 0, 0));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTime(h: number, mi: number): boolean {
  return Number.isInteger(h) && Number.isInteger(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

/** Days from 1970-01-01 to `d` (calendar arithmetic, no zone). */
function epochDay(d: LocalDate): number {
  return Math.round(wallMs(d.year, d.month, d.day, 0, 0) / DAY_MS);
}

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Whether `tz` is an IANA zone (or alias such as "UTC") known to this runtime's ICU data.
 * @param tz candidate zone id, e.g. "America/New_York"
 * @returns true if `Intl` accepts it
 */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim() === "" || tz.length > 64) return false;
  const cached = validity.get(tz);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  validity.set(tz, ok);
  return ok;
}

/**
 * Returns `tz` when valid, otherwise `DEFAULT_TIME_ZONE`.
 * @param tz zone from the DB or user input (may be null/garbage)
 * @returns a zone that is always safe to pass to the other functions
 */
export function safeTimeZone(tz: string | null | undefined): string {
  return typeof tz === "string" && isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

// ── instant ↔ local ─────────────────────────────────────────────────────────

/**
 * UTC offset of `tz` at `instant`, in minutes (east positive: Kolkata = 330, NY winter = -300).
 * @param tz IANA zone
 * @param instant the moment to evaluate
 * @returns offset in whole minutes
 */
export function offsetMinutes(tz: string, instant: Date): number {
  return Math.round(offsetMs(tz, instant.getTime()) / MINUTE_MS);
}

/**
 * Local wall-clock date-time (minute precision, seconds truncated) of `instant` in `tz`.
 * @param instant UTC instant
 * @param tz IANA zone
 * @returns local fields plus the local weekday
 */
export function toLocal(instant: Date, tz: string): LocalDateTime & { weekday: Weekday } {
  const p = wallParts(tz, instant.getTime());
  const date: LocalDate = { year: p.year, month: p.month, day: p.day };
  return { ...date, hour: p.hour, minute: p.minute, weekday: weekdayOf(date) };
}

/**
 * Local wall time in `tz` → UTC instant (Temporal "compatible" disambiguation).
 * - gap (spring-forward): shifted forward by the gap length → `adjusted: "gap_shifted"`
 * - overlap (fall-back): the earlier of the two instants → `adjusted: "overlap_earlier"`
 * @param local floating wall time (minute precision)
 * @param tz IANA zone
 * @returns the instant and which adjustment, if any, was applied
 */
export function zonedToUtc(
  local: LocalDateTime,
  tz: string,
): { instant: Date; adjusted: "none" | "gap_shifted" | "overlap_earlier" } {
  const wall = wallMs(local.year, local.month, local.day, local.hour, local.minute);
  const before = offsetMs(tz, wall - PROBE_MS);
  const after = offsetMs(tz, wall + PROBE_MS);

  // Fast path: no transition anywhere near this wall time.
  if (before === after && offsetMs(tz, wall - before) === before) {
    return { instant: new Date(wall - before), adjusted: "none" };
  }

  const o1 = offsetMs(tz, wall);
  const candidates = new Set<number>([before, after, o1, offsetMs(tz, wall - o1)]);
  const valid: number[] = [];
  for (const o of candidates) {
    const t = wall - o;
    if (offsetMs(tz, t) === o && !valid.includes(t)) valid.push(t);
  }
  valid.sort((a, b) => a - b);

  if (valid.length === 1) return { instant: new Date(valid[0]), adjusted: "none" };
  if (valid.length > 1) return { instant: new Date(valid[0]), adjusted: "overlap_earlier" };
  // Gap: interpret with the offset in force before the transition (shifts forward).
  return { instant: new Date(wall - before), adjusted: "gap_shifted" };
}

/**
 * Local calendar date of `instant` in `tz`.
 * @param instant UTC instant
 * @param tz IANA zone
 * @returns the local date
 */
export function localDateOf(instant: Date, tz: string): LocalDate {
  const p = wallParts(tz, instant.getTime());
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * Instant of local midnight (start of the local day containing `instant`).
 * On a day whose midnight falls in a gap, returns the first valid instant of that day.
 * @param instant any instant during the day
 * @param tz IANA zone
 * @returns the UTC instant at which that local day begins
 */
export function startOfLocalDay(instant: Date, tz: string): Date {
  return zonedToUtc({ ...localDateOf(instant, tz), hour: 0, minute: 0 }, tz).instant;
}

/**
 * Every local date whose day overlaps the half-open interval `[start, end)`, in order,
 * with no skips or duplicates across DST. `end <= start` → `[]`.
 * @param start interval start (inclusive)
 * @param end interval end (exclusive)
 * @param tz IANA zone
 * @returns local dates, ascending
 */
export function localDatesBetween(start: Date, end: Date, tz: string): LocalDate[] {
  if (end.getTime() <= start.getTime()) return [];
  const first = localDateOf(start, tz);
  const last = localDateOf(new Date(end.getTime() - 1), tz);
  const out: LocalDate[] = [];
  for (let d = first; compareLocalDate(d, last) <= 0; d = addLocalDays(d, 1)) {
    out.push(d);
    if (out.length > 3660) break; // ~10 years: guard against absurd ranges
  }
  return out;
}

// ── calendar arithmetic (no zone) ───────────────────────────────────────────

/**
 * Adds `n` calendar days (negative allowed). Pure calendar math, no zone, no DST.
 * @param d a local date
 * @param n days to add
 * @returns the shifted date
 */
export function addLocalDays(d: LocalDate, n: number): LocalDate {
  const dt = new Date(wallMs(d.year, d.month, d.day, 12, 0) + n * DAY_MS);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/**
 * Weekday of a calendar date.
 * @param d a local date
 * @returns RFC 5545 weekday code
 */
export function weekdayOf(d: LocalDate): Weekday {
  return WEEKDAYS_BY_UTC_DAY[new Date(wallMs(d.year, d.month, d.day, 12, 0)).getUTCDay()];
}

/**
 * Orders two local dates.
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareLocalDate(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return 0;
}

/**
 * ISO calendar date string.
 * @param d a local date
 * @returns "YYYY-MM-DD", e.g. "2026-10-12"
 */
export function formatLocalDate(d: LocalDate): string {
  const y = String(Math.abs(d.year)).padStart(4, "0");
  return `${d.year < 0 ? "-" : ""}${y}-${pad2(d.month)}-${pad2(d.day)}`;
}

// ── parsing ─────────────────────────────────────────────────────────────────

/**
 * Parses a wall-clock time as stored in Postgres `time` columns.
 * Accepts "8:00", "08:00", "08:00:00", "08:00:00.000" (seconds ignored).
 * @param s time text
 * @returns the local time
 * @throws RangeError when the text is not a valid 00:00–23:59 time
 */
export function parseHHMM(s: string): LocalTime {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*$/.exec(s);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const second = m[3] === undefined ? 0 : Number(m[3]);
    if (isValidTime(hour, minute) && second <= 59) return { hour, minute };
  }
  throw new RangeError(`invalid time: ${JSON.stringify(s)}`);
}

/**
 * Parses a strict calendar date.
 * @param s "YYYY-MM-DD"
 * @returns the date, or null if malformed or not a real date (e.g. Feb 30)
 */
export function parseLocalDate(s: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return isValidDate(d.year, d.month, d.day) ? d : null;
}

/**
 * Parses a floating local date-time (no offset, no "Z").
 * Accepts "2026-10-12T21:30", "2026-10-12 21:30", optional ":SS" (ignored).
 * @param s date-time text
 * @returns the local date-time, or null if malformed, offset-bearing or invalid
 */
export function parseLocalDateTime(s: string): LocalDateTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(s.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (!isValidDate(year, month, day) || !isValidTime(hour, minute) || second > 59) return null;
  return { year, month, day, hour, minute };
}

/**
 * Whether `t` lies in the daily window `[start, end)`. Windows may span midnight
 * (22:00–08:00 contains 23:59 and 07:59, not 08:00 or 21:59). `start == end` is an empty window.
 * @param t time to test
 * @param start window start (inclusive)
 * @param end window end (exclusive)
 * @returns true when inside
 */
export function isInDailyWindow(t: LocalTime, start: LocalTime, end: LocalTime): boolean {
  const x = t.hour * 60 + t.minute;
  const s = start.hour * 60 + start.minute;
  const e = end.hour * 60 + end.minute;
  if (s === e) return false;
  return s < e ? x >= s && x < e : x >= s || x < e;
}

// ── formatting ──────────────────────────────────────────────────────────────

/** "9pm", "11:59pm", "12am": lowercase, no leading zero, minutes only when non-zero. */
function chatClock(t: LocalTime, withMeridiem = true): string {
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const mins = t.minute === 0 ? "" : `:${pad2(t.minute)}`;
  return `${h12}${mins}${withMeridiem ? (t.hour < 12 ? "am" : "pm") : ""}`;
}

/** "Thu Oct 15" (+ ", 2027" when the year differs from `now` and the date is > 60 days away). */
function chatDate(d: LocalDate, today: LocalDate): string {
  const base = `${WEEKDAY_SHORT[weekdayOf(d)]} ${MONTH_SHORT[d.month - 1]} ${d.day}`;
  const far = Math.abs(epochDay(d) - epochDay(today)) > 60;
  return d.year !== today.year && far ? `${base}, ${d.year}` : base;
}

/** "today" | "tmrw" | "yesterday" | null, relative to `today`. */
function relativeDay(d: LocalDate, today: LocalDate): string | null {
  const diff = epochDay(d) - epochDay(today);
  if (diff === 0) return "today";
  if (diff === 1) return "tmrw";
  if (diff === -1) return "yesterday";
  return null;
}

/**
 * Short, human time for chat bubbles, always in the user's local zone.
 * - same local day → "today 11:59pm"; next day → "tmrw 9am"; previous day → "yesterday 5pm"
 * - 2–6 days ahead → "Thu 11:59pm"
 * - further away (either direction) → "Thu Oct 15" (date only)
 * - `allDay` → "today" / "tmrw" / "yesterday" / "Thu Oct 15" (never a clock time)
 * Lowercase am/pm, no leading zero, ":00" omitted.
 * @param instant the moment to describe
 * @param tz IANA zone
 * @param now reference "now" (determines today/tmrw)
 * @param opts `allDay` drops the clock time
 * @returns the label
 */
export function formatForChat(
  instant: Date,
  tz: string,
  now: Date,
  opts?: { allDay?: boolean },
): string {
  const local = toLocal(instant, tz);
  const today = localDateOf(now, tz);
  const rel = relativeDay(local, today);
  if (opts?.allDay) return rel ?? chatDate(local, today);
  if (rel) return `${rel} ${chatClock(local)}`;
  const diff = epochDay(local) - epochDay(today);
  if (diff >= 2 && diff <= 6) return `${WEEKDAY_SHORT[local.weekday]} ${chatClock(local)}`;
  return chatDate(local, today);
}

/**
 * Unambiguous absolute time for model-facing tool output.
 * @param instant the moment to describe
 * @param tz IANA zone
 * @returns e.g. "Tue Oct 13, 9:00 PM EDT" (zone abbreviation from ICU, e.g. "GMT+5:30" for Kolkata)
 */
export function formatForTool(instant: Date, tz: string): string {
  const l = toLocal(instant, tz);
  const h12 = l.hour % 12 === 0 ? 12 : l.hour % 12;
  const meridiem = l.hour < 12 ? "AM" : "PM";
  const zone =
    zoneNameFormatter(tz)
      .formatToParts(instant)
      .find((p) => p.type === "timeZoneName")?.value ?? tz;
  return `${WEEKDAY_SHORT[l.weekday]} ${MONTH_SHORT[l.month - 1]} ${l.day}, ${h12}:${pad2(l.minute)} ${meridiem} ${zone}`;
}

/**
 * Compact local time range for chat (V2-07 slot labels).
 * - "Tue Oct 14, 4–5:30pm"; "today 4–5:30pm"; "tmrw 11am–12:30pm"
 * - spans midnight: "Tue Oct 14, 11pm–Wed 1am"
 * Uses an en dash; meridiem is printed once when both ends share it.
 * @param start range start
 * @param end range end
 * @param tz IANA zone
 * @param now reference "now" (determines today/tmrw)
 * @returns the label
 */
export function formatTimeRange(start: Date, end: Date, tz: string, now: Date): string {
  const a = toLocal(start, tz);
  const b = toLocal(end, tz);
  const today = localDateOf(now, tz);
  const rel = relativeDay(a, today);
  const day = rel ? `${rel} ` : `${chatDate(a, today)}, `;
  if (compareLocalDate(a, b) !== 0) {
    return `${day}${chatClock(a)}–${WEEKDAY_SHORT[b.weekday]} ${chatClock(b)}`;
  }
  const sameMeridiem = a.hour < 12 === b.hour < 12;
  return `${day}${chatClock(a, !sameMeridiem)}–${chatClock(b)}`;
}
