import "server-only";
// OWNER: 2.3

/**
 * Urgency and load (V2-05 §7.3 `urgency.ts`). Pure: computed at read time, never stored.
 * Thresholds port V1 (`briefing.compute_load_score`, mobile `useCards.ts`).
 */
import {
  addLocalDays,
  compareLocalDate,
  formatLocalDate,
  localDateOf,
  parseLocalDate,
  type LocalDate,
} from "@/shared/time/tz";
import type { DayLoad, TimelineItem, TimelineKind, Urgency } from "@/server/timeline/types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Kinds that are deadlines (count toward load, can be overdue). */
export const DEADLINE_KINDS: ReadonlySet<TimelineKind> = new Set<TimelineKind>(["assignment", "exam"]);

type UrgencyInput = Pick<TimelineItem, "kind" | "anchorAt" | "status">;

/**
 * Floating calendar date encoded in a timing key, when the key is date-only.
 * Accepts V2-05/V2-08 `D:YYYYMMDD` and V2-07's raw `YYYY-MM-DD` (`start.date`) literal.
 * @param timingKey stored timing key (may be null)
 * @returns the local date, or null for timed/absent keys
 */
export function dateFromTimingKey(timingKey: string | null | undefined): LocalDate | null {
  if (!timingKey) return null;
  const d = /^D:(\d{4})(\d{2})(\d{2})$/.exec(timingKey);
  if (d) return parseLocalDate(`${d[1]}-${d[2]}-${d[3]}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(timingKey)) return parseLocalDate(timingKey);
  return null;
}

/**
 * The local day an item belongs to. All-day items use their floating date (never pushed
 * through UTC, so UTC−x users never see a shifted day); timed items use the anchor in `tz`.
 * @param item stored item
 * @param tz user zone
 * @returns local date, or null when the item has no anchor
 */
export function itemLocalDate(
  item: Pick<TimelineItem, "allDay" | "timingKey" | "anchorAt">,
  tz: string,
): LocalDate | null {
  if (item.allDay) {
    const floating = dateFromTimingKey(item.timingKey);
    if (floating) return floating;
  }
  return item.anchorAt ? localDateOf(item.anchorAt, tz) : null;
}

/**
 * `"YYYY-MM-DD"` for an all-day item (floating date from the timing key, else the anchor's local date).
 * @param item stored item
 * @param tz user zone
 * @returns the date string, or null for timed items
 */
export function allDayDateOf(item: Pick<TimelineItem, "allDay" | "timingKey" | "anchorAt">, tz: string): string | null {
  if (!item.allDay) return null;
  const d = itemLocalDate(item, tz);
  return d ? formatLocalDate(d) : null;
}

/**
 * Urgency bucket at `now`:
 * overdue (anchor < now, ≤ 7d ago, upcoming assignment/exam) | now (≤ 3h) | today (same local
 * date or ≤ 24h) | soon (≤ 72h) | this_week (≤ 7d) | later | past (anything else before now).
 * @param item kind, anchor, status
 * @param now clock
 * @param tz user zone (for "same local date")
 * @returns the bucket; no anchor → "later"
 */
export function computeUrgency(item: UrgencyInput, now: Date, tz: string): Urgency {
  if (!item.anchorAt) return "later";
  const delta = item.anchorAt.getTime() - now.getTime();
  if (delta < 0) {
    const overdue = DEADLINE_KINDS.has(item.kind) && item.status === "upcoming" && -delta <= 7 * DAY_MS;
    return overdue ? "overdue" : "past";
  }
  if (delta <= 3 * HOUR_MS) return "now";
  if (delta <= DAY_MS || compareLocalDate(localDateOf(item.anchorAt, tz), localDateOf(now, tz)) === 0) return "today";
  if (delta <= 72 * HOUR_MS) return "soon";
  if (delta <= 7 * DAY_MS) return "this_week";
  return "later";
}

/**
 * Monotone urgency score for sorting/briefing (V2-06): higher = more urgent.
 * Future: `100 / (1 + hours/24)` (non-increasing in the anchor). Overdue deadlines (≤ 7d) = 100.
 * Exams × 1.5. Done/dismissed, past events, older overdue and unanchored items = 0.
 * @param item kind, anchor, status
 * @param now clock
 * @returns score rounded to 3 decimals
 */
export function urgencyScore(item: UrgencyInput, now: Date): number {
  if (item.status !== "upcoming" || !item.anchorAt) return 0;
  const hours = (item.anchorAt.getTime() - now.getTime()) / HOUR_MS;
  let base: number;
  if (hours >= 0) base = 100 / (1 + hours / 24);
  else if (DEADLINE_KINDS.has(item.kind) && hours >= -7 * 24) base = 100;
  else return 0;
  const score = item.kind === "exam" ? base * 1.5 : base;
  return Math.round(score * 1000) / 1000;
}

function dayLevel(count: number): DayLoad["level"] {
  if (count <= 1) return "light";
  if (count <= 3) return "busy";
  return "heavy";
}

/**
 * Per local day: upcoming assignment + exam count; light ≤ 1, busy 2–3, heavy ≥ 4.
 * All-day items land on their floating date.
 * @param items stored items (removed ones are ignored)
 * @param tz user zone
 * @param from first local date "YYYY-MM-DD"
 * @param days number of days (≥ 0)
 * @returns one entry per day, in order
 * @throws RangeError when `from` is not a valid date
 */
export function dayLoads(items: TimelineItem[], tz: string, from: string, days: number): DayLoad[] {
  const start = parseLocalDate(from);
  if (!start) throw new RangeError(`dayLoads: invalid date ${JSON.stringify(from)}`);
  const n = Math.max(0, Math.floor(days));
  const byDate = new Map<string, { count: number; examCount: number }>();
  for (const item of items) {
    if (item.removedAt || item.status !== "upcoming" || !DEADLINE_KINDS.has(item.kind)) continue;
    const d = itemLocalDate(item, tz);
    if (!d) continue;
    const key = formatLocalDate(d);
    const cur = byDate.get(key) ?? { count: 0, examCount: 0 };
    cur.count += 1;
    if (item.kind === "exam") cur.examCount += 1;
    byDate.set(key, cur);
  }
  const out: DayLoad[] = [];
  for (let i = 0; i < n; i++) {
    const date = formatLocalDate(addLocalDays(start, i));
    const c = byDate.get(date) ?? { count: 0, examCount: 0 };
    out.push({ date, count: c.count, examCount: c.examCount, level: dayLevel(c.count) });
  }
  return out;
}

/**
 * 7-day level from upcoming assignment + exam items anchored in [now, now + 7d):
 * light ≤ 3, busy 4–6, heavy ≥ 7.
 * @param items stored items (removed ones are ignored)
 * @param now clock
 * @returns the level
 */
export function weekLoadLevel(items: TimelineItem[], now: Date): "light" | "busy" | "heavy" {
  const start = now.getTime();
  const end = start + 7 * DAY_MS;
  let count = 0;
  for (const item of items) {
    if (item.removedAt || item.status !== "upcoming" || !DEADLINE_KINDS.has(item.kind) || !item.anchorAt) continue;
    const t = item.anchorAt.getTime();
    if (t >= start && t < end) count += 1;
  }
  if (count <= 3) return "light";
  if (count <= 6) return "busy";
  return "heavy";
}
