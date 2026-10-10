/**
 * /week view model: group timeline items into local days (web plan §2.5, §7.3).
 * Pure and client-safe. Day boundaries compare local-date strings only (never `+24h`),
 * so DST transitions can't shift an item; all-day items use their floating date.
 */
import {
  addLocalDays,
  formatLocalDate,
  localDateOf,
  parseLocalDate,
  weekdayOf,
  type Weekday,
} from "@/shared/time/tz";

/** One timeline item as the web sees it (dates as ISO strings for the client). */
export interface WeekItem {
  id: string;
  source: "canvas" | "gcal" | "gmail" | "syllabus" | "aria";
  kind: "assignment" | "exam" | "event" | "class" | "block";
  title: string;
  course: string | null;
  startsAt: string | null;
  endsAt: string | null;
  dueAt: string | null;
  allDay: boolean;
  /** "YYYY-MM-DD" floating date when `allDay`. */
  allDayDate: string | null;
  url: string | null;
  status: "upcoming" | "done" | "dismissed";
}

export type LoadLevel = "light" | "busy" | "heavy";

/** One local day in the window. */
export interface WeekDay {
  /** "YYYY-MM-DD" in the user's zone. */
  key: string;
  label: string;
  load: LoadLevel;
  points: number;
  deadlines: WeekItem[];
  schedule: WeekItem[];
}

/** The grouped week. */
export interface WeekView {
  /** Past-due, not-done deadlines from the 7 days before today (only when `offsetWeeks` is 0). */
  stillOpen: WeekItem[];
  days: WeekDay[];
  load: LoadLevel;
  /** Upcoming (not done) deadlines in the window. */
  dueCount: number;
}

const DEADLINE_KINDS: ReadonlySet<WeekItem["kind"]> = new Set(["assignment", "exam"]);
const WEEKDAY_SHORT: Record<Weekday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Local calendar day of an instant.
 * @param iso ISO instant
 * @param timeZone IANA zone
 * @returns "YYYY-MM-DD"
 */
export function localDayKey(iso: string, timeZone: string): string {
  return formatLocalDate(localDateOf(new Date(iso), timeZone));
}

/** Day an item belongs to: its floating date when all-day, else due (or start) in the zone. */
function itemDayKey(item: WeekItem, timeZone: string): string | null {
  if (item.allDay && item.allDayDate && parseLocalDate(item.allDayDate)) return item.allDayDate;
  const at = DEADLINE_KINDS.has(item.kind) ? (item.dueAt ?? item.startsAt) : (item.startsAt ?? item.dueAt);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return localDayKey(at, timeZone);
}

function shiftKey(key: string, days: number): string {
  const d = parseLocalDate(key);
  if (!d) throw new RangeError(`bad day key: ${key}`);
  return formatLocalDate(addLocalDays(d, days));
}

/**
 * Week load from the number of upcoming deadlines (V1 thresholds).
 * @param deadlineCount upcoming, not-done deadlines in the window
 * @returns ≤3 light, 4–6 busy, ≥7 heavy
 */
export function weekLoad(deadlineCount: number): LoadLevel {
  if (deadlineCount >= 7) return "heavy";
  if (deadlineCount >= 4) return "busy";
  return "light";
}

/**
 * Day load from points (assignment = 1, exam = 2).
 * @param points day points
 * @returns 0–1 light, 2 busy, ≥3 heavy
 */
export function dayLoad(points: number): LoadLevel {
  if (points >= 3) return "heavy";
  if (points >= 2) return "busy";
  return "light";
}

/**
 * Day header text.
 * @param dayKey "YYYY-MM-DD"
 * @param todayKey today's key in the user's zone
 * @param timeZone the user's zone (keys are already local; kept for call-site symmetry)
 * @returns "Today", "Tomorrow", or "Wed, Oct 14"
 */
export function dayLabel(dayKey: string, todayKey: string, timeZone: string): string {
  void timeZone;
  if (dayKey === todayKey) return "Today";
  if (dayKey === shiftKey(todayKey, 1)) return "Tomorrow";
  const d = parseLocalDate(dayKey);
  if (!d) return dayKey;
  return `${WEEKDAY_SHORT[weekdayOf(d)]}, ${MONTH_SHORT[d.month - 1]} ${d.day}`;
}

function clockParts(iso: string, timeZone: string): { time: string; meridiem: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return { time: `${get("hour")}:${get("minute")}`, meridiem: get("dayPeriod").toUpperCase() };
}

function clock(iso: string, timeZone: string): string {
  const c = clockParts(iso, timeZone);
  return `${c.time} ${c.meridiem}`;
}

/**
 * The time line for an item, in the user's zone (copy deck §9.3).
 * @param item the item
 * @param timeZone IANA zone
 * @returns "Due 11:59 PM", "Exam 9:00 AM", "Due (all day)", "10:30–11:45 AM", "All day"
 */
export function formatItemTime(item: WeekItem, timeZone: string): string {
  if (DEADLINE_KINDS.has(item.kind)) {
    const prefix = item.kind === "exam" ? "Exam" : "Due";
    const at = item.dueAt ?? item.startsAt;
    if (item.allDay || !at) return `${prefix} (all day)`;
    return `${prefix} ${clock(at, timeZone)}`;
  }
  if (item.allDay || !item.startsAt) return "All day";
  const start = clockParts(item.startsAt, timeZone);
  if (!item.endsAt) return `${start.time} ${start.meridiem}`;
  const end = clockParts(item.endsAt, timeZone);
  return start.meridiem === end.meridiem
    ? `${start.time}–${end.time} ${end.meridiem}`
    : `${start.time} ${start.meridiem}–${end.time} ${end.meridiem}`;
}

/** Sort instant: all-day items sort at the end of their day, after timed ones. */
function sortInstant(item: WeekItem, field: "dueAt" | "startsAt"): number {
  if (item.allDay) return Number.POSITIVE_INFINITY;
  const v = item[field] ?? (field === "dueAt" ? item.startsAt : item.dueAt);
  const t = v ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function compareDeadlines(a: WeekItem, b: WeekItem): number {
  const doneA = a.status === "done" ? 1 : 0;
  const doneB = b.status === "done" ? 1 : 0;
  if (doneA !== doneB) return doneA - doneB;
  const ta = sortInstant(a, "dueAt");
  const tb = sortInstant(b, "dueAt");
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ea = a.kind === "exam" ? 0 : 1;
  const eb = b.kind === "exam" ? 0 : 1;
  if (ea !== eb) return ea - eb;
  return a.title.localeCompare(b.title);
}

function compareSchedule(a: WeekItem, b: WeekItem): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const ta = sortInstant({ ...a, allDay: false }, "startsAt");
  const tb = sortInstant({ ...b, allDay: false }, "startsAt");
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.title.localeCompare(b.title);
}

function points(items: readonly WeekItem[]): number {
  return items.reduce(
    (sum, i) => (i.status !== "upcoming" ? sum : sum + (i.kind === "exam" ? 2 : i.kind === "assignment" ? 1 : 0)),
    0,
  );
}

/**
 * Groups items into a rolling 7-day window starting today (or the following 7 days).
 * Dismissed items are dropped. "Still open" holds upcoming deadlines due in the 7 days
 * before today (this week only); items due earlier today stay in Today.
 * @param items timeline items (any order; outside the window is fine)
 * @param opts zone, clock, and which week
 * @returns the grouped view
 */
export function groupWeek(
  items: readonly WeekItem[],
  opts: { timeZone: string; now: Date; offsetWeeks: 0 | 1 },
): WeekView {
  const { timeZone, now, offsetWeeks } = opts;
  const todayKey = formatLocalDate(localDateOf(now, timeZone));
  const firstKey = shiftKey(todayKey, offsetWeeks * 7);
  const keys = Array.from({ length: 7 }, (_, i) => shiftKey(firstKey, i));
  const byKey = new Map(keys.map((k) => [k, { deadlines: [] as WeekItem[], schedule: [] as WeekItem[] }]));
  const openFrom = shiftKey(todayKey, -7);
  const stillOpen: WeekItem[] = [];

  for (const item of items) {
    if (item.status === "dismissed") continue;
    const key = itemDayKey(item, timeZone);
    if (!key) continue;
    const isDeadline = DEADLINE_KINDS.has(item.kind);
    const bucket = byKey.get(key);
    if (bucket) {
      (isDeadline ? bucket.deadlines : bucket.schedule).push(item);
    } else if (
      offsetWeeks === 0 &&
      isDeadline &&
      item.status === "upcoming" &&
      key >= openFrom &&
      key < todayKey
    ) {
      stillOpen.push(item);
    }
  }

  const days: WeekDay[] = keys.map((key) => {
    const bucket = byKey.get(key) ?? { deadlines: [], schedule: [] };
    const deadlines = [...bucket.deadlines].sort(compareDeadlines);
    const schedule = [...bucket.schedule].sort(compareSchedule);
    const p = points(deadlines);
    return { key, label: dayLabel(key, todayKey, timeZone), load: dayLoad(p), points: p, deadlines, schedule };
  });
  const dueCount = days.reduce(
    (n, d) => n + d.deadlines.filter((i) => i.status === "upcoming").length,
    0,
  );

  return { stillOpen: stillOpen.sort(compareDeadlines), days, load: weekLoad(dueCount), dueCount };
}
