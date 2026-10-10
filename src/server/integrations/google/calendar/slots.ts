import "server-only";
// OWNER: 4.2

/**
 * Slot engine for `find_free_slots` (V2-07 §2.7, §7.2 `calendar/slots.ts`; master plan §1.17). Pure:
 * no I/O, no `Date.now()` — `now` comes in through the query.
 *
 * Salvaged from V1 `slots.py`: clip busy intervals to the day window, sort, sweep a cursor and
 * collect gaps ≥ duration, then the trailing gap (`findGaps`). New on top:
 * - iteration by **local calendar date** in the user's IANA zone (never "24h days"), so DST days
 *   are exact; every instant goes through `zonedToUtc` (gap → forward, overlap → earlier);
 * - waking hours (default 08:00–23:00; an end at/before the start runs past midnight), the
 *   15-minute lead (past-time filter), hard constraints (`ConstraintSchema`), buffers around busy;
 * - candidate starts on a local 15-minute grid, scored (part of day, `around`, early-morning
 *   penalty, slack, sooner) and spread (distinct days first, ≥ 2h apart on the same day).
 *
 * A constraint's `days` and its clock times refer to the **logical day** the waking window starts
 * on: with waking 09:00–01:00, "not_after 20:00" on Friday cuts Friday 20:00 → Saturday 01:00.
 *
 * Slots reach the model only as `s_` aliases: the tool mints `ctx.aliases.mint("s", slotIdFor(c))`
 * and `create_block` decodes the resolved id with `parseSlotId` (see `slotIdFor`).
 */
import { ConstraintPrefSchema, type Constraint } from "@/shared/scheduling-constraints";
import {
  addLocalDays,
  formatLocalDate,
  formatTimeRange,
  localDateOf,
  localDatesBetween,
  offsetMinutes,
  parseHHMM,
  toLocal,
  weekdayOf,
  zonedToUtc,
  type LocalDate,
  type Weekday,
} from "@/shared/time/tz";
import type { Interval } from "@/server/integrations/google/calendar/busy";

export type { Interval } from "@/server/integrations/google/calendar/busy";

/** Default waking hours (V2-07 §2.7). */
export const DEFAULT_WAKING: Readonly<{ start: string; end: string }> = { start: "08:00", end: "23:00" };
/** Default padding around every busy interval, minutes (overridden by a `buffer_minutes` constraint). */
export const DEFAULT_BUFFER_MIN = 10;
/** Earliest start = now + lead (then rounded up to the grid). */
export const DEFAULT_LEAD_MIN = 15;
/** Candidate start grid, minutes (local :00/:15/:30/:45). */
export const DEFAULT_GRANULARITY_MIN = 15;
/** Longest search window. */
export const MAX_WINDOW_DAYS = 14;
/** Two picks on the same local day must start at least this far apart. */
export const SPREAD_MIN = 120;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** Part of day by local start time: morning 05–12, afternoon 12–17, evening 17–05. */
export type PartOfDay = "morning" | "afternoon" | "evening";

/** Input to `findFreeSlots` (V2-07 §7.2). */
export interface SlotQuery {
  now: Date;
  /** user's IANA zone (never the calendar's) */
  tz: string;
  windowStart: Date;
  windowEnd: Date;
  durationMin: number;
  busy: Interval[];
  constraints: Constraint[];
  /** "HH:MM" local; `end <= start` runs past midnight; equal = all day */
  waking: { start: string; end: string };
  bufferMin: number;
  leadMin: number;
  granularityMin: number;
  preferred?: { partOfDay?: PartOfDay[]; around?: string };
  /** 3..5 */
  maxResults: number;
}

/** One offered slot. */
export interface SlotCandidate {
  start: Date;
  end: Date;
  /** local label, e.g. "Tue Oct 14, 4–5:30pm" / "tmrw 4–5pm" */
  label: string;
  score: number;
  why: string;
}

// ── small helpers ────────────────────────────────────────────────────────────

function minutesOf(hhmm: string): number {
  const t = parseHHMM(hhmm);
  return t.hour * 60 + t.minute;
}

function at(date: LocalDate, hhmm: string, tz: string): Date {
  return zonedToUtc({ ...date, ...parseHHMM(hhmm) }, tz).instant;
}

function intersect(a: Interval, b: Interval): Interval | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return end > start ? { start, end } : null;
}

function subtract(xs: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const x of xs) {
    if (cut.end <= x.start || cut.start >= x.end) {
      out.push(x);
      continue;
    }
    if (cut.start > x.start) out.push({ start: x.start, end: cut.start });
    if (cut.end < x.end) out.push({ start: cut.end, end: x.end });
  }
  return out;
}

function dayNumber(d: LocalDate): number {
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / DAY_MS);
}

/** "8pm", "12:30pm". */
function clock(hhmm: string): string {
  const t = parseHHMM(hhmm);
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h12}${t.minute === 0 ? "" : `:${String(t.minute).padStart(2, "0")}`}${t.hour < 12 ? "am" : "pm"}`;
}

const DAY_LABEL: Readonly<Record<Weekday, string>> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

function daysLabel(days: readonly Weekday[] | undefined): string {
  return days && days.length > 0 ? ` on ${days.map((d) => DAY_LABEL[d]).join("/")}` : "";
}

/**
 * Short human description of a constraint (for notes), e.g. "not after 8pm", "not on Sat/Sun".
 * @param c constraint
 * @returns description
 */
export function describeConstraint(c: Constraint): string {
  switch (c.type) {
    case "not_after":
      return `not after ${clock(c.time)}${daysLabel(c.days)}`;
    case "not_before":
      return `not before ${clock(c.time)}${daysLabel(c.days)}`;
    case "avoid_range":
      return `not ${clock(c.start)}–${clock(c.end)}${daysLabel(c.days)}`;
    case "avoid_days":
      return `not on ${c.days.map((d) => DAY_LABEL[d]).join("/")}`;
    case "only_days":
      return `only on ${c.days.map((d) => DAY_LABEL[d]).join("/")}`;
    case "buffer_minutes":
      return `${c.minutes} min buffer`;
  }
}

// ── slot ids (model-facing as s_ aliases) ────────────────────────────────────

const SLOT_ID_RE = /^slot\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/**
 * Stable id of a slot: `slot|<startISO>|<endISO>`. The tool mints it into the run's alias table
 * (`s_` + 8 hex of its sha256), so the model only ever sees the alias; an alias resolves only in
 * the run that minted it (the AliasTable "shown" rule), so it can't be forged or replayed from an
 * earlier turn. `create_block` decodes the resolved id back to exact instants — no extra state.
 * @param slot slot interval
 * @returns the id
 */
export function slotIdFor(slot: Interval): string {
  return `slot|${slot.start.toISOString()}|${slot.end.toISOString()}`;
}

/**
 * Decode a `slotIdFor` id.
 * @param id resolved alias id
 * @returns the interval, or null when malformed / not a slot id / empty
 */
export function parseSlotId(id: string): Interval | null {
  const m = SLOT_ID_RE.exec(id);
  if (!m) return null;
  const start = new Date(m[1] as string);
  const end = new Date(m[2] as string);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start, end };
}

// ── preferences → constraints ───────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a preference's `applies_to` entry covers an activity: `*`, equal, the entry as a whole
 * word/phrase inside the activity ("study" ⊂ "study CPSC 323"), or the activity inside the entry.
 * Case- and whitespace-insensitive.
 * @param appliesTo one `applies_to` entry
 * @param activity the requested activity
 * @returns true when it applies
 */
export function appliesToActivity(appliesTo: string, activity: string): boolean {
  const a = norm(appliesTo);
  const act = norm(activity);
  if (a === "*") return true;
  if (a === "" || act === "") return false;
  if (a === act) return true;
  const word = (needle: string, hay: string) => new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}($|[^a-z0-9])`).test(hay);
  return word(a, act) || word(act, a);
}

/**
 * Hard constraints and a waking-hours override from active preferences
 * (`user_preferences.constraint_json`, `ConstraintPrefSchema`), so they apply even if the model
 * forgets to copy them. Malformed JSON is ignored; only entries whose `applies_to` covers the
 * activity count; the last matching `waking` wins (rows come sorted deterministically).
 * @param prefs active preference rows (`constraintJson` = stored jsonb)
 * @param activity requested activity, e.g. "gym"
 * @returns constraints (deduped, in row order) and the waking override, if any
 */
export function constraintsFromPreferences(
  prefs: ReadonlyArray<{ constraintJson: unknown }>,
  activity: string,
): { constraints: Constraint[]; waking?: { start: string; end: string } } {
  const constraints: Constraint[] = [];
  let waking: { start: string; end: string } | undefined;
  for (const p of prefs) {
    if (p.constraintJson === null || p.constraintJson === undefined) continue;
    const parsed = ConstraintPrefSchema.safeParse(p.constraintJson);
    if (!parsed.success) continue;
    if (!parsed.data.applies_to.some((a) => appliesToActivity(a, activity))) continue;
    if (parsed.data.constraint) constraints.push(parsed.data.constraint);
    if (parsed.data.waking) waking = { ...parsed.data.waking };
  }
  return { constraints: dedupeConstraints(constraints), ...(waking ? { waking } : {}) };
}

/**
 * Drop exact duplicates (e.g. a preference the model also copied into the tool input).
 * @param xs constraints
 * @returns first occurrence of each, order kept
 */
export function dedupeConstraints(xs: readonly Constraint[]): Constraint[] {
  const seen = new Set<string>();
  const out: Constraint[] = [];
  for (const c of xs) {
    const k = JSON.stringify(c, Object.keys(c).sort());
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ── interval primitives ─────────────────────────────────────────────────────

/**
 * Expand every interval by `padMin` on both sides, sort, and merge overlapping/touching ones.
 * @param xs intervals in any order (empty/inverted ones are dropped)
 * @param padMin minutes added before and after each interval
 * @returns disjoint, sorted intervals
 */
export function mergeIntervals(xs: readonly Interval[], padMin: number): Interval[] {
  const pad = Math.max(0, padMin) * MIN_MS;
  const sorted = xs
    .filter((x) => x.end.getTime() > x.start.getTime())
    .map((x) => ({ start: x.start.getTime() - pad, end: x.end.getTime() + pad }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out.map((x) => ({ start: new Date(x.start), end: new Date(x.end) }));
}

/**
 * Free gaps inside `allowed` at least `minDurationMin` long (salvaged V1 sweep): clip busy to the
 * window, sort, move a cursor past each busy block, then check the trailing gap.
 * @param allowed the window to search
 * @param busy busy intervals (any order; overlaps tolerated)
 * @param minDurationMin minimum gap length
 * @returns gaps in chronological order
 */
export function findGaps(allowed: Interval, busy: readonly Interval[], minDurationMin: number): Interval[] {
  const need = minDurationMin * MIN_MS;
  const clipped = busy
    .map((b) => intersect(b, allowed))
    .filter((b): b is Interval => b !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const gaps: Interval[] = [];
  let cursor = allowed.start.getTime();
  for (const b of clipped) {
    if (b.start.getTime() - cursor >= need) gaps.push({ start: new Date(cursor), end: b.start });
    cursor = Math.max(cursor, b.end.getTime());
  }
  if (allowed.end.getTime() - cursor >= need) gaps.push({ start: new Date(cursor), end: allowed.end });
  return gaps;
}

/**
 * Waking window of a logical day: [date start, end) where an end at or before the start is on the
 * next day (equal = 24h).
 * @param date local date
 * @param waking "HH:MM" bounds
 * @param tz IANA zone
 * @returns absolute interval
 */
export function wakingWindow(date: LocalDate, waking: { start: string; end: string }, tz: string): Interval {
  const start = at(date, waking.start, tz);
  const crosses = minutesOf(waking.end) <= minutesOf(waking.start);
  const end = at(crosses ? addLocalDays(date, 1) : date, waking.end, tz);
  return { start, end };
}

/** A constraint time on the logical day: before the waking start of a midnight-crossing window → next day. */
function logicalAt(date: LocalDate, hhmm: string, waking: { start: string; end: string }, tz: string): Date {
  const crosses = minutesOf(waking.end) <= minutesOf(waking.start);
  const next = crosses && minutesOf(hhmm) < minutesOf(waking.start);
  return at(next ? addLocalDays(date, 1) : date, hhmm, tz);
}

const FAR_PAST = new Date(-8.64e15);
const FAR_FUTURE = new Date(8.64e15);

function applyConstraint(xs: Interval[], c: Constraint, date: LocalDate, q: SlotQuery): Interval[] {
  const wd = weekdayOf(date);
  const onDay = (days: readonly Weekday[] | undefined) => !days || days.length === 0 || days.includes(wd);
  switch (c.type) {
    case "avoid_days":
      return c.days.includes(wd) ? [] : xs;
    case "only_days":
      return c.days.includes(wd) ? xs : [];
    case "not_after":
      return onDay(c.days) ? subtract(xs, { start: logicalAt(date, c.time, q.waking, q.tz), end: FAR_FUTURE }) : xs;
    case "not_before":
      return onDay(c.days) ? subtract(xs, { start: FAR_PAST, end: logicalAt(date, c.time, q.waking, q.tz) }) : xs;
    case "avoid_range": {
      if (!onDay(c.days)) return xs;
      const start = logicalAt(date, c.start, q.waking, q.tz);
      let end = logicalAt(date, c.end, q.waking, q.tz);
      if (end <= start) end = at(addLocalDays(localDateOf(start, q.tz), 1), c.end, q.tz);
      return subtract(xs, { start, end });
    }
    case "buffer_minutes":
      return xs;
  }
}

/**
 * Allowed time on one logical day: waking ∩ window ∩ [now + lead, ∞) minus hard constraints.
 * @param date local date the waking window starts on
 * @param q query
 * @returns disjoint allowed intervals (possibly empty)
 */
export function allowedIntervalsForDay(date: LocalDate, q: SlotQuery): Interval[] {
  const w = wakingWindow(date, q.waking, q.tz);
  const bounds: Interval = {
    start: new Date(Math.max(q.windowStart.getTime(), q.now.getTime() + q.leadMin * MIN_MS)),
    end: q.windowEnd,
  };
  const first = intersect(w, bounds);
  let xs: Interval[] = first ? [first] : [];
  for (const c of q.constraints) xs = applyConstraint(xs, c, date, q);
  return xs.filter((x) => x.end > x.start);
}

/**
 * Round an instant up to the local wall-clock grid (e.g. :00/:15/:30/:45), so half-hour zones
 * (Asia/Kolkata) still get local :00/:30 starts.
 * @param t instant
 * @param granularityMin grid step
 * @param tz IANA zone
 * @returns the first grid instant ≥ t
 */
export function alignUp(t: Date, granularityMin: number, tz: string): Date {
  const step = Math.max(1, granularityMin) * MIN_MS;
  const off = offsetMinutes(tz, t) * MIN_MS;
  const local = t.getTime() + off;
  return new Date(Math.ceil(local / step) * step - off);
}

function partOfDay(localMinutes: number): PartOfDay {
  if (localMinutes >= 5 * 60 && localMinutes < 12 * 60) return "morning";
  if (localMinutes >= 12 * 60 && localMinutes < 17 * 60) return "afternoon";
  return "evening";
}

interface Scored {
  start: Date;
  end: Date;
  day: number;
  score: number;
  reasons: string[];
}

/**
 * Find 3–5 well-placed free slots (V2-07 §2.7 steps 1–7).
 * @param q query (busy intervals unpadded; the buffer is applied here)
 * @returns candidates in chronological order, and notes when fewer than 3 fit
 */
export function findFreeSlots(q: SlotQuery): { candidates: SlotCandidate[]; notes: string[] } {
  const durMs = q.durationMin * MIN_MS;
  const windowEnd = new Date(Math.min(q.windowEnd.getTime(), q.windowStart.getTime() + MAX_WINDOW_DAYS * DAY_MS));
  const query: SlotQuery = { ...q, windowEnd };
  const bufferOverride = [...q.constraints].reverse().find((c) => c.type === "buffer_minutes");
  const buffer = bufferOverride && bufferOverride.type === "buffer_minutes" ? bufferOverride.minutes : q.bufferMin;
  const busy = mergeIntervals(q.busy, buffer);
  const firstDay = localDateOf(q.windowStart, q.tz);
  const firstDayNo = dayNumber(firstDay);
  // The day before the window too: its waking window may run past midnight into the window.
  const dates = [addLocalDays(firstDay, -1), ...localDatesBetween(q.windowStart, windowEnd, q.tz)];
  const around = q.preferred?.around !== undefined ? minutesOf(q.preferred.around) : null;
  const parts = q.preferred?.partOfDay ?? [];

  const scored: Scored[] = [];
  const seenStarts = new Set<number>();
  for (const date of dates) {
    const wakeStart = wakingWindow(date, q.waking, q.tz).start.getTime();
    const dayIdx = Math.max(0, dayNumber(date) - firstDayNo);
    for (const allowed of allowedIntervalsForDay(date, query)) {
      for (const gap of findGaps(allowed, busy, q.durationMin)) {
        const gapMs = gap.end.getTime() - gap.start.getTime();
        const roomy = gapMs - durMs >= durMs / 2;
        for (let s = alignUp(gap.start, q.granularityMin, q.tz).getTime(); s + durMs <= gap.end.getTime(); s += q.granularityMin * MIN_MS) {
          if (seenStarts.has(s)) continue;
          seenStarts.add(s);
          const start = new Date(s);
          const local = toLocal(start, q.tz);
          const mins = local.hour * 60 + local.minute;
          const reasons: string[] = [];
          let score = 0;
          const part = partOfDay(mins);
          if (parts.includes(part)) {
            score += 3;
            reasons.push(`in the ${part}`);
          }
          if (around !== null) {
            const diff = Math.abs(mins - around);
            score -= diff / 30;
            reasons.push(diff === 0 ? `right at ${clock(q.preferred?.around ?? "00:00")}` : `close to ${clock(q.preferred?.around ?? "00:00")}`);
          }
          if (s - wakeStart < 30 * MIN_MS) score -= 1;
          if (roomy) {
            score += 0.5;
            reasons.push("room to spare around it");
          } else {
            reasons.push("fits between other things");
          }
          score -= 0.25 * dayIdx;
          scored.push({ start, end: new Date(s + durMs), day: dayNumber(localDateOf(start, q.tz)), score, reasons });
        }
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || a.start.getTime() - b.start.getTime());
  const max = Math.max(1, Math.min(5, Math.floor(q.maxResults)));
  const picked: Scored[] = [];
  const days = new Set<number>();
  for (const c of scored) {
    if (picked.length >= max) break;
    if (days.has(c.day)) continue;
    picked.push(c);
    days.add(c.day);
  }
  for (const c of scored) {
    if (picked.length >= max) break;
    if (picked.includes(c)) continue;
    const tooClose = picked.some((p) => p.day === c.day && Math.abs(p.start.getTime() - c.start.getTime()) < SPREAD_MIN * MIN_MS);
    if (!tooClose) picked.push(c);
  }
  picked.sort((a, b) => a.start.getTime() - b.start.getTime());

  const candidates: SlotCandidate[] = picked.map((c) => ({
    start: c.start,
    end: c.end,
    label: formatTimeRange(c.start, c.end, q.tz, q.now),
    score: Math.round(c.score * 100) / 100,
    why: c.reasons.join(", "),
  }));

  const notes: string[] = [];
  const rules = q.constraints.filter((c) => c.type !== "buffer_minutes").map(describeConstraint);
  const ruleNote = rules.length > 0 ? `; your rules (${rules.join(", ")}) ruled out other times` : "";
  if (candidates.length === 0) {
    notes.push(`no ${q.durationMin}-minute opening fits between ${formatLocalDate(firstDay)} and ${formatLocalDate(localDateOf(windowEnd, q.tz))}${ruleNote}`);
  } else if (candidates.length < 3) {
    notes.push(`only ${candidates.length} slot${candidates.length === 1 ? "" : "s"} fit${ruleNote}`);
  }
  return { candidates, notes };
}
