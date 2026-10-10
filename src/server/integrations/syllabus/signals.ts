import "server-only";
// OWNER: 3.5

/**
 * Scheduling / briefing signals from saved syllabi (V2-08 §7.2 `signals.ts`). Pure helpers plus
 * one DB reader. Fixes V1's `get_gap_topics` bug (it always used `exams[0]`): `topicsForExam`
 * matches the exam by date (±1 day) or title, and falls back to the schedule topics between the
 * previous exam and this one.
 *
 * Everything returned here is third-party syllabus text: callers that show it to a model must
 * `wrapUntrusted({source: "syllabus", …})` it first.
 */
import { db } from "@/server/db";
import { parsedSyllabusSchema, type ParsedExam, type ParsedSyllabus } from "@/server/integrations/syllabus/contract";
import { titlesMatch } from "@/server/integrations/syllabus/dedupe";
import type { SyllabusRow, SyllabusSignals } from "@/server/integrations/syllabus/types";
import { addLocalDays, formatLocalDate, parseLocalDate, weekdayOf, type LocalDate } from "@/shared/time/tz";

const MAX_TOPICS = 25;
const WEEKDAY_INDEX = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 } as const;

function dayNumber(iso: string): number | null {
  const d = parseLocalDate(iso);
  return d ? Date.UTC(d.year, d.month - 1, d.day) / 86_400_000 : null;
}

/**
 * `parsed_json` → normalized syllabus, or null when the stored JSON doesn't match the contract.
 * @param json stored `syllabi.parsed_json`
 * @returns parsed syllabus or null
 */
export function readParsedJson(json: unknown): ParsedSyllabus | null {
  const r = parsedSyllabusSchema.safeParse(json);
  return r.success ? r.data : null;
}

/**
 * Local date of a schedule row: its own date, or `Monday(term_start week) + 7·(week−1)`.
 * @param row schedule row
 * @param termStart "YYYY-MM-DD" or null
 * @returns "YYYY-MM-DD" or null
 */
export function scheduleRowDate(row: ParsedSyllabus["schedule"][number], termStart: string | null): string | null {
  if (row.date) return row.date;
  if (!row.week || row.week < 1 || !termStart) return null;
  const start = parseLocalDate(termStart);
  if (!start) return null;
  const monday: LocalDate = addLocalDays(start, -WEEKDAY_INDEX[weekdayOf(start)]);
  return formatLocalDate(addLocalDays(monday, 7 * (row.week - 1)));
}

function findExam(parsed: ParsedSyllabus, exam: { title: string; date: string | null }): ParsedExam | null {
  const want = exam.date ? dayNumber(exam.date) : null;
  if (want !== null) {
    const near = parsed.exams.filter((e) => {
      const d = e.date ? dayNumber(e.date) : null;
      return d !== null && Math.abs(d - want) <= 1;
    });
    if (near.length === 1) return near[0];
    if (near.length > 1) return near.find((e) => titlesMatch(e.title, exam.title)) ?? near[0];
  }
  return parsed.exams.find((e) => titlesMatch(e.title, exam.title)) ?? null;
}

/**
 * Topics for one exam: the matched exam's own topics, else the schedule topics after the
 * previous exam up to this exam's date. Never just `exams[0]`.
 * @param parsed normalized syllabus
 * @param exam the exam being asked about (title, local date or null)
 * @returns ≤ 25 topics (deduped, in order), or [] when nothing is known
 */
export function topicsForExam(parsed: ParsedSyllabus, exam: { title: string; date: string | null }): string[] {
  const match = findExam(parsed, exam);
  if (match && match.topics.length > 0) return match.topics.slice(0, MAX_TOPICS);
  const targetIso = match?.date ?? exam.date;
  const target = targetIso ? dayNumber(targetIso) : null;
  if (target === null) return [];
  let prev = -Infinity;
  for (const e of parsed.exams) {
    const d = e.date ? dayNumber(e.date) : null;
    if (d !== null && d < target && d > prev) prev = d;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of parsed.schedule) {
    const iso = scheduleRowDate(row, parsed.course.term_start);
    const d = iso ? dayNumber(iso) : null;
    if (d === null || d <= prev || d > target) continue;
    for (const t of row.topics) {
      const k = t.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(t.trim());
      if (out.length >= MAX_TOPICS) return out;
    }
  }
  return out;
}

/**
 * Display label of a stored syllabus: "CPSC 223 Data Structures" (the stored `course_name`).
 * @param row stored row (course_name, course_key)
 * @returns label
 */
export function courseLabelOf(row: Pick<SyllabusRow, "course_name" | "course_key">): string {
  return row.course_name || row.course_key;
}

/**
 * One stored row → signals. Pure.
 * @param row stored syllabus row
 * @returns signals, or null when `parsed_json` is unusable
 */
export function signalsFromRow(row: Pick<SyllabusRow, "course_key" | "course_name" | "parsed_json">): SyllabusSignals | null {
  const parsed = readParsedJson(row.parsed_json);
  if (!parsed) return null;
  return {
    courseKey: row.course_key,
    courseLabel: courseLabelOf(row),
    grading: parsed.grading.map((g) => ({ name: g.name, weightPct: g.weight_pct })),
    exams: parsed.exams.map((e) => ({
      title: e.title,
      startsAt: e.starts_at_utc ?? null,
      weightPct: e.weight_pct,
      topics: topicsForExam(parsed, { title: e.title, date: e.date }),
    })),
    meetings: parsed.meetings,
  };
}

/**
 * Signals from every saved syllabus (meetings as busy time, exam weights/topics). Read-only.
 * Consumers: 4.2 (`find_free_slots`), V2-06 briefing hints. Third-party text — wrap before a model sees it.
 * @param userId owner
 * @returns one entry per usable syllabus, by course key; [] on a DB error (logged)
 */
export async function getSyllabusSignals(userId: string): Promise<SyllabusSignals[]> {
  const { data, error } = await db()
    .from("syllabi")
    .select("course_key, course_name, parsed_json")
    .eq("user_id", userId)
    .order("course_key", { ascending: true });
  if (error) {
    console.warn(`[syllabus] signals read failed: ${error.code ?? "unknown"}`);
    return [];
  }
  return (data ?? []).map(signalsFromRow).filter((s): s is SyllabusSignals => s !== null);
}
