import "server-only";
// OWNER: 4.2

/**
 * Agent tool `find_free_slots` (master plan §1.4 #12; V2-07 §2.7, §9.2). Read-only.
 *
 * - The window is local dates/times in the user's zone (default now → end of tomorrow; at most 14
 *   days; never before now).
 * - Constraints = the model's copy ∪ active preferences whose `constraint_json.applies_to` covers
 *   the activity (deterministic even if the model forgets); a preference `waking` overrides
 *   08:00–23:00.
 * - Busy = live Google calendars + Aria calendar + Canvas/syllabus timed items + class meetings
 *   (`collectBusy`). Without Google it still answers from the rest and says so.
 * - Each slot is returned as an `s_` alias of `slotIdFor(slot)`; `create_block` resolves it in the
 *   same run. Aliases die with the run, so a pick in a later turn uses explicit start/end.
 * - For a course activity with an upcoming exam in a saved syllabus, one wrapped (untrusted)
 *   line gives the exam, weight and topics.
 */
import { z } from "zod";
import { defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { wrapUntrusted } from "@/server/agent/untrusted";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { collectBusy } from "@/server/integrations/google/calendar/busy";
import {
  DEFAULT_BUFFER_MIN,
  DEFAULT_GRANULARITY_MIN,
  DEFAULT_LEAD_MIN,
  DEFAULT_WAKING,
  MAX_WINDOW_DAYS,
  constraintsFromPreferences,
  dedupeConstraints,
  findFreeSlots,
  slotIdFor,
} from "@/server/integrations/google/calendar/slots";
import { getSyllabusSignals } from "@/server/integrations/syllabus";
import { listActivePreferences } from "@/server/memory";
import { courseKey } from "@/shared/course-key";
import { ConstraintSchema, HHMMSchema } from "@/shared/scheduling-constraints";
import { addLocalDays, formatForChat, localDateOf, parseLocalDate, parseLocalDateTime, zonedToUtc, type LocalDate } from "@/shared/time/tz";

const LocalDateOrTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
  .describe("Local date or date-time in the user's timezone, e.g. 2026-10-14 or 2026-10-14T16:00");

const input = z.strictObject({
  duration_minutes: z.number().int().min(15).max(480),
  /** default: now */
  window_start: LocalDateOrTime.optional(),
  /** default: end of tomorrow; max 14 days after start */
  window_end: LocalDateOrTime.optional(),
  activity: z.string().min(1).max(40).describe("e.g. 'gym', 'study CPSC 323'"),
  constraints: z.array(ConstraintSchema).max(10).default([]),
  part_of_day: z.array(z.enum(["morning", "afternoon", "evening"])).max(3).optional(),
  around: HHMMSchema.optional(),
  max_results: z.number().int().min(3).max(5).default(4),
});

const DAY_MS = 86_400_000;
/** How far ahead an exam counts for the syllabus hint. */
const EXAM_HINT_DAYS = 21;

function midnight(d: LocalDate, tz: string): Date {
  return zonedToUtc({ ...d, hour: 0, minute: 0 }, tz).instant;
}

/** Start (date → local midnight) or end (date → end of that local day) of a window bound. */
function parseBound(s: string, tz: string, edge: "start" | "end"): Date | null {
  const dt = parseLocalDateTime(s);
  if (dt) return zonedToUtc(dt, tz).instant;
  const d = parseLocalDate(s);
  if (!d) return null;
  return midnight(edge === "end" ? addLocalDays(d, 1) : d, tz);
}

/**
 * Resolve the search window in the user's zone (pure).
 * - start: `window_start` (a date = its local midnight), never before `now`; default now
 * - end: `window_end` (a date = the end of that day); default the end of the day after the
 *   start's local date (= end of tomorrow when no start is given); capped at start + 14 days
 * @param i window fields of the tool input
 * @param now logical now
 * @param tz user's IANA zone
 * @returns the window (+ `clamped` when the 14-day cap applied), or a model-readable error
 */
export function resolveSlotWindow(
  i: { window_start?: string; window_end?: string },
  now: Date,
  tz: string,
): { ok: true; start: Date; end: Date; clamped: boolean } | { ok: false; error: string } {
  const rawStart = i.window_start ? parseBound(i.window_start, tz, "start") : now;
  if (!rawStart) return { ok: false, error: "window_start isn't a real date (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)" };
  const start = rawStart > now ? rawStart : now;
  let end: Date | null;
  if (i.window_end) {
    end = parseBound(i.window_end, tz, "end");
    if (!end) return { ok: false, error: "window_end isn't a real date (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)" };
  } else {
    end = midnight(addLocalDays(localDateOf(start, tz), 2), tz);
  }
  if (end <= start) return { ok: false, error: "that window is empty or already over; pick a later window_end" };
  const cap = new Date(start.getTime() + MAX_WINDOW_DAYS * DAY_MS);
  return end > cap ? { ok: true, start, end: cap, clamped: true } : { ok: true, start, end, clamped: false };
}

async function examHint(ctx: ToolCtx, activity: string): Promise<string | null> {
  const key = courseKey(activity);
  if (!key || key.startsWith("t:")) return null;
  const signals = await getSyllabusSignals(ctx.userId);
  const course = signals.find((s) => s.courseKey === key);
  if (!course) return null;
  const horizon = ctx.now.getTime() + EXAM_HINT_DAYS * DAY_MS;
  const upcoming = course.exams
    .map((e) => ({ ...e, at: e.startsAt ? new Date(e.startsAt) : null }))
    .filter((e): e is typeof e & { at: Date } => e.at !== null && !Number.isNaN(e.at.getTime()) && e.at > ctx.now && e.at.getTime() <= horizon)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (!upcoming) return null;
  const weight = upcoming.weightPct !== null ? ` (${upcoming.weightPct}%)` : "";
  const topics = upcoming.topics.length > 0 ? `; topics: ${upcoming.topics.slice(0, 8).join(", ")}` : "";
  ctx.taint.mark("syllabus");
  const body = `${course.courseLabel} ${upcoming.title} ${formatForChat(upcoming.at, ctx.timezone, ctx.now)}${weight}${topics}`;
  return `upcoming exam from their syllabus: ${wrapUntrusted({ source: "syllabus", body, maxChars: 600 })}`;
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns `[s_…] <label> · <why>` lines, notes and calendars checked; or a model-readable error
 */
export async function runFindFreeSlots(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const w = resolveSlotWindow(i, ctx.now, ctx.timezone);
  if (!w.ok) return { ok: false, error: w.error };
  try {
    const prefs = await listActivePreferences(ctx.userId);
    const fromPrefs = constraintsFromPreferences(prefs, i.activity);
    const constraints = dedupeConstraints([...i.constraints, ...fromPrefs.constraints]);
    const busy = await collectBusy(ctx.userId, w.start, w.end, { timezone: ctx.timezone });
    const r = findFreeSlots({
      now: ctx.now,
      tz: ctx.timezone,
      windowStart: w.start,
      windowEnd: w.end,
      durationMin: i.duration_minutes,
      busy: busy.intervals,
      constraints,
      waking: fromPrefs.waking ?? { ...DEFAULT_WAKING },
      bufferMin: DEFAULT_BUFFER_MIN,
      leadMin: DEFAULT_LEAD_MIN,
      granularityMin: DEFAULT_GRANULARITY_MIN,
      preferred: { partOfDay: i.part_of_day, around: i.around },
      maxResults: i.max_results,
    });
    const lines = r.candidates.map((c) => `[${ctx.aliases.mint("s", slotIdFor(c))}] ${c.label} · ${c.why}`);
    const notes = [...r.notes];
    if (w.clamped) notes.push(`searched only the first ${MAX_WINDOW_DAYS} days`);
    if (fromPrefs.constraints.length > 0 || fromPrefs.waking) notes.push("applied their saved scheduling preferences");
    if (busy.google === "not_connected") {
      notes.push("Google Calendar isn't connected, so only classes and Canvas/syllabus times were checked (send_link connect_google adds it)");
    }
    let hint: string | null = null;
    try {
      hint = await examHint(ctx, i.activity);
    } catch {
      hint = null; // the hint is optional
    }
    const out = [
      lines.length > 0 ? lines.join("\n") : "no open slots",
      ...notes.map((n) => `note: ${n}`),
      ...(hint ? [hint] : []),
      `calendars checked: ${busy.calendarsChecked}`,
      lines.length > 0 ? "book one with create_block slot=<s_ id> in this run; if they pick later, pass start/end instead" : "",
    ].filter((s) => s !== "");
    return { ok: true, data: out.join("\n") };
  } catch (e) {
    ctx.log("find_free_slots_failed", { error: e instanceof Error ? e.name : "error" });
    if (e instanceof GoogleApiError) return { ok: false, error: "couldn't read their Google Calendar just now", retryable: true };
    return { ok: false, error: "couldn't check free time just now", retryable: true };
  }
}

/** `find_free_slots` tool. */
export const findFreeSlotsTool = defineTool({
  name: "find_free_slots",
  description:
    "Find 3–5 open times on the student's calendar for an activity of a given length, respecting classes, events and their preferences. Copy any relevant active preferences into constraints. Returns s_ slot ids to offer; it never books anything.",
  input,
  slow: true,
  run: runFindFreeSlots,
});
