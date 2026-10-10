import "server-only";
// OWNER: 1.4

/**
 * Canvas feed → `TimelineItemInput[]` (V2-05 §2.1, §2.3, §2.4, §7.2 `parse.ts`). Pure.
 *
 * Fixes V1's bugs (salvaged from `celery_worker/canvas/parse.py`): the course is the trailing
 * `[course code]` (not a `" - "` split), and a date-only due date is 23:59 in the user's zone (not
 * 23:59:59Z, which showed as 7:59pm in New York). Kept from V1: skip VEVENTs without DTSTART, key by
 * UID, and only a due-date change counts as a change (title edits are silent; see `timeline/diff.ts`).
 */
import type { JsonValue, TimelineItemInput } from "@/server/timeline/types";
import { timingKeyOf, type IcsCalendar, type IcsDateValue, type IcsEvent } from "@/server/integrations/canvas/ics";
import { addLocalDays, isValidTimeZone, safeTimeZone, zonedToUtc, type LocalDate } from "@/shared/time/tz";

/** Per-sync context: the user's zone (for date-only and floating values) and the feed's host. */
export interface CanvasParseContext {
  timezone: string;
  host: string;
}

export interface ParsedCanvasFeed {
  items: TimelineItemInput[];
  counts: { assignments: number; events: number };
  warnings: {
    duplicateUids: number;
    skippedNoStart: number;
    skippedNoUid: number;
    capSaturated: { assignments: boolean; events: boolean };
  };
  looksLikeCanvas: boolean;
}

/** Canvas's per-kind feed cap (`paginate(per_page: 1000, max: 1000)`); at or above it the feed is truncated. */
export const CANVAS_FEED_CAP = 1000;
const MAX_TITLE = 300;
const MAX_COURSE = 100;
const MAX_URL = 2048;
const MAX_DESCRIPTION = 1000;
const MAX_UID = 255;

const CANVAS_UID_RE = /^event-(?:assignment|calendar-event|assignment-override|sub-assignment)-\d+$/;
const EXAM_RE = /\b(?:mid-?terms?|exams?|final exam|prelims?)\b/i;
const NOT_EXAM_RE = /\b(?:practice|review|prep|study|corrections?|wrapper|reflection)\b/i;

/**
 * Maps a lexed Canvas calendar to timeline inputs.
 * Duplicate UIDs: last one in file order wins. Items without UID or DTSTART are skipped (counted).
 * @param cal output of `lexIcs`
 * @param ctx user time zone + feed host (for same-host links)
 * @returns items, counts by UID family, warnings, and whether the body looks like Canvas
 */
export function parseCanvasFeed(cal: IcsCalendar, ctx: CanvasParseContext): ParsedCanvasFeed {
  const tz = safeTimeZone(ctx.timezone);
  const host = ctx.host.toLowerCase();
  const warnings: ParsedCanvasFeed["warnings"] = {
    duplicateUids: 0,
    skippedNoStart: 0,
    skippedNoUid: 0,
    capSaturated: { assignments: false, events: false },
  };

  const byUid = new Map<string, IcsEvent>();
  for (const ev of cal.events) {
    const uid = ev.uid?.trim() ?? "";
    if (uid === "" || uid.length > MAX_UID) {
      warnings.skippedNoUid++;
      continue;
    }
    if (!ev.dtstart) {
      warnings.skippedNoStart++;
      continue;
    }
    if (byUid.has(uid)) {
      warnings.duplicateUids++;
      byUid.delete(uid); // re-insert below so order follows the last occurrence
    }
    byUid.set(uid, ev);
  }

  const items: TimelineItemInput[] = [];
  let assignments = 0;
  let events = 0;
  let looksLikeCanvas =
    /icalendar-ruby/i.test(cal.prodid ?? "") || /\(Canvas\)\s*$/.test(cal.calName ?? "");

  for (const [uid, ev] of byUid) {
    const dtstart = ev.dtstart as IcsDateValue;
    const k = uidKind(uid);
    if (CANVAS_UID_RE.test(uid)) looksLikeCanvas = true;
    if (isAssignmentFamily(k)) assignments++;
    else events++;

    const { title, course } = splitSummary(ev.summary);
    const kind = inferKind(k, title);
    const timing = resolveTiming(kind, k, dtstart, ev.dtend, tz);
    const timingKey = timingKeyOf(dtstart);

    items.push({
      externalId: uid,
      kind,
      title: clip(title, MAX_TITLE) || "Untitled",
      course: course === null ? null : clip(course, MAX_COURSE),
      startsAt: timing.startsAt,
      endsAt: timing.endsAt,
      dueAt: timing.dueAt,
      allDay: timing.allDay,
      url: deriveItemUrl(ev.url, host),
      timingKey,
      matchKey: matchKeyOf(k, ev.url),
      raw: rawOf(uid, ev, timingKey),
    });
  }

  warnings.capSaturated = { assignments: assignments >= CANVAS_FEED_CAP, events: events >= CANVAS_FEED_CAP };
  return { items, counts: { assignments, events }, warnings, looksLikeCanvas };
}

/**
 * Splits a Canvas SUMMARY into title and the trailing `[course code]` (linear time, no regex backtracking).
 * Override summaries keep their suffix in the title: "Pset 5 (Extension) [CPSC 323]" → "Pset 5 (Extension)".
 * @param summary unescaped SUMMARY
 * @returns e.g. "Lab [Part 2] [CHEM 134L]" → `{ title: "Lab [Part 2]", course: "CHEM 134L" }`; no group → course null
 */
export function splitSummary(summary: string): { title: string; course: string | null } {
  const text = oneLine(summary ?? "");
  if (!text.endsWith("]")) return { title: text, course: null };
  const open = text.lastIndexOf("[");
  if (open < 0) return { title: text, course: null };
  const inner = text.slice(open + 1, -1);
  const course = oneLine(inner);
  if (inner.includes("]") || course === "") return { title: text, course: null };
  const title = text.slice(0, open).trim();
  return { title: title === "" ? course : title, course };
}

/** Canvas UID family (from `CalendarEvent::IcalEvent#to_ics`). */
export type CanvasUidKind = "assignment" | "assignment_override" | "sub_assignment" | "calendar_event" | "unknown";

/**
 * Classifies a Canvas UID.
 * @param uid VEVENT UID
 * @returns the UID family, "unknown" for non-Canvas UIDs
 */
export function uidKind(uid: string): CanvasUidKind {
  if (/^event-assignment-override-\d+$/.test(uid)) return "assignment_override";
  if (/^event-assignment-\d+$/.test(uid)) return "assignment";
  if (/^event-sub-assignment-\d+$/.test(uid)) return "sub_assignment";
  if (/^event-calendar-event-\d+$/.test(uid)) return "calendar_event";
  return "unknown";
}

/**
 * Timeline kind: exam iff the title matches `/\b(mid-?terms?|exams?|final exam|prelims?)\b/i` and not
 * `/\b(practice|review|prep|study|corrections?|wrapper|reflection)\b/i`; otherwise assignment for
 * assignment-family UIDs and event for calendar events and unknown UIDs.
 * @param k UID family
 * @param title split title (no course suffix)
 * @returns "assignment" | "exam" | "event"
 */
export function inferKind(k: CanvasUidKind, title: string): "assignment" | "exam" | "event" {
  if (EXAM_RE.test(title) && !NOT_EXAM_RE.test(title)) return "exam";
  return isAssignmentFamily(k) ? "assignment" : "event";
}

/**
 * Canvas object key from the URL fragment, stable across the override UID switch.
 * Null for sub-assignments (the fragment is the parent's, not unique) and unknown UIDs.
 * @param k UID family
 * @param url VEVENT URL
 * @returns "assignment_412345" | "calendar_event_77" | null
 */
export function matchKeyOf(k: CanvasUidKind, url: string | null): string | null {
  if (!url) return null;
  const m = /#(assignment|calendar_event)_(\d{1,20})$/.exec(url.trim());
  if (!m) return null;
  if ((k === "assignment" || k === "assignment_override") && m[1] === "assignment") return `assignment_${m[2]}`;
  if (k === "calendar_event" && m[1] === "calendar_event") return `calendar_event_${m[2]}`;
  return null;
}

/**
 * Link for the item, same host as the feed only (an instructor-authored URL never points elsewhere).
 * @param calendarUrl VEVENT URL (`https://<host>/calendar?include_contexts=course_<cid>&…#assignment_<id>`)
 * @param feedHost normalized feed host
 * @returns direct `https://<host>/courses/<cid>/assignments/<id>`, else the same-host calendar URL, else null
 */
export function deriveItemUrl(calendarUrl: string | null, feedHost: string): string | null {
  if (!calendarUrl) return null;
  let u: URL;
  try {
    u = new URL(calendarUrl.trim());
  } catch {
    return null;
  }
  const host = feedHost.toLowerCase().replace(/\.$/, "");
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return null;
  if (u.hostname.toLowerCase().replace(/\.$/, "") !== host) return null;

  const frag = /^#assignment_(\d{1,20})$/.exec(u.hash);
  const ctx = /(?:^|,)course_(\d{1,20})(?:,|$)/.exec(u.searchParams.get("include_contexts") ?? "");
  if (frag && ctx) return `https://${host}/courses/${ctx[1]}/assignments/${frag[1]}`;

  const out = `https://${host}${u.pathname}${u.search}${u.hash}`;
  return out.length <= MAX_URL ? out : null;
}

/**
 * Instants for an item (V2-05 §2.3). Assignment-family UIDs get a due time; calendar events get a span.
 * - UTC → as is. TZID: IANA zone → convert there; else the feed's VTIMEZONE; else floating.
 * - Floating → the user's zone.
 * - Date-only assignment → 23:59 local on that date ("fancy midnight"), `allDay: true`.
 * - Date-only event → local midnight to local midnight of DTEND (default next day), `allDay: true`.
 * DST: gaps shift forward, overlaps take the earlier instant (`zonedToUtc`).
 * @param kind inferred kind
 * @param k UID family
 * @param dtstart DTSTART literal
 * @param dtend DTEND literal, if any
 * @param tz user's IANA zone
 * @returns `dueAt` for assignment-family items, `startsAt`/`endsAt` for events
 */
export function resolveTiming(
  kind: "assignment" | "exam" | "event",
  k: CanvasUidKind,
  dtstart: IcsDateValue,
  dtend: IcsDateValue | null,
  tz: string,
): { dueAt: Date | null; startsAt: Date | null; endsAt: Date | null; allDay: boolean } {
  const zone = safeTimeZone(tz);
  const dueSemantics = isAssignmentFamily(k) || (k === "unknown" && kind === "assignment");

  if (dtstart.kind === "date") {
    const day: LocalDate = { year: dtstart.year, month: dtstart.month, day: dtstart.day };
    if (dueSemantics) {
      return { dueAt: zonedToUtc({ ...day, hour: 23, minute: 59 }, zone).instant, startsAt: null, endsAt: null, allDay: true };
    }
    const startsAt = zonedToUtc({ ...day, hour: 0, minute: 0 }, zone).instant;
    let endDay = addLocalDays(day, 1);
    if (dtend && dtend.kind === "date") {
      const d: LocalDate = { year: dtend.year, month: dtend.month, day: dtend.day };
      if (zonedToUtc({ ...d, hour: 0, minute: 0 }, zone).instant.getTime() > startsAt.getTime()) endDay = d;
    }
    const endsAt = zonedToUtc({ ...endDay, hour: 0, minute: 0 }, zone).instant;
    return { dueAt: null, startsAt, endsAt, allDay: true };
  }

  const start = instantOf(dtstart, zone);
  if (dueSemantics) return { dueAt: start, startsAt: null, endsAt: null, allDay: false };
  const end = dtend && dtend.kind !== "date" ? instantOf(dtend, zone) : null;
  return { dueAt: null, startsAt: start, endsAt: end && end.getTime() >= start.getTime() ? end : start, allDay: false };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isAssignmentFamily(k: CanvasUidKind): boolean {
  return k === "assignment" || k === "assignment_override" || k === "sub_assignment";
}

/** Instant of a timed literal. */
function instantOf(v: Exclude<IcsDateValue, { kind: "date" }>, tz: string): Date {
  switch (v.kind) {
    case "utc":
      return new Date(v.iso);
    case "zoned":
      if (isValidTimeZone(v.tzid)) return withSeconds(zonedToUtc(v.wall, v.tzid).instant, v.wall.second);
      if (v.utcFromVtimezone) return new Date(v.utcFromVtimezone);
      return withSeconds(zonedToUtc(v.wall, tz).instant, v.wall.second);
    case "floating":
      return withSeconds(zonedToUtc(v.wall, tz).instant, v.wall.second);
  }
}

function withSeconds(d: Date, s: number): Date {
  return s > 0 ? new Date(d.getTime() + Math.min(s, 59) * 1000) : d;
}

function rawOf(uid: string, ev: IcsEvent, timingKey: string): { [k: string]: JsonValue } {
  return {
    uid,
    dtstart: timingKey,
    dtend: ev.dtend ? timingKeyOf(ev.dtend) : null,
    calendar_url: ev.url ? clip(ev.url.trim(), MAX_URL) : null,
    description: ev.description ? plainDescription(ev.description) : null,
    dtstamp: ev.dtstamp,
  };
}

/** Plain text, control characters removed, whitespace collapsed, ≤ 1,000 chars. Never goes in a prompt by default. */
function plainDescription(s: string): string | null {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? " " : ch;
  }
  out = oneLine(out);
  return out === "" ? null : clip(out, MAX_DESCRIPTION);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Truncates by code points (never splits a surrogate pair). */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}
