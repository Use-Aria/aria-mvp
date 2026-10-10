import "server-only";
// OWNER: 2.3

/**
 * Read views, search ranking, model rendering and named ranges (V2-05 §7.3 `view.ts`). Pure.
 */
import { wrapUntrusted, type UntrustedSource } from "@/server/agent/untrusted";
import { courseKey } from "@/shared/course-key";
import {
  addLocalDays,
  formatForChat,
  formatForTool,
  localDateOf,
  parseLocalDate,
  parseLocalDateTime,
  weekdayOf,
  zonedToUtc,
  type LocalDate,
} from "@/shared/time/tz";
import type { JsonValue, TimelineItem, TimelineItemView, TimelineSource } from "@/server/timeline/types";
import { allDayDateOf, computeUrgency, DEADLINE_KINDS, urgencyScore } from "@/server/timeline/urgency";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_RENDER_MAX = 40;

/** Named local range for agenda tools. */
export type AgendaRange = "today" | "tomorrow" | "next_48h" | "this_week" | "next_week" | "next_7_days" | "next_14_days";

/**
 * Model/web-facing ref for an item id.
 * @param id timeline_items.id (uuid)
 * @returns "t_" + first 8 hex characters
 */
export function refOf(id: string): string {
  return `t_${id.replace(/-/g, "").toLowerCase().slice(0, 8)}`;
}

/** Noon of a local date in `tz` (a safe instant for labelling an all-day date). */
function noonOf(d: LocalDate, tz: string): Date {
  return zonedToUtc({ ...d, hour: 12, minute: 0 }, tz).instant;
}

/**
 * Syllabus info (grade weight + topics) from a syllabus item's `raw` (written by
 * `integrations/syllabus/timeline-map.ts`: `{ weight_pct, topics, ... }`). Defensive: a non-finite
 * or non-number weight → null, non-string topics dropped, a non-array `topics` → [].
 * @param raw stored `raw` JSON
 * @returns the info, or null when `raw` is missing/not an object or carries neither field
 */
function syllabusInfoOf(raw: { [k: string]: JsonValue } | null): { weight_pct: number | null; topics: string[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!("weight_pct" in raw) && !("topics" in raw)) return null;
  const w = raw.weight_pct;
  const t = raw.topics;
  return {
    weight_pct: typeof w === "number" && Number.isFinite(w) ? w : null,
    topics: Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [],
  };
}

/**
 * Item → read view: ref, course key, floating all-day date, urgency (computed now), label;
 * syllabus items also carry `syllabus` (weight/topics from `raw`) when present.
 * @param item stored item
 * @param now clock
 * @param tz user zone
 * @returns the view
 */
export function toView(item: TimelineItem, now: Date, tz: string): TimelineItemView {
  const allDayDate = allDayDateOf(item, tz);
  const anchor = item.anchorAt;
  let label = "";
  if (anchor) {
    const day = allDayDate ? parseLocalDate(allDayDate) : null;
    label = day ? formatForChat(noonOf(day, tz), tz, now, { allDay: true }) : formatForChat(anchor, tz, now, { allDay: item.allDay });
  }
  return {
    id: item.id,
    ref: refOf(item.id),
    source: item.source,
    kind: item.kind,
    title: item.title,
    course: item.course,
    courseKey: courseKey(item.course),
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    dueAt: item.dueAt,
    allDay: item.allDay,
    allDayDate,
    url: item.url,
    status: item.status,
    urgency: computeUrgency(item, now, tz),
    urgencyScore: urgencyScore(item, now),
    hoursUntil: anchor ? Math.round(((anchor.getTime() - now.getTime()) / HOUR_MS) * 10) / 10 : null,
    label,
    ...syllabusField(item),
  };
}

function syllabusField(item: TimelineItem): Pick<TimelineItemView, "syllabus"> {
  if (item.source !== "syllabus") return {};
  const info = syllabusInfoOf(item.raw);
  return info ? { syllabus: info } : {};
}

// ── search ──────────────────────────────────────────────────────────────────

function tokens(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}&]+/u)
    .filter((t) => t !== "");
}

/** 3 = whole word, 2 = word prefix, 1 = substring, 0 = no match. */
function tokenScore(token: string, words: string[], haystack: string, key: string): number {
  if (key !== "" && (key === token || /\d+[a-z]?$/.exec(key)?.[0] === token)) return 3;
  let best = 0;
  for (const w of words) {
    if (w === token) return 3;
    if (w.startsWith(token)) best = Math.max(best, 2);
  }
  if (best === 0 && (haystack.includes(token) || (key !== "" && key.includes(token)))) best = 1;
  return best;
}

/** Past = anchored before now, except upcoming deadlines that are overdue by ≤ 7 days. */
function isPast(item: TimelineItem, now: Date): boolean {
  if (!item.anchorAt) return false;
  const delta = item.anchorAt.getTime() - now.getTime();
  if (delta >= 0) return false;
  return !(DEADLINE_KINDS.has(item.kind) && item.status === "upcoming" && -delta <= 7 * DAY_MS);
}

/**
 * Token-AND search over title + course (with a course-key alias: "323" / "cpsc323" match
 * "CPSC 323 01 (FA26)"), ranked by match quality, then nearest upcoming, then most recent past.
 * @param items candidate items (already owner-scoped, non-removed)
 * @param query free text
 * @param now clock
 * @param opts includePast: keep items before now (default false; ≤ 7d-overdue deadlines are always kept)
 * @returns matching items, best first
 */
export function rankSearch(items: TimelineItem[], query: string, now: Date, opts?: { includePast?: boolean }): TimelineItem[] {
  const q = tokens(query);
  if (q.length === 0) return [];
  const wholeKey = courseKey(query)?.toLowerCase() ?? "";
  const scored: { item: TimelineItem; score: number }[] = [];
  for (const item of items) {
    if (item.removedAt) continue;
    if (!opts?.includePast && isPast(item, now)) continue;
    const text = `${item.title} ${item.course ?? ""}`;
    const words = tokens(text);
    const haystack = words.join(" ");
    const key = (courseKey(item.course) ?? "").toLowerCase();
    let score = 0;
    let all = true;
    for (const t of q) {
      const s = tokenScore(t, words, haystack, key);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all && wholeKey !== "" && !wholeKey.startsWith("t:") && wholeKey === key) {
      all = true;
      score = 3 * q.length;
    }
    if (all) scored.push({ item, score });
  }
  const t0 = now.getTime();
  const rank = (i: TimelineItem): number => {
    if (!i.anchorAt) return Number.MAX_SAFE_INTEGER;
    const d = i.anchorAt.getTime() - t0;
    return d >= 0 ? d : Number.MAX_SAFE_INTEGER / 2 - d; // upcoming first (nearest), then past (most recent)
  };
  scored.sort((a, b) => b.score - a.score || rank(a.item) - rank(b.item) || a.item.id.localeCompare(b.item.id));
  return scored.map((s) => s.item);
}

// ── model rendering ─────────────────────────────────────────────────────────

const UNTRUSTED_FOR: Record<TimelineSource, UntrustedSource> = {
  canvas: "canvas",
  gcal: "calendar",
  aria: "calendar",
  syllabus: "syllabus",
  gmail: "email",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function whenOf(v: TimelineItemView, tz: string | undefined): string {
  if (v.allDayDate) {
    const d = parseLocalDate(v.allDayDate);
    if (d) return `${WEEKDAY[weekdayOf(d)]} ${MONTHS[d.month - 1]} ${d.day} (all day)`;
  }
  const anchor = v.dueAt ?? v.startsAt;
  if (!anchor) return "no date";
  return tz ? formatForTool(anchor, tz) : v.label;
}

/**
 * Model-facing list: one line per item,
 * `[t_a1b2c3d4] Thu Oct 15, 11:59 PM EDT · CPSC 323 · Pset 4 · assignment · soon`,
 * inside `wrapUntrusted({source, body})` (titles/courses are third-party text). Items are grouped
 * per untrusted source in order of first appearance; order within a group is preserved.
 * @param views items to render (already sorted)
 * @param opts max lines (default 40), empty text, timezone (absolute `formatForTool` times; without
 *   it the view's chat label is used), ref (e.g. `v => ctx.aliases.mint("t", v.id)`; default `v.ref`)
 * @returns the rendered text
 */
export function renderTimelineForModel(
  views: TimelineItemView[],
  opts?: { max?: number; emptyText?: string; timezone?: string; ref?: (v: TimelineItemView) => string },
): string {
  if (views.length === 0) return opts?.emptyText ?? "No items.";
  const max = Math.max(1, Math.floor(opts?.max ?? DEFAULT_RENDER_MAX));
  const shown = views.slice(0, max);
  const groups = new Map<UntrustedSource, string[]>();
  for (const v of shown) {
    const parts = [`[${opts?.ref ? opts.ref(v) : v.ref}] ${whenOf(v, opts?.timezone)}`];
    if (v.course) parts.push(oneLine(v.course));
    parts.push(oneLine(v.title) || "Untitled", v.kind, v.urgency);
    if (v.status !== "upcoming") parts.push(v.status);
    const src = UNTRUSTED_FOR[v.source] ?? "web";
    const lines = groups.get(src) ?? [];
    lines.push(parts.join(" · "));
    groups.set(src, lines);
  }
  const blocks = [...groups].map(([source, lines]) => {
    const body = lines.join("\n");
    return wrapUntrusted({ source, body, maxChars: Math.max(2000, body.length + 64) });
  });
  const more = views.length - shown.length;
  if (more > 0) blocks.push(`(+${more} more not shown)`);
  return blocks.join("\n");
}

// ── named ranges ────────────────────────────────────────────────────────────

function midnight(d: LocalDate, tz: string): Date {
  return zonedToUtc({ ...d, hour: 0, minute: 0 }, tz).instant;
}

/** Days from `d` to the next Monday (1–7). */
function daysToNextMonday(d: LocalDate): number {
  const order = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  return 7 - order.indexOf(weekdayOf(d));
}

/**
 * Local range → `[from, to)` instants in `tz` (DST-safe: steps local dates, never adds 24h).
 * - today / tomorrow: that local day; next_48h: [now, now + 48h)
 * - this_week: today → next Monday 00:00 (weeks start Monday); on a Sunday it runs through the
 *   coming week (Sunday + Mon–Sun), since "this week" on a Sunday means the week ahead
 * - next_week: next Monday → the Monday after (on a Sunday: tomorrow → +7d)
 * - next_7_days / next_14_days: today 00:00 → +7 / +14 local days
 * - `{from, to}`: local dates "YYYY-MM-DD", `to` INCLUSIVE; or local date-times "YYYY-MM-DDTHH:MM", `to` exclusive
 * @param range named range or explicit local bounds
 * @param now clock
 * @param tz user zone
 * @returns half-open instant range
 * @throws RangeError on malformed explicit bounds or an empty explicit range
 */
export function resolveRange(range: AgendaRange | { from: string; to: string }, now: Date, tz: string): { from: Date; to: Date } {
  const today = localDateOf(now, tz);
  if (typeof range === "object") {
    const fd = parseLocalDate(range.from);
    const td = parseLocalDate(range.to);
    let from: Date;
    let to: Date;
    if (fd && td) {
      from = midnight(fd, tz);
      to = midnight(addLocalDays(td, 1), tz);
    } else {
      const fdt = fd ? { ...fd, hour: 0, minute: 0 } : parseLocalDateTime(range.from);
      const tdt = td ? { ...addLocalDays(td, 1), hour: 0, minute: 0 } : parseLocalDateTime(range.to);
      if (!fdt || !tdt) throw new RangeError("resolveRange: invalid explicit range");
      from = zonedToUtc(fdt, tz).instant;
      to = zonedToUtc(tdt, tz).instant;
    }
    if (to.getTime() <= from.getTime()) throw new RangeError("resolveRange: empty range (`to` not after `from`)");
    return { from, to };
  }
  switch (range) {
    case "today":
      return { from: midnight(today, tz), to: midnight(addLocalDays(today, 1), tz) };
    case "tomorrow":
      return { from: midnight(addLocalDays(today, 1), tz), to: midnight(addLocalDays(today, 2), tz) };
    case "next_48h":
      return { from: now, to: new Date(now.getTime() + 48 * HOUR_MS) };
    case "this_week": {
      const n = daysToNextMonday(today);
      return { from: midnight(today, tz), to: midnight(addLocalDays(today, n === 1 ? 8 : n), tz) };
    }
    case "next_week": {
      const start = addLocalDays(today, daysToNextMonday(today));
      return { from: midnight(start, tz), to: midnight(addLocalDays(start, 7), tz) };
    }
    case "next_7_days":
      return { from: midnight(today, tz), to: midnight(addLocalDays(today, 7), tz) };
    case "next_14_days":
      return { from: midnight(today, tz), to: midnight(addLocalDays(today, 14), tz) };
  }
}
