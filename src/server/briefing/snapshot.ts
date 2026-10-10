import "server-only";
// OWNER: 4.1

/**
 * Deterministic briefing assembly (V2-06 §2.5, §7 `briefing/snapshot.ts`, §13 Q4/Q5). Pure: no I/O,
 * no LLM. Every time is pre-rendered in the user's local zone by code (the model never converts
 * zones; fixes the V1 UTC display bug). Ports V1's load score (0–1 light / 2–3 busy / 4+ heavy over
 * 48h) and exam touchpoints (T-7/5/3/1/0 local days).
 *
 * Titles, courses, email subjects and note payloads are third-party text: the snapshot keeps them
 * as plain strings (URL-stripped, clipped); `prompt.ts` wraps them with `wrapUntrusted` before they
 * reach the model, and `template.ts` sends them to the user only as labels.
 */
import { createHash } from "node:crypto";
import type { BriefingEmailItem } from "@/server/integrations/google/gmail/types";
import { stripUrls, type Register } from "@/server/reminders/render";
import type { JsonValue, TimelineItemView, TimelineLike, TimelineSource } from "@/server/timeline/types";
import {
  addLocalDays,
  compareLocalDate,
  formatForChat,
  formatLocalDate,
  formatTimeRange,
  localDateOf,
  parseLocalDate,
  safeTimeZone,
  toLocal,
  weekdayOf,
  zonedToUtc,
  type LocalDate,
  type LocalTime,
  type Weekday,
} from "@/shared/time/tz";

/** `briefings.kind` (check constraint in migration 003 §8). */
export type BriefingKind = "daily" | "monday" | "catchup" | "connect_nudge" | "empty";
/** Which content set to build: the normal morning briefing or the compact afternoon catch-up. */
export type BriefingMode = "daily" | "catchup";

/** One unconsumed `briefing_notes` row. */
export interface BriefingNoteInput {
  id: string;
  kind: string;
  payload: Record<string, JsonValue>;
}

/** Everything `buildBriefingSnapshot` needs (loaded by `load.ts`). */
export interface BriefingInputs {
  user: { name: string | null; tz: string; briefingTime: LocalTime; register: Register };
  /** reference instant: the scheduled delivery time (or the deferred send time) */
  now: Date;
  /** the briefing's local date in `user.tz` */
  localDate: LocalDate;
  mode: BriefingMode;
  /** upcoming timeline items anchored in [start of `localDate`, +9 local days) */
  items: TimelineItemView[];
  notes: BriefingNoteInput[];
  emails: BriefingEmailItem[];
  /** extra busy intervals (calendar), merged with today's timeline events */
  busy: { start: Date; end: Date }[];
  integrations: { canvas: boolean; google: boolean };
  /** one queued preference proposal to ask about (V2-04: ≤1 per briefing) */
  proposal: { id: string; statement: string } | null;
}

/** One deadline line. `label` is "COURSE: title" (link-free, clipped). */
export interface SnapshotItem {
  id: string;
  label: string;
  title: string;
  course: string | null;
  /** local, chat style ("11:59pm", "tmrw 9am", "Thu Oct 15") */
  when: string;
  weightPct: number | null;
  source: TimelineSource;
  kind: "assignment" | "exam";
}

/** One event/class line for today. */
export interface SnapshotEvent {
  label: string;
  /** "9–10:15am" or "all day" */
  when: string;
  source: TimelineSource;
}

/** The deterministic briefing content (hashed for freshness; rendered by prompt/template). */
export interface BriefingSnapshot {
  kind: Exclude<BriefingKind, "connect_nudge">;
  /** "YYYY-MM-DD" */
  localDate: string;
  /** "Mon Oct 12" */
  localDateLabel: string;
  weekday: Weekday;
  name: string | null;
  load: "light" | "busy" | "heavy";
  /** deadlines due within 48h of `now` (the load count) */
  due48h: number;
  dueToday: SnapshotItem[];
  /** daily: tomorrow before noon (the folded T-24h nudge); catch-up: everything else due ≤36h */
  dueNext: SnapshotItem[];
  /** Monday: the 7-day view, one entry per day that has deadlines */
  week?: { day: string; items: SnapshotItem[] }[];
  events: SnapshotEvent[];
  exams: { label: string; daysUntil: number; source: TimelineSource }[];
  changes: { noteId: string; text: string }[];
  emails: { id: string; from: string; subject: string; kind: string | null }[];
  suggestion: { itemLabel: string; gap: string } | null;
  proposal: { id: string; statement: string } | null;
  /** deadlines due in the next 7 days (aggregate for the magic-link preview) */
  weekCount: number;
  integrations: { canvas: boolean; google: boolean };
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const TITLE_MAX = 90;
const SUBJECT_MAX = 120;
const MAX_CHANGES = 6;
const MAX_EMAILS = 3;
const MAX_EVENTS = 8;
/** Exam countdown touchpoints (local days before the exam), ported from V1. */
export const EXAM_TOUCHPOINTS: readonly number[] = [7, 5, 3, 1, 0];
/** The suggestion only looks at free time up to this local hour. */
export const SUGGESTION_WINDOW_END: LocalTime = { hour: 22, minute: 0 };
/** Smallest free gap worth suggesting. */
export const SUGGESTION_MIN_GAP_MS = 60 * MIN_MS;
/** Catch-up briefings cover deadlines due within this horizon. */
export const CATCHUP_HORIZON_MS = 36 * HOUR_MS;
/** Connect-Canvas nudges: days after signup for attempt 1, 2, 3 (max 3 lifetime, §13 Q5). */
export const CONNECT_NUDGE_DAYS: readonly number[] = [1, 3, 7];
/** At most this many empty check-ins in a row on weekdays (§13 Q4). */
export const MAX_EMPTY_STREAK = 2;
/** The one-line Canvas hint for Google-only users is shown at most this many times. */
export const MAX_CANVAS_HINTS = 3;

const WEEKDAY_SHORT: Record<Weekday, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── small pure helpers ──────────────────────────────────────────────────────

function oneLine(s: string): string {
  return stripUrls(s, "").replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Item label "CPSC 323: pset 4" (course prefixed unless the title already names it), link-free, clipped.
 * @param title item title (third-party)
 * @param course course (third-party) or null
 * @returns the label
 */
export function itemLabel(title: string | null, course: string | null): string {
  const t = oneLine(title ?? "") || "untitled";
  const c = course ? oneLine(course) : "";
  return clip(c && !t.toLowerCase().includes(c.toLowerCase()) ? `${c}: ${t}` : t, TITLE_MAX);
}

/** "Mon Oct 12" for a local date. */
function dateLabel(d: LocalDate): string {
  return `${WEEKDAY_SHORT[weekdayOf(d)]} ${MONTH_SHORT[d.month - 1]} ${d.day}`;
}

/** Whole local days from `a` to `b` (calendar arithmetic, zone-free). */
function dayDiff(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

function sameDate(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDate(a, b) === 0;
}

function midnight(d: LocalDate, tz: string): Date {
  return zonedToUtc({ ...d, hour: 0, minute: 0 }, tz).instant;
}

function anchorOf(v: Pick<TimelineLike, "dueAt" | "startsAt">): Date | null {
  return v.dueAt ?? v.startsAt ?? null;
}

/**
 * The local day an item belongs to: all-day items by their floating date, timed items by the
 * anchor in `tz` (an all-day exam stored at 23:59:59Z is never off by one).
 * @param v item fields
 * @param tz user zone
 * @returns local date, or null when unanchored
 */
export function localDayOf(v: Pick<TimelineLike, "allDay" | "allDayDate" | "dueAt" | "startsAt">, tz: string): LocalDate | null {
  if (v.allDayDate) {
    const d = parseLocalDate(v.allDayDate);
    if (d) return d;
  }
  const a = anchorOf(v);
  return a ? localDateOf(a, tz) : null;
}

function isDeadline(v: TimelineItemView): v is TimelineItemView & { kind: "assignment" | "exam" } {
  return v.kind === "assignment" || v.kind === "exam";
}

/** "9am", "11:59pm" (lowercase, no leading zero). */
function clock(t: LocalTime): string {
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h12}${t.minute ? `:${String(t.minute).padStart(2, "0")}` : ""}${t.hour < 12 ? "am" : "pm"}`;
}

function toSnapshotItem(v: TimelineItemView & { kind: "assignment" | "exam" }, tz: string, now: Date, sameDay: boolean): SnapshotItem {
  const anchor = anchorOf(v);
  let when: string;
  if (v.allDayDate || v.allDay) when = sameDay ? "today" : v.label || "all day";
  else if (anchor && sameDay) when = clock(toLocal(anchor, tz));
  else when = anchor ? formatForChat(anchor, tz, now) : "no date";
  return {
    id: v.id,
    label: itemLabel(v.title, v.course),
    title: oneLine(v.title) || "untitled",
    course: v.course ? oneLine(v.course) : null,
    when,
    weightPct: v.syllabus?.weight_pct ?? null,
    source: v.source,
    kind: v.kind,
  };
}

// ── exported pure pieces ────────────────────────────────────────────────────

/**
 * Load level from the number of deadlines due within 48h (V1 thresholds).
 * @param countDue48h deadlines due in the next 48 hours
 * @returns light (0–1) | busy (2–3) | heavy (4+)
 */
export function computeLoad(countDue48h: number): "light" | "busy" | "heavy" {
  if (countDue48h <= 1) return "light";
  if (countDue48h <= 3) return "busy";
  return "heavy";
}

/**
 * Exams whose LOCAL day is exactly 7, 5, 3, 1 or 0 days after `localDate`.
 * @param items candidate items (non-exams are ignored)
 * @param tz user zone
 * @param localDate the briefing's local date
 * @returns touchpoint exams with their day distance, soonest first
 */
export function examTouchpoints<T extends TimelineLike>(items: readonly T[], tz: string, localDate: LocalDate): { item: T; daysUntil: number }[] {
  const out: { item: T; daysUntil: number }[] = [];
  for (const it of items) {
    if (it.kind !== "exam") continue;
    const d = localDayOf(it, tz);
    if (!d) continue;
    const daysUntil = dayDiff(localDate, d);
    if (EXAM_TOUCHPOINTS.includes(daysUntil)) out.push({ item: it, daysUntil });
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil);
}

/** Merge overlapping intervals (sorted by start). */
function mergeIntervals(xs: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

const QUARTER_MS = 15 * MIN_MS;

/**
 * One deterministic suggestion: the hardest upcoming deadline (highest urgency score, tiebreak
 * syllabus weight) and the longest free gap ≥60 min today between `windowStart` (max of now and
 * the briefing time) and 22:00 local that ends before that deadline. Gap ends are snapped to the
 * quarter hour.
 * @param items upcoming timeline views (deadlines are picked from these)
 * @param busy busy intervals (classes, events, calendar)
 * @param tz user zone
 * @param now reference instant
 * @param windowStart local time the window may start at (the briefing time)
 * @param windowEnd local time the window ends (default 22:00)
 * @returns the suggestion, or null when there is no deadline or no gap
 */
export function findSuggestion(
  items: readonly TimelineItemView[],
  busy: readonly { start: Date; end: Date }[],
  tz: string,
  now: Date,
  windowStart: LocalTime,
  windowEnd: LocalTime = SUGGESTION_WINDOW_END,
): BriefingSnapshot["suggestion"] {
  const nowMs = now.getTime();
  const candidates = items.filter(
    (v) => isDeadline(v) && v.status === "upcoming" && (anchorOf(v)?.getTime() ?? 0) > nowMs,
  );
  if (candidates.length === 0) return null;
  const hardest = [...candidates].sort(
    (a, b) =>
      b.urgencyScore - a.urgencyScore ||
      (b.syllabus?.weight_pct ?? 0) - (a.syllabus?.weight_pct ?? 0) ||
      a.id.localeCompare(b.id),
  )[0];
  const due = anchorOf(hardest)?.getTime() ?? 0;

  const today = localDateOf(now, tz);
  const start = Math.max(nowMs, zonedToUtc({ ...today, ...windowStart }, tz).instant.getTime());
  const end = Math.min(due, zonedToUtc({ ...today, ...windowEnd }, tz).instant.getTime());
  if (end - start < SUGGESTION_MIN_GAP_MS) return null;

  const blocks = mergeIntervals(busy.map((b) => ({ start: b.start.getTime(), end: b.end.getTime() })));
  const gaps: { start: number; end: number }[] = [];
  let cursor = start;
  for (const b of blocks) {
    if (b.end <= cursor) continue;
    if (b.start >= end) break;
    if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  let best: { start: number; end: number } | null = null;
  for (const g of gaps) {
    const s = Math.ceil(g.start / QUARTER_MS) * QUARTER_MS;
    const e = Math.floor(g.end / QUARTER_MS) * QUARTER_MS;
    if (e - s >= SUGGESTION_MIN_GAP_MS && (best === null || e - s > best.end - best.start)) best = { start: s, end: e };
  }
  if (best === null) return null;
  return {
    itemLabel: itemLabel(hardest.title, hardest.course),
    gap: formatTimeRange(new Date(best.start), new Date(best.end), tz, now),
  };
}

/**
 * Human text for one briefing note (labels are third-party; wrapped later by the prompt).
 * @param n the note
 * @param tz user zone
 * @param now reference instant
 * @returns one line, or null for notes with nothing to say
 */
export function noteText(n: BriefingNoteInput, tz: string, now: Date): string | null {
  const p = n.payload;
  const str = (k: string): string | null => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string) : null);
  const time = (k: string): string | null => {
    const s = str(k);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : formatForChat(d, tz, now);
  };
  const label = itemLabel(str("title"), str("course"));
  switch (n.kind) {
    case "due_changed": {
      const next = time("newDue");
      if (!next) return null;
      const prev = time("oldDue");
      return prev ? `${label} moved: ${prev} → ${next}` : `${label} is now due ${next}`;
    }
    case "item_removed": {
      const count = typeof p.count === "number" ? p.count : null;
      if (count && count > 1) return `${count} deadlines disappeared from Canvas (cancelled?)`;
      return `${label} disappeared from Canvas (cancelled?)`;
    }
    case "reminder_cancelled": {
      const text = str("text");
      return text ? `cancelled your reminder "${clip(oneLine(text), 80)}" (its deadline went away)` : null;
    }
    case "reminder_expired": {
      const text = str("text");
      return text ? `missed reminder: "${clip(oneLine(text), 80)}"` : null;
    }
    case "alert_expired": {
      const next = time("newDue");
      const prev = time("oldDue");
      if (prev && next) return `${label} moved: ${prev} → ${next}`;
      return next ? `new on Canvas: ${label}, due ${next}` : `${label} changed`;
    }
    case "preference_proposal":
      return null; // proposals come from `listQueuedProposals`
    default: {
      const text = str("text");
      return text ? clip(oneLine(text), 160) : null;
    }
  }
}

/**
 * Assemble the briefing content deterministically.
 * - daily: today's deadlines, tomorrow-before-noon deadlines, today's classes/events, exam
 *   countdown, load, changes (notes), ≤3 emails, one suggestion; Monday adds the 7-day view.
 * - catch-up: deadlines still ahead today and anything else due ≤36h, remaining events, changes.
 * @param inputs loaded inputs
 * @returns the snapshot (`kind` "empty" for a daily non-Monday briefing with nothing to say)
 */
export function buildBriefingSnapshot(inputs: BriefingInputs): BriefingSnapshot {
  const tz = safeTimeZone(inputs.user.tz);
  const now = inputs.now;
  const nowMs = now.getTime();
  const day = inputs.localDate;
  const tomorrow = addLocalDays(day, 1);
  const catchup = inputs.mode === "catchup";
  const weekday = weekdayOf(day);

  const upcoming = inputs.items.filter((v) => v.status === "upcoming");
  const deadlines = upcoming.filter(isDeadline);
  const events = upcoming.filter((v) => !isDeadline(v));

  const dueToday: SnapshotItem[] = [];
  const dueNext: SnapshotItem[] = [];
  for (const v of deadlines) {
    const d = localDayOf(v, tz);
    const anchor = anchorOf(v);
    if (!d || !anchor) continue;
    const timed = !v.allDayDate && !v.allDay;
    if (sameDate(d, day)) {
      if (!timed || anchor.getTime() >= nowMs) dueToday.push(toSnapshotItem(v, tz, now, true));
      continue;
    }
    if (catchup) {
      if (anchor.getTime() > nowMs && anchor.getTime() <= nowMs + CATCHUP_HORIZON_MS) dueNext.push(toSnapshotItem(v, tz, now, false));
    } else if (sameDate(d, tomorrow) && timed && toLocal(anchor, tz).hour < 12) {
      dueNext.push(toSnapshotItem(v, tz, now, false));
    }
  }

  const todayEvents: { sort: number; e: SnapshotEvent }[] = [];
  for (const v of events) {
    const d = localDayOf(v, tz);
    if (!d || !sameDate(d, day)) continue;
    const start = v.startsAt ?? v.dueAt;
    const end = v.endsAt;
    const over = end ?? start;
    if (catchup && over && over.getTime() <= nowMs) continue;
    const allDay = Boolean(v.allDayDate || v.allDay);
    let when = "all day";
    if (!allDay && start) {
      const s = toLocal(start, tz);
      if (end && end.getTime() > start.getTime()) {
        const e = toLocal(end, tz);
        const same = s.hour < 12 === e.hour < 12;
        when = `${same ? clock(s).replace(/(am|pm)$/, "") : clock(s)}–${clock(e)}`;
      } else when = clock(s);
    }
    todayEvents.push({ sort: allDay ? -1 : (start?.getTime() ?? 0), e: { label: itemLabel(v.title, v.course), when, source: v.source } });
  }
  todayEvents.sort((a, b) => a.sort - b.sort);

  const due48h = deadlines.filter((v) => {
    const a = anchorOf(v)?.getTime();
    return a !== undefined && a >= nowMs && a <= nowMs + 48 * HOUR_MS;
  }).length;
  const weekCount = deadlines.filter((v) => {
    const a = anchorOf(v)?.getTime();
    return a !== undefined && a >= nowMs && a < nowMs + 7 * DAY_MS;
  }).length;

  const exams = catchup
    ? []
    : examTouchpoints(deadlines, tz, day).map(({ item, daysUntil }) => ({
        label: itemLabel(item.title, item.course),
        daysUntil,
        source: item.source,
      }));

  const isMonday = weekday === "MO" && !catchup;
  let week: BriefingSnapshot["week"];
  if (isMonday) {
    week = [];
    for (let i = 0; i < 7; i += 1) {
      const d = addLocalDays(day, i);
      const its = deadlines
        .filter((v) => {
          const ld = localDayOf(v, tz);
          return ld !== null && sameDate(ld, d);
        })
        .map((v) => toSnapshotItem(v, tz, now, i === 0));
      if (its.length > 0) week.push({ day: i === 0 ? "today" : dateLabel(d), items: its });
    }
  }

  const changes: BriefingSnapshot["changes"] = [];
  for (const n of inputs.notes) {
    if (changes.length >= MAX_CHANGES) break;
    const text = noteText(n, tz, now);
    if (text) changes.push({ noteId: n.id, text });
  }

  const emails = catchup
    ? []
    : inputs.emails.slice(0, MAX_EMAILS).map((e) => ({
        id: e.id,
        from: clip(oneLine(e.from) || "someone", 60),
        subject: clip(oneLine(e.subject) || "(no subject)", SUBJECT_MAX),
        kind: e.kind,
      }));

  const busy = [
    ...inputs.busy,
    ...events
      .filter((v) => !v.allDay && !v.allDayDate && v.startsAt && v.endsAt)
      .map((v) => ({ start: v.startsAt as Date, end: v.endsAt as Date })),
  ];
  const suggestion = catchup ? null : findSuggestion(deadlines, busy, tz, now, inputs.user.briefingTime);

  const snapshot: BriefingSnapshot = {
    kind: catchup ? "catchup" : isMonday ? "monday" : "daily",
    localDate: formatLocalDate(day),
    localDateLabel: dateLabel(day),
    weekday,
    name: inputs.user.name ? clip(oneLine(inputs.user.name), 40) || null : null,
    load: computeLoad(due48h),
    due48h,
    dueToday,
    dueNext,
    ...(week ? { week } : {}),
    events: todayEvents.slice(0, MAX_EVENTS).map((x) => x.e),
    exams,
    changes,
    emails,
    suggestion,
    proposal: catchup ? null : inputs.proposal,
    weekCount,
    integrations: inputs.integrations,
  };
  if (snapshot.kind === "daily" && isEmptySnapshot(snapshot)) snapshot.kind = "empty";
  return snapshot;
}

/**
 * True when the snapshot has nothing to say (no deadlines, events, exams, changes, emails,
 * week items or question).
 * @param s snapshot
 * @returns whether it is empty
 */
export function isEmptySnapshot(s: BriefingSnapshot): boolean {
  return (
    s.dueToday.length === 0 &&
    s.dueNext.length === 0 &&
    s.events.length === 0 &&
    s.exams.length === 0 &&
    s.changes.length === 0 &&
    s.emails.length === 0 &&
    (s.week?.length ?? 0) === 0 &&
    s.proposal === null
  );
}

/** JSON with sorted keys (stable hash input). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/**
 * Freshness hash: sha256 of the snapshot's canonical JSON (key order irrelevant). A due move,
 * title change, new note or email changes it.
 * @param s snapshot
 * @returns hex digest
 */
export function snapshotHash(s: BriefingSnapshot): string {
  return createHash("sha256").update(canonical(s)).digest("hex");
}

/** History the delivery decision needs (read by `run.ts`). */
export interface BriefingHistory {
  /** kind + status of the briefings on the two previous local dates (missing dates omitted) */
  previous: { localDate: string; kind: string; status: string }[];
  /** connect-Canvas nudges sent so far (lifetime) */
  connectNudgesSent: number;
  /** briefings sent with the one-line Canvas hint (lifetime) */
  canvasHintsSent: number;
  /** local days between signup and the briefing's local date */
  daysSinceSignup: number;
}

/** What to do with a built snapshot. */
export type BriefingDecision =
  | { action: "send"; kind: BriefingKind; connectAttempt?: 1 | 2 | 3; canvasHint: boolean }
  | { action: "skip"; reason: "empty_catchup" | "nothing_connected" | "empty_weekend" | "empty_streak" };

/**
 * Delivery rules (V2-06 §13 Q4/Q5):
 * - catch-up with nothing → skip;
 * - nothing connected and nothing to say → connect-Canvas nudge on days 1/3/7 after signup (max 3
 *   lifetime; a missed day rolls forward), else skip;
 * - empty weekday → a one-bubble check-in at most 2 days in a row; empty weekend → skip; Monday
 *   always sends (week view);
 * - otherwise send; Google-only users get a one-line Canvas hint at most 3 times.
 * @param s snapshot
 * @param h briefing history
 * @returns send (with kind) or skip (with reason)
 */
export function decideBriefing(s: BriefingSnapshot, h: BriefingHistory): BriefingDecision {
  const empty = isEmptySnapshot(s);
  const canvasHint = !s.integrations.canvas && h.canvasHintsSent < MAX_CANVAS_HINTS;
  if (s.kind === "catchup") return empty ? { action: "skip", reason: "empty_catchup" } : { action: "send", kind: "catchup", canvasHint: false };
  if (empty && !s.integrations.canvas && !s.integrations.google) {
    const sent = h.connectNudgesSent;
    if (sent < CONNECT_NUDGE_DAYS.length && h.daysSinceSignup >= CONNECT_NUDGE_DAYS[sent]) {
      return { action: "send", kind: "connect_nudge", connectAttempt: (sent + 1) as 1 | 2 | 3, canvasHint: false };
    }
    return { action: "skip", reason: "nothing_connected" };
  }
  if (s.kind === "monday") return { action: "send", kind: "monday", canvasHint };
  if (empty) {
    if (s.weekday === "SA" || s.weekday === "SU") return { action: "skip", reason: "empty_weekend" };
    const day = parseLocalDate(s.localDate);
    const prior = day ? [addLocalDays(day, -1), addLocalDays(day, -2)].map(formatLocalDate) : [];
    const streak = prior.every((d) => h.previous.some((p) => p.localDate === d && p.kind === "empty" && p.status === "sent"));
    if (prior.length === MAX_EMPTY_STREAK && streak) return { action: "skip", reason: "empty_streak" };
    return { action: "send", kind: "empty", canvasHint };
  }
  return { action: "send", kind: s.kind, canvasHint };
}

/**
 * Start (local midnight) of a local date, for range queries.
 * @param d local date
 * @param tz user zone
 * @returns the instant
 */
export function localDayStart(d: LocalDate, tz: string): Date {
  return midnight(d, safeTimeZone(tz));
}
