// OWNER: 1.4

/**
 * Canvas connect copy + summary formatting (V2-05 §7.1 `canvas-guide.ts`). Pure, client-safe.
 *
 * Salvaged from the V1 app (`mobile/app/(onboarding)/tools.tsx` guide steps and error states,
 * `mobile/components/onboarding/CanvasUrlInput.tsx`), adapted to the web and to chat. Strings are
 * plain text (no markdown) because the same copy goes to iMessage, which renders none.
 */
import type { CanvasConnectError } from "@/server/integrations/canvas/connect";
import { courseKey } from "@/shared/course-key";

export type { CanvasConnectError };

/** Post-connect summary (connect result, `summarizeUpcoming`). */
export interface ConnectSummaryShape {
  deadlines: number;
  courses: string[];
  nextDue: { title: string; course: string | null; label: string } | null;
}

/** How to find the Canvas Calendar Feed link (web /setup and the chat tool). */
export const CANVAS_GUIDE_STEPS: readonly string[] = Object.freeze([
  'Tap "Open Canvas" (or open Canvas in your browser) and go to Calendar.',
  'On the right (at the bottom on a phone), tap "Calendar Feed". A box pops up with your link.',
  "Copy it and paste it here. Or just text it to Aria.",
]);

const FEED_EXAMPLE = "https://yourschool.instructure.com/feeds/calendars/user_….ics";

/** User-facing copy for every connect failure (V1 tools.tsx / CanvasUrlInput.tsx states, extended). */
export const CANVAS_ERROR_COPY: Record<CanvasConnectError, string> = Object.freeze({
  not_a_url: `That doesn't look like a link. Paste your Canvas Calendar Feed link. It looks like ${FEED_EXAMPLE}`,
  not_ical: `That doesn't look like a Canvas calendar feed link. It should look like ${FEED_EXAMPLE}`,
  course_feed:
    'That\'s one course\'s feed. Grab the one under "Calendar Feed" on your Calendar page so I get all your classes.',
  not_canvas:
    "That link doesn't come from Canvas. Copy it from \"Calendar Feed\" on your Canvas Calendar page.",
  private_address: "I can't use that link. Copy the Calendar Feed link straight from Canvas.",
  feed_not_found:
    "Canvas says that feed doesn't exist anymore. It may have been reset. Grab a fresh link from \"Calendar Feed\" in Canvas.",
  unreachable: "Couldn't reach that Canvas feed. Double-check the URL.",
  timeout: "Canvas took too long to answer. Try again in a minute.",
  too_large: "That calendar is way bigger than a Canvas feed should be, so I couldn't load it.",
  forbidden: "Canvas blocked the request. Try again in a bit. If it keeps happening, text me and I'll look into it.",
  rate_limited: "Too many tries for now. Give it a few minutes and try again.",
  already_connected_elsewhere: "That Canvas feed is already connected to another Aria account.",
  not_user_authored: "Paste your Canvas feed link here yourself and I'll connect it.",
  no_url_found: `I didn't see a Canvas feed link. Paste the one from "Calendar Feed" in Canvas. It looks like ${FEED_EXAMPLE}`,
  multiple_urls: "I see more than one Canvas feed link. Send just the one you want me to use.",
  internal: "Something went wrong on my end connecting Canvas. Try again in a minute.",
});

const MAX_TITLE_IN_SUMMARY = 60;

/**
 * One-line, lowercase-casual connect summary for chat and the web toast.
 * Courses are counted by `courseKey`, so "CPSC 323 01 (FA26)" and "CPSC 323" count once.
 * @param s counts, course codes, and the next deadline (its `label` is already formatted, e.g. "Thu 11:59pm")
 * @returns e.g. "found 14 deadlines across 4 courses — next up: Pset 4 (CPSC 323), due Thu 11:59pm"
 */
export function formatConnectSummary(s: ConnectSummaryShape): string {
  if (!s || s.deadlines <= 0) {
    return "connected, but I don't see upcoming deadlines yet. That's normal before the term starts.";
  }
  const courseKeys = new Set<string>();
  for (const c of s.courses) {
    const k = courseKey(c);
    if (k) courseKeys.add(k);
  }
  let out = `found ${plural(s.deadlines, "deadline")}`;
  if (courseKeys.size > 0) out += ` across ${plural(courseKeys.size, "course")}`;
  if (s.nextDue) {
    const title = clip(oneLine(s.nextDue.title), MAX_TITLE_IN_SUMMARY) || "untitled";
    const course = shortCourseLabel(s.nextDue.course);
    out += ` — next up: ${title}${course ? ` (${course})` : ""}, due ${oneLine(s.nextDue.label)}`;
  }
  return out;
}

/**
 * Short display label for a Canvas course code.
 * @param course raw bracket code, e.g. "CPSC 323 01 (FA26)"
 * @returns "CPSC 323"; the trimmed text (≤ 24 chars) when no subject+number is found; null for empty
 */
export function shortCourseLabel(course: string | null): string | null {
  if (typeof course !== "string") return null;
  const text = oneLine(course.replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
  const m = /^([A-Za-z&]{2,8})[\s-]*(\d{2,4}[A-Za-z]?)\b/.exec(text);
  if (m) return `${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
  const fallback = clip(text, 24);
  return fallback === "" ? clip(oneLine(course), 24) || null : fallback;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
