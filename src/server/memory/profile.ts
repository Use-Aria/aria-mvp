import "server-only";
// OWNER: 2.2

/**
 * Profile tier (V2-04 §2.7, master plan §1.7): a deterministic, ≤400-token render of who the
 * student is — name, school, courses, weekly class times. It sits in the cached per-user prefix,
 * so the render is byte-stable for the same rows (sorted, no clocks).
 *
 * Course names and class times come from Canvas / syllabi (third-party text), so they are
 * rendered inside `wrapUntrusted`. Name and school are the student's own words (tag-neutralized).
 */
import { z } from "zod";
import { BUDGET } from "@/server/agent/config";
import { estimateTokens } from "@/server/agent/context/budget";
import { neutralizeTags, wrapUntrusted } from "@/server/agent/untrusted";
import { db, type Tables } from "@/server/db";
import type { Json } from "@/server/db/types";
import { listCourses } from "@/server/timeline";
import type { Weekday } from "@/shared/time/tz";

/** One weekly class meeting (`user_profile.class_times[]`). */
export interface ClassTime {
  course: string;
  days: Weekday[];
  /** "HH:MM" */
  start: string;
  /** "HH:MM" */
  end: string;
  location?: string;
}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const satisfies readonly Weekday[];
const DAY_LABEL: Readonly<Record<Weekday, string>> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ClassTimeSchema = z.object({
  course: z.string().trim().min(1),
  days: z.array(z.enum(WEEKDAYS)).min(1),
  start: HHMM,
  end: HHMM,
  location: z.string().trim().min(1).optional().catch(undefined),
});

const MAX_COURSES = 12;
const MAX_CLASSES = 14;
const MAX_FIELD = 60;

function clip(s: string, max = MAX_FIELD): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function byText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse `user_profile.courses` leniently.
 * @param json stored value (string[] expected; anything else tolerated)
 * @returns trimmed, de-duplicated (case-insensitive), sorted course labels
 */
export function parseCourses(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const seen = new Map<string, string>();
  for (const v of json) {
    if (typeof v !== "string") continue;
    const t = v.replace(/\s+/g, " ").trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].sort(byText);
}

/**
 * Parse `user_profile.class_times` leniently (invalid entries dropped).
 * @param json stored value (ClassTime[] expected)
 * @returns valid class times sorted by course, first weekday, start
 */
export function parseClassTimes(json: unknown): ClassTime[] {
  if (!Array.isArray(json)) return [];
  const out: ClassTime[] = [];
  for (const v of json) {
    const r = ClassTimeSchema.safeParse(v);
    if (!r.success) continue;
    const days = WEEKDAYS.filter((d) => r.data.days.includes(d));
    const ct: ClassTime = { course: r.data.course, days, start: r.data.start, end: r.data.end };
    if (r.data.location) ct.location = r.data.location;
    out.push(ct);
  }
  const dayIdx = (c: ClassTime) => WEEKDAYS.indexOf(c.days[0]);
  return out.sort((a, b) => byText(a.course, b.course) || dayIdx(a) - dayIdx(b) || byText(a.start, b.start));
}

/** "13:00" → "1pm", "14:15" → "2:15pm". */
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}${h < 12 ? "am" : "pm"}`;
}

function renderClassTime(c: ClassTime): string {
  const where = c.location ? ` @ ${clip(c.location, 40)}` : "";
  return `${clip(c.course)} ${c.days.map((d) => DAY_LABEL[d]).join("/")} ${clock(c.start)}–${clock(c.end)}${where}`;
}

function assemble(head: string[], courses: string[], classes: string[], moreCourses: number, moreClasses: number): string {
  const lines = [...head];
  if (courses.length > 0 || classes.length > 0) {
    const body: Record<string, string> = {};
    if (courses.length > 0) body.courses = courses.join("; ") + (moreCourses > 0 ? ` (+${moreCourses} more)` : "");
    if (classes.length > 0) body.classes = classes.join("; ") + (moreClasses > 0 ? ` (+${moreClasses} more)` : "");
    lines.push(wrapUntrusted({ source: "canvas", body, maxChars: 1200 }));
  }
  return lines.join("\n");
}

/**
 * Deterministic profile block for the cached per-user prefix. Pure; same rows → same bytes.
 * Timezone is deliberately left out (it lives in `<aria_now>`, which is never stale).
 * @param user users row
 * @param profile user_profile row, if any
 * @returns the block (≤ BUDGET.profile tokens by `estimateTokens`)
 */
export function renderProfileBlock(user: Tables<"users">, profile: Tables<"user_profile"> | null): string {
  const name = user.name ? clip(neutralizeTags(user.name), 40) : null;
  const head = [name ? `name: ${name}` : "name: unknown (ask what to call them when it fits)"];
  if (profile?.school) head.push(`school: ${clip(neutralizeTags(profile.school), 80)}`);

  const allCourses = parseCourses(profile?.courses ?? null).map((c) => clip(c));
  const allClasses = parseClassTimes(profile?.class_times ?? null).map(renderClassTime);
  let nCourses = Math.min(allCourses.length, MAX_COURSES);
  let nClasses = Math.min(allClasses.length, MAX_CLASSES);
  for (;;) {
    const block = assemble(
      head,
      allCourses.slice(0, nCourses),
      allClasses.slice(0, nClasses),
      allCourses.length - nCourses,
      allClasses.length - nClasses,
    );
    if (estimateTokens(block) <= BUDGET.profile || (nCourses === 0 && nClasses === 0)) return block;
    if (nClasses > 0) nClasses -= 1;
    else nCourses -= 1;
  }
}

async function loadRows(userId: string): Promise<{ user: Tables<"users"> | null; profile: Tables<"user_profile"> | null }> {
  const [u, p] = await Promise.all([
    db().from("users").select("*").eq("id", userId).maybeSingle(),
    db().from("user_profile").select("*").eq("user_id", userId).maybeSingle(),
  ]);
  if (u.error) throw new Error(`memory.profile: users read failed: ${u.error.message}`);
  if (p.error) throw new Error(`memory.profile: user_profile read failed: ${p.error.message}`);
  return { user: u.data, profile: p.data };
}

/**
 * Recompute `user_profile.courses` (from the timeline's current course set) and
 * `rendered_block`. Called after course/school/name/timezone changes (V2-05, V2-08, update_profile).
 * An empty course list from the timeline keeps the stored courses (no wipe on a transient).
 * @param userId owner
 */
export async function refreshProfileBlock(userId: string): Promise<void> {
  const [{ user, profile }, timelineCourses] = await Promise.all([
    loadRows(userId),
    listCourses(userId).catch((e: unknown) => {
      console.warn("memory.refreshProfileBlock: listCourses failed", e instanceof Error ? e.name : "error");
      return [] as string[];
    }),
  ]);
  if (!user) return;
  const fresh = parseCourses(timelineCourses);
  const courses = fresh.length > 0 ? fresh : parseCourses(profile?.courses ?? null);
  const next: Tables<"user_profile"> = {
    user_id: userId,
    school: profile?.school ?? null,
    courses: courses as Json,
    class_times: profile?.class_times ?? null,
    rendered_block: null,
    updated_at: new Date().toISOString(),
  };
  next.rendered_block = renderProfileBlock(user, next);
  const { error } = await db()
    .from("user_profile")
    .upsert(
      { user_id: userId, courses: next.courses, rendered_block: next.rendered_block, updated_at: next.updated_at },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(`memory.refreshProfileBlock: upsert failed: ${error.message}`);
}

/**
 * Profile block for prompts. Rendered from the current rows (so a name or school edit shows up
 * at once); course lists come from the last `refreshProfileBlock`.
 * @param userId owner
 * @returns the rendered block, or "" when the user doesn't exist
 */
export async function loadProfileBlock(userId: string): Promise<string> {
  const { user, profile } = await loadRows(userId);
  return user ? renderProfileBlock(user, profile) : "";
}

/**
 * Structured profile (V2-07 scheduling, V2-06 briefing).
 * @param userId owner
 * @returns school, courses, weekly class times (empty when no profile row)
 */
export async function getProfile(userId: string): Promise<{ school: string | null; courses: string[]; classTimes: ClassTime[] }> {
  const { data, error } = await db().from("user_profile").select("school, courses, class_times").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`memory.getProfile: read failed: ${error.message}`);
  return {
    school: data?.school ?? null,
    courses: parseCourses(data?.courses ?? null),
    classTimes: parseClassTimes(data?.class_times ?? null),
  };
}
