import "server-only";
// OWNER: 3.5

/**
 * Agent tool `syllabus_info` (master plan §1.4 #20; input per V2-08 §9). Read-only.
 *
 * Syllabus content is third-party text (master plan §1.0.6): every field taken from a syllabus
 * goes out inside one `wrapUntrusted({source: "syllabus"})` block and the run is tainted. Course
 * resolution never matches on empty (exact key → cross-listed → name → title words ≥ 4 chars).
 * Output stays well under the 6000-char tool cap (~1,500 tokens); the schedule defaults to the
 * next 3 weeks unless `query` narrows it.
 */
import { z } from "zod";
import { defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { wrapUntrusted } from "@/server/agent/untrusted";
import type { ParsedSyllabus } from "@/server/integrations/syllabus/contract";
import { displayCourseKey } from "@/server/integrations/syllabus/confirm";
import { titlesMatch } from "@/server/integrations/syllabus/dedupe";
import { readParsedJson, scheduleRowDate, topicsForExam } from "@/server/integrations/syllabus/signals";
import { findSyllabusByCourse, listSyllabi } from "@/server/integrations/syllabus/store";
import { formatForTool, formatLocalDate, localDateOf, parseLocalDate } from "@/shared/time/tz";

const input = z.strictObject({
  /** "CPSC 223", "data structures", "orgo" */
  course: z.string().trim().min(1).max(80).optional(),
  aspect: z
    .enum(["overview", "grading", "exams", "assignments", "schedule", "policies", "staff"])
    .default("overview"),
  /** e.g. "midterm 2" to narrow exams/schedule */
  query: z.string().trim().max(120).optional(),
});

type Aspect = z.output<typeof input>["aspect"];

const MAX_BODY_CHARS = 4500;
/** "Thu, Oct 15, 2026" for a floating calendar date. */
const ALL_DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MAX_LINES = { exams: 12, assignments: 20, schedule: 15 } as const;

function pct(w: number | null): string {
  return w === null ? "" : ` (${Math.round(w * 10) / 10}%)`;
}

function dateLabel(date: string | null, startsAtUtc: string | null, allDay: boolean, tz: string): string {
  if (startsAtUtc && !allDay) {
    const d = new Date(startsAtUtc);
    if (!Number.isNaN(d.getTime())) return formatForTool(d, tz);
  }
  if (date) {
    const d = parseLocalDate(date);
    if (d) return `${ALL_DAY_FMT.format(Date.UTC(d.year, d.month - 1, d.day))} (all day)`;
  }
  return "date not stated";
}

function matchesQuery(query: string | undefined, ...texts: string[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return texts.some((t) => t.toLowerCase().includes(q) || titlesMatch(t, query));
}

function examLines(p: ParsedSyllabus, tz: string, query?: string): string[] {
  return p.exams
    .filter((e) => matchesQuery(query, e.title, e.kind))
    .slice(0, MAX_LINES.exams)
    .map((e) => {
      const topics = topicsForExam(p, { title: e.title, date: e.date });
      const parts = [
        `${e.title}${pct(e.weight_pct)}: ${dateLabel(e.date, e.starts_at_utc, e.all_day, tz)}`,
        e.date ? "" : ` [syllabus says "${e.date_text}"]`,
        e.location ? `, ${e.location}` : "",
        e.cumulative ? ", cumulative" : "",
        topics.length > 0 ? `; topics: ${topics.join("; ")}` : "",
      ];
      return `- ${parts.join("")}`;
    });
}

function gradingLines(p: ParsedSyllabus): string[] {
  const lines = p.grading.map((g) => `- ${g.name}${pct(g.weight_pct)}${g.notes ? ` — ${g.notes}` : ""}`);
  if (p.grading_total_pct !== null) lines.push(`total: ${Math.round(p.grading_total_pct * 10) / 10}%`);
  return lines.length > 0 ? lines : ["no grading breakdown in the syllabus"];
}

function assignmentLines(p: ParsedSyllabus, tz: string, now: Date, query?: string): string[] {
  const today = formatLocalDate(localDateOf(now, tz));
  const rows = p.assignments.filter((a) => matchesQuery(query, a.title, a.category));
  const upcoming = query ? rows : rows.filter((a) => !a.due_date || a.due_date >= today);
  const lines = upcoming
    .slice(0, MAX_LINES.assignments)
    .map(
      (a) =>
        `- ${a.title}${pct(a.weight_pct)}: ${a.due_date ? dateLabel(a.due_date, a.due_at_utc, a.all_day, tz) : `"${a.due_text || "no date"}"`}`,
    );
  return lines.length > 0 ? lines : ["no upcoming dated assignments in the syllabus"];
}

function scheduleLines(p: ParsedSyllabus, tz: string, now: Date, query?: string): string[] {
  const today = formatLocalDate(localDateOf(now, tz));
  const horizon = formatLocalDate(localDateOf(new Date(now.getTime() + 21 * 86_400_000), tz));
  const weekQuery = query ? /^week\s*(\d{1,2})$/i.exec(query.trim()) : null;
  const rows = p.schedule.filter((r) => {
    const date = scheduleRowDate(r, p.course.term_start);
    if (weekQuery) return r.week === Number(weekQuery[1]);
    if (query) return matchesQuery(query, ...r.topics, ...r.readings, ...r.due);
    return date === null ? false : date >= today && date <= horizon;
  });
  const lines = rows.slice(0, MAX_LINES.schedule).map((r) => {
    const date = scheduleRowDate(r, p.course.term_start);
    const when = [r.week ? `week ${r.week}` : "", date ?? ""].filter(Boolean).join(", ") || "undated";
    const bits = [
      r.topics.length ? `topics: ${r.topics.join("; ")}` : "",
      r.readings.length ? `readings: ${r.readings.join("; ")}` : "",
      r.due.length ? `due: ${r.due.join("; ")}` : "",
    ].filter(Boolean);
    return `- ${when}: ${bits.join(" | ") || "(nothing listed)"}`;
  });
  if (lines.length > 0) return lines;
  return [query ? "nothing in the schedule matches that" : "nothing dated in the schedule for the next 3 weeks"];
}

function policyLines(p: ParsedSyllabus): string[] {
  const pol = p.policies;
  const lines = [
    pol.late_work ? `- late work: ${pol.late_work}` : "",
    pol.attendance ? `- attendance: ${pol.attendance}` : "",
    pol.collaboration ? `- collaboration: ${pol.collaboration}` : "",
    pol.exam_makeup ? `- exam makeups: ${pol.exam_makeup}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? lines : ["no policies stated in the syllabus"];
}

function staffLines(p: ParsedSyllabus): string[] {
  const lines = p.instructors.map(
    (s) => `- ${s.name} (${s.role})${s.email ? `, ${s.email}` : ""}${s.office_hours ? `, office hours: ${s.office_hours}` : ""}`,
  );
  return lines.length > 0 ? lines : ["no instructors listed"];
}

function meetingLines(p: ParsedSyllabus): string[] {
  return p.meetings.map(
    (m) =>
      `- ${m.kind}: ${m.days.join("/")}${m.start_local ? ` ${m.start_local}${m.end_local ? `–${m.end_local}` : ""}` : ""}${m.location ? `, ${m.location}` : ""}`,
  );
}

/**
 * Plain-text body for one aspect (third-party content; the caller wraps it). Pure.
 * @param p normalized syllabus
 * @param aspect which part
 * @param tz user zone
 * @param now clock
 * @param query optional narrowing text
 * @returns text
 */
export function renderAspect(p: ParsedSyllabus, aspect: Aspect, tz: string, now: Date, query?: string): string {
  const head = [`course: ${[p.course.code, p.course.title].filter(Boolean).join(" ")}`, p.course.term ? `term: ${p.course.term}` : ""]
    .filter(Boolean)
    .join("\n");
  const section = (title: string, lines: string[]) => `${title}:\n${lines.join("\n")}`;
  switch (aspect) {
    case "grading":
      return [head, section("grading", gradingLines(p))].join("\n");
    case "exams": {
      const exams = examLines(p, tz, query);
      return [head, section("exams", exams.length ? exams : ["no matching exams"])].join("\n");
    }
    case "assignments":
      return [head, section("assignments", assignmentLines(p, tz, now, query))].join("\n");
    case "schedule":
      return [head, section("schedule", scheduleLines(p, tz, now, query))].join("\n");
    case "policies":
      return [head, section("policies", policyLines(p))].join("\n");
    case "staff":
      return [head, section("staff", staffLines(p)), ...(p.meetings.length ? [section("meetings", meetingLines(p))] : [])].join("\n");
    case "overview": {
      const exams = examLines(p, tz, query);
      return [
        head,
        section("grading", gradingLines(p)),
        section("exams", exams.length ? exams : ["none listed"]),
        `assignments listed: ${p.assignments.length}`,
        ...(p.meetings.length ? [section("meetings", meetingLines(p))] : []),
      ].join("\n");
    }
  }
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns saved-syllabus list, `not_found` with the available courses, or the wrapped aspect
 */
export async function runSyllabusInfo(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  try {
    if (!i.course) {
      const all = await listSyllabi(ctx.userId);
      return {
        ok: true,
        data: {
          status: all.length > 0 ? "ok" : "none_saved",
          syllabi: all.map((s) => ({
            course: displayCourseKey(s.course_key),
            saved: formatForTool(new Date(s.parsed_at), ctx.timezone),
            ...(s.status === "needs_review" ? { needs_review: true } : {}),
          })),
        },
      };
    }
    const row = await findSyllabusByCourse(ctx.userId, i.course);
    if (!row) {
      const all = await listSyllabi(ctx.userId);
      return { ok: true, data: { status: "not_found", available: all.map((s) => displayCourseKey(s.course_key)) } };
    }
    const parsed = readParsedJson(row.parsed_json);
    if (!parsed) return { ok: false, error: "that saved syllabus can't be read; ask them to send it again" };
    const body = renderAspect(parsed, i.aspect, ctx.timezone, ctx.now, i.query || undefined);
    ctx.taint.mark("syllabus");
    return {
      ok: true,
      data: {
        status: "ok",
        course: displayCourseKey(row.course_key),
        aspect: i.aspect,
        ...(row.status === "needs_review" ? { needs_review: true } : {}),
        content: wrapUntrusted({ source: "syllabus", id: row.course_key.replace(/^t:/, "t-"), body, maxChars: MAX_BODY_CHARS }),
      },
    };
  } catch (e) {
    ctx.log("syllabus_info_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { ok: false, error: "couldn't look up the syllabus just now", retryable: true };
  }
}

/** `syllabus_info` tool. */
export const syllabusInfoTool = defineTool({
  name: "syllabus_info",
  description:
    "Look up what a saved syllabus says: grading weights, exam dates and topics, assignments, weekly schedule, policies. Use for questions like 'what's on the midterm' or 'how much is the final worth'. Omit course to list saved syllabi.",
  input,
  untrustedOutput: true,
  run: runSyllabusInfo,
});
