import "server-only";
// OWNER: 3.5

/**
 * Deterministic 1–2 bubble confirmation for a syllabus intake (V2-08 §7.2 `confirm.ts`, §2.14;
 * Q3: template, not the agent). Pure. Lowercase-casual, ≤ 320 chars per bubble, local dates only
 * (never raw ISO timestamps).
 */
import type { IntakeOutcome } from "@/server/integrations/syllabus/types";
import { formatForChat, parseLocalDate, safeTimeZone, zonedToUtc } from "@/shared/time/tz";

/** Max characters per confirmation bubble. */
export const MAX_BUBBLE_CHARS = 320;

/**
 * Human form of a normalized course key: "CPSC223" → "CPSC 223", "t:data-structures" → "data structures".
 * Derived from the constrained key alphabet, so it is safe to show a model without wrapping.
 * @param key course key
 * @returns display text
 */
export function displayCourseKey(key: string): string {
  if (key.startsWith("t:")) return key.slice(2).replace(/-/g, " ");
  const m = /^([A-Z&]+)(\d.*)$/.exec(key);
  return m ? `${m[1]} ${m[2]}` : key;
}

/** Third-party label made safe for a chat bubble: one line, no control chars, ≤ 60 chars. */
function cleanLabel(label: string): string {
  const one = label.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 59).trimEnd()}…` : one;
}

function cap(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_BUBBLE_CHARS ? `${t.slice(0, MAX_BUBBLE_CHARS - 1).trimEnd()}…` : t;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function dayLabel(iso: string | null, tz: string, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatForChat(d, tz, now, { allDay: true });
}

function examWhen(e: NonNullable<Extract<IntakeOutcome, { status: "ok" | "needs_review" }>["nextExam"]>, tz: string, now: Date): string {
  if (!e.allDay && e.startsAt) {
    const d = new Date(e.startsAt);
    if (!Number.isNaN(d.getTime())) return formatForChat(d, tz, now);
  }
  const day = parseLocalDate(e.date);
  return day ? formatForChat(zonedToUtc({ ...day, hour: 12, minute: 0 }, tz).instant, tz, now, { allDay: true }) : e.date;
}

const NOT_SYLLABUS: Record<string, string> = {
  assignment: "an assignment",
  exam: "an exam",
  reading: "a reading",
};

function failedText(code: string, httpStatus: number | undefined): string {
  switch (code) {
    case "status":
      if (httpStatus === 403 || httpStatus === 404 || httpStatus === 410) return "that file link expired — can you resend it?";
      return "couldn't download that file right now, try sending it again in a bit?";
    case "too_large":
    case "too_many_pages":
      return "that file's too big for me — can you send just the syllabus part?";
    case "not_pdf":
      return "that doesn't look like a PDF — can you send the syllabus as a PDF?";
    case "encrypted_pdf":
      return "it's password-protected — can you send an unlocked copy?";
    case "invalid_pdf":
    case "invalid_base64":
      return "couldn't open that PDF, it might be damaged — can you send it again?";
    case "scheme":
    case "host":
    case "private_ip":
    case "redirect":
      return "couldn't open that file link — can you resend the PDF?";
    default:
      return "couldn't read your syllabus right now, try again in a bit?";
  }
}

/**
 * Bubbles for one intake outcome.
 * @param o the outcome
 * @param tz user zone (dates are shown local)
 * @param now clock for "today"/"tmrw" labels (default now)
 * @returns 1–2 bubbles, each ≤ 320 chars
 */
export function renderSyllabusConfirmation(o: IntakeOutcome, tz: string, now: Date = new Date()): string[] {
  const zone = safeTimeZone(tz);
  switch (o.status) {
    case "ok":
    case "needs_review": {
      const label = cleanLabel(o.courseLabel) || displayCourseKey(o.courseKey);
      const prev = o.replaced ? dayLabel(o.previousParsedAt, zone, now) : null;
      const head = o.replaced
        ? `updated your ${label} syllabus${prev ? ` (replaced the one from ${prev})` : ""} 📚`
        : `got your ${label} syllabus 📚`;
      const counts =
        o.examCount + o.assignmentCount === 0
          ? "didn't find any dated exams or deadlines in it though"
          : `${plural(o.examCount, "exam")}, ${plural(o.assignmentCount, "assignment")}${
              o.itemCount > 0 ? ` — ${o.itemCount === 1 ? "1 is" : `${o.itemCount} are`} on your list now` : ""
            }`;
      const next = o.nextExam ? ` next up: ${cleanLabel(o.nextExam.title).toLowerCase()} ${examWhen(o.nextExam, zone, now)}` : "";
      const first = cap(`${head} ${counts}.${next}`);

      const notes: string[] = [];
      const codes = new Set(o.issues.map((i) => i.code));
      if (o.courseMismatch || codes.has("course_mismatch")) notes.push(`this one's for ${label} btw, so I saved it under that`);
      if (codes.has("weights_sum") && typeof o.gradingTotalPct === "number") {
        notes.push(`heads up, the weights only add to ${Math.round(o.gradingTotalPct)}% — might be missing something`);
      } else if (codes.has("weights_sum") || codes.has("weights_missing")) {
        notes.push("heads up, I couldn't get the grading weights to add up — might be missing something");
      }
      if (codes.has("stale_term")) notes.push("heads up, this looks like an older syllabus, dates might be off");
      if (o.truncatedPages && o.pageCount) {
        notes.push(`that was ${o.pageCount} pages so I read the first 20 — tell me if the grading stuff is later`);
      }
      if (o.status === "needs_review" && notes.length === 0) notes.push("some of it was hard to read, so double-check the dates");
      return notes.length > 0 ? [first, cap(notes.slice(0, 2).join(". "))] : [first];
    }
    case "exists": {
      if (o.reason === "same_file") return ["already have that one 👍"];
      const label = cleanLabel(o.courseLabel) || displayCourseKey(o.courseKey);
      const when = dayLabel(o.parsedAt, zone, now);
      return [cap(`I already have your ${label} syllabus${when ? ` from ${when}` : ""} — want me to replace it?`)];
    }
    case "not_syllabus": {
      const what = NOT_SYLLABUS[o.documentKind];
      return [what ? `that looks like ${what}, not a syllabus — I only read syllabi for now` : "that doesn't look like a syllabus to me — I only read syllabi for now"];
    }
    case "unreadable":
      return ["couldn't really read that one — got a text PDF?"];
    case "rate_limited":
      return ["that's all the syllabi I can read today — send it again tomorrow?"];
    case "failed":
      return [failedText(o.code, o.httpStatus)];
  }
}
