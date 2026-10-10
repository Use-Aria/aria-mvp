import "server-only";
// OWNER: 3.5

/**
 * Parsed syllabus → timeline items (V2-08 §7.2 `timeline-map.ts`). Pure.
 *
 * - External ids are `syl:<courseKey>:<sha1(kind|normTitle|ordinal)[:16]>`: stable when only the
 *   date changes, distinct for repeated titles ("Quiz", "Quiz" → ordinals 0, 1).
 * - Undated items (date unresolved) and past items are skipped.
 * - All-day (master plan C28: the `all_day` column): exams span local midnight → next midnight,
 *   assignments are due 23:59 local (the Canvas convention); the timing key is the floating
 *   `YYYY-MM-DD` date so a timezone change rebases them. Timed items keep their UTC instants.
 */
import { createHash } from "node:crypto";
import type { ParsedAssignment, ParsedExam, ParsedSyllabus } from "@/server/integrations/syllabus/contract";
import type { JsonValue, TimelineUpsert } from "@/server/timeline/types";
import { addLocalDays, parseLocalDate, safeTimeZone, zonedToUtc } from "@/shared/time/tz";

const MAX_TITLE = 300;

/**
 * Title normalization used in external ids (case/spacing/punctuation-insensitive).
 * @param title item title
 * @returns lowercase alphanumeric words joined by single spaces
 */
export function normTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Stable external id of one syllabus item.
 * @param courseKey normalized course key, e.g. "CPSC223"
 * @param kind exam | assignment
 * @param title item title
 * @param ordinal 0-based index among items of the same kind and normalized title
 * @returns `syl:<courseKey>:<16 hex>`
 */
export function syllabusExternalId(courseKey: string, kind: "exam" | "assignment", title: string, ordinal: number): string {
  const h = createHash("sha1").update(`${kind}|${normTitle(title)}|${ordinal}`).digest("hex").slice(0, 16);
  return `syl:${courseKey}:${h}`;
}

/** External-id prefix of every item of one course (prune scope). */
export function syllabusIdPrefix(courseKey: string): string {
  return `syl:${courseKey}:`;
}

function withOrdinals<T extends { title: string }>(items: readonly T[]): { item: T; ordinal: number }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const k = normTitle(item.title);
    const ordinal = seen.get(k) ?? 0;
    seen.set(k, ordinal + 1);
    return { item, ordinal };
  });
}

function instant(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function localMidnight(date: string, tz: string, plusDays = 0): Date | null {
  const d = parseLocalDate(date);
  if (!d) return null;
  return zonedToUtc({ ...addLocalDays(d, plusDays), hour: 0, minute: 0 }, tz).instant;
}

interface Timing {
  startsAt: Date | null;
  endsAt: Date | null;
  dueAt: Date | null;
  allDay: boolean;
  timingKey?: string;
  /** the item is over after this instant */
  end: Date;
}

/**
 * Timeline timing of a parsed exam, or null when undated.
 * @param e parsed exam
 * @param tz syllabus timezone
 * @returns timing, or null
 */
export function examTiming(e: ParsedExam, tz: string): Timing | null {
  if (!e.date) return null;
  const start = instant(e.starts_at_utc);
  if (!e.all_day && start) {
    const end = instant(e.ends_at_utc);
    return { startsAt: start, endsAt: end, dueAt: null, allDay: false, end: end ?? start };
  }
  const s = start ?? localMidnight(e.date, tz);
  const en = (e.all_day ? instant(e.ends_at_utc) : null) ?? localMidnight(e.date, tz, 1);
  if (!s || !en) return null;
  return { startsAt: s, endsAt: en, dueAt: null, allDay: true, timingKey: e.date, end: en };
}

/**
 * Timeline timing of a parsed assignment, or null when undated.
 * @param a parsed assignment
 * @param tz syllabus timezone
 * @returns timing, or null
 */
export function assignmentTiming(a: ParsedAssignment, tz: string): Timing | null {
  if (!a.due_date) return null;
  const due = instant(a.due_at_utc);
  if (!a.all_day && due) return { startsAt: null, endsAt: null, dueAt: due, allDay: false, end: due };
  const d = parseLocalDate(a.due_date);
  if (!d) return null;
  const at = zonedToUtc({ ...d, hour: 23, minute: 59 }, tz).instant;
  return { startsAt: null, endsAt: null, dueAt: at, allDay: true, timingKey: a.due_date, end: at };
}

/**
 * External ids of every dated item (past ones included), for the replace-prune `keep` list.
 * @param courseKey normalized course key
 * @param parsed normalized syllabus
 * @returns external ids
 */
export function syllabusItemIds(courseKey: string, parsed: ParsedSyllabus): string[] {
  const ids: string[] = [];
  for (const { item, ordinal } of withOrdinals(parsed.exams)) {
    if (item.date) ids.push(syllabusExternalId(courseKey, "exam", item.title, ordinal));
  }
  for (const { item, ordinal } of withOrdinals(parsed.assignments)) {
    if (item.due_date) ids.push(syllabusExternalId(courseKey, "assignment", item.title, ordinal));
  }
  return ids;
}

/**
 * Parsed syllabus → `TimelineUpsert[]` (source `syllabus`), skipping undated and past items.
 * @param args course key + label, syllabus row id, normalized syllabus, clock
 * @returns items to upsert
 */
export function toTimelineItems(args: {
  courseKey: string;
  courseLabel: string;
  syllabusId: string;
  parsed: ParsedSyllabus;
  now: Date;
}): TimelineUpsert[] {
  const tz = safeTimeZone(args.parsed.timezone);
  const out: TimelineUpsert[] = [];
  const base = (raw: Record<string, JsonValue>) => ({ syllabus_id: args.syllabusId, ...raw });

  for (const { item: e, ordinal } of withOrdinals(args.parsed.exams)) {
    const t = examTiming(e, tz);
    if (!t || t.end.getTime() < args.now.getTime()) continue;
    out.push({
      source: "syllabus",
      externalId: syllabusExternalId(args.courseKey, "exam", e.title, ordinal),
      kind: "exam",
      title: e.title.slice(0, MAX_TITLE) || "Exam",
      course: args.courseLabel,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      dueAt: null,
      allDay: t.allDay,
      ...(t.timingKey ? { timingKey: t.timingKey } : {}),
      raw: base({
        weight_pct: e.weight_pct,
        topics: e.topics,
        date_text: e.date_text,
        all_day: t.allDay,
        location: e.location,
        date_confidence: e.date_confidence,
        exam_kind: e.kind,
      }),
    });
  }

  for (const { item: a, ordinal } of withOrdinals(args.parsed.assignments)) {
    const t = assignmentTiming(a, tz);
    if (!t || t.end.getTime() < args.now.getTime()) continue;
    out.push({
      source: "syllabus",
      externalId: syllabusExternalId(args.courseKey, "assignment", a.title, ordinal),
      kind: "assignment",
      title: a.title.slice(0, MAX_TITLE) || "Assignment",
      course: args.courseLabel,
      startsAt: null,
      endsAt: null,
      dueAt: t.dueAt,
      allDay: t.allDay,
      ...(t.timingKey ? { timingKey: t.timingKey } : {}),
      raw: base({
        weight_pct: a.weight_pct,
        topics: [],
        date_text: a.due_text,
        all_day: t.allDay,
        location: "",
        date_confidence: a.date_confidence,
        category: a.category,
      }),
    });
  }
  return out;
}
