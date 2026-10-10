import "server-only";
/**
 * /week data access (web plan §2.5, §7.5). OWNER: 4.4.
 *
 * Reads the timeline through V2-05's `listTimeline` (owner-scoped, done items included, plus
 * the "still open" overdue tail), maps each view to the client-safe `WeekItem` (ISO strings,
 * cleaned display text), and groups it with the pure `groupWeek`. Day boundaries are computed
 * in the user's IANA zone by local date (never `+24h`), so DST can't shift a day; all-day items
 * keep their floating date (`allDayDate`). Returns a view model only: no raw rows, no secrets.
 */
import { getCanvasStatus, type CanvasStatusView } from "@/server/integrations/canvas";
import { getGoogleStatus } from "@/server/integrations/google";
import { listTimeline, type TimelineItemView } from "@/server/timeline";
import type { Viewer } from "@/server/viewer";
import { cleanText } from "@/shared/safe-url";
import { timeZoneLabel } from "@/shared/schedule-prefs";
import { UNIVERSITIES } from "@/shared/universities";
import { groupWeek, type WeekItem, type WeekView } from "@/shared/week";
import { addLocalDays, localDateOf, safeTimeZone, zonedToUtc, type LocalDate } from "@/shared/time/tz";

/** Everything /week renders. */
export interface WeekPageView {
  week: WeekView;
  canvas: CanvasStatusView;
  googleConnected: boolean;
  /** Hosts `ExternalLink` may link to (Canvas hosts, Google Calendar). */
  allowHosts: string[];
  /** The viewer's IANA zone (all labels below are already in it). */
  timeZone: string;
  /** e.g. "Eastern Time". */
  tzLabel: string;
  offsetWeeks: 0 | 1;
  /** Canvas is connected but its feed is failing or revoked. */
  canvasFailing: boolean;
  /** "Tue 4:10 PM": the last good Canvas sync while failing, else null. */
  canvasFailingSince: string | null;
}

/** Longest title / course text shown on the page (code points). */
const TITLE_MAX = 300;
const COURSE_MAX = 80;

/** Hosts every viewer may link to, besides their own connected Canvas host. */
const BASE_ALLOW_HOSTS: readonly string[] = [
  "*.instructure.com",
  "calendar.google.com",
  "www.google.com",
  "google.com",
  ...UNIVERSITIES.map((u) => u.canvasDomain),
];

/**
 * Parses the `?w=` query value: only the integers 0 and 1 are allowed; anything else is 0.
 * @param raw query value (string, repeated, or missing)
 * @returns 0 (this week) or 1 (the following 7 days)
 */
export function parseOffsetWeeks(raw: string | string[] | undefined): 0 | 1 {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "1" ? 1 : 0;
}

/**
 * Link allow-list for /week.
 * @param canvasHost the user's connected Canvas host, if any (unlisted schools)
 * @returns deduplicated host patterns for `safeExternalUrl`
 */
export function weekAllowHosts(canvasHost: string | null): string[] {
  const hosts = new Set(BASE_ALLOW_HOSTS);
  const h = canvasHost?.trim().toLowerCase();
  if (h && /^[a-z0-9.-]+$/.test(h) && h.includes(".")) hosts.add(h);
  return [...hosts];
}

/**
 * Maps a timeline view to the client-safe week item: ISO strings, untrusted text cleaned
 * (bidi/zero-width stripped, length-capped). React still escapes everything at render.
 * @param v timeline view (from `listTimeline`)
 * @returns the week item
 */
export function toWeekItem(v: TimelineItemView): WeekItem {
  const title = cleanText(v.title ?? "", TITLE_MAX);
  const course = v.course ? cleanText(v.course, COURSE_MAX) : "";
  return {
    id: v.id,
    source: v.source,
    kind: v.kind,
    title: title || "Untitled",
    course: course || null,
    startsAt: v.startsAt?.toISOString() ?? null,
    endsAt: v.endsAt?.toISOString() ?? null,
    dueAt: v.dueAt?.toISOString() ?? null,
    allDay: v.allDay,
    allDayDate: v.allDay ? v.allDayDate : null,
    url: v.url,
    status: v.status,
  };
}

function midnight(d: LocalDate, tz: string): Date {
  return zonedToUtc({ ...d, hour: 0, minute: 0 }, tz).instant;
}

/**
 * The instant range to query for a week window. The window is 7 local days starting today
 * (or a week later); the query is padded one local day on each side so items anchored near a
 * boundary (all-day items solved in another zone, DST edges) are fetched, then `groupWeek`
 * assigns every item to its exact local day and drops the rest.
 * @param now clock
 * @param timeZone IANA zone
 * @param offsetWeeks 0 or 1
 * @returns `[from, to)` plus `overdueSince` (this week only) for the "still open" tail
 */
export function weekQueryRange(
  now: Date,
  timeZone: string,
  offsetWeeks: 0 | 1,
): { from: Date; to: Date; overdueSince?: Date } {
  const tz = safeTimeZone(timeZone);
  const today = localDateOf(now, tz);
  const first = addLocalDays(today, offsetWeeks * 7);
  const from = midnight(addLocalDays(first, -1), tz);
  const to = midnight(addLocalDays(first, 8), tz);
  return offsetWeeks === 0 ? { from, to, overdueSince: midnight(addLocalDays(today, -8), tz) } : { from, to };
}

function sinceLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(at)
    .replace(",", "");
}

/**
 * Loads the /week view for the signed-in viewer. Integration status failures degrade to
 * "not connected" (logged without user data) so one broken integration never blanks the page;
 * a timeline read failure throws to `(app)/error.tsx`.
 * @param viewer the signed-in viewer
 * @param opts which week, and a clock (tests)
 * @returns the view model
 */
export async function getWeekView(
  viewer: Viewer,
  opts: { offsetWeeks: 0 | 1; now?: Date },
): Promise<WeekPageView> {
  const now = opts.now ?? new Date();
  const timeZone = safeTimeZone(viewer.timezone);
  const range = weekQueryRange(now, timeZone, opts.offsetWeeks);

  const [items, canvas, googleConnected] = await Promise.all([
    listTimeline(
      viewer.userId,
      { from: range.from, to: range.to },
      { includeDone: true, overdueSince: range.overdueSince, timezone: timeZone, now },
    ),
    getCanvasStatus(viewer.userId, now).catch((err: unknown): CanvasStatusView => {
      console.error("[week] canvas status failed:", err instanceof Error ? err.message : "unknown");
      return { connected: false };
    }),
    getGoogleStatus(viewer.userId)
      .then((s) => s.connected)
      .catch((err: unknown) => {
        console.error("[week] google status failed:", err instanceof Error ? err.message : "unknown");
        return false;
      }),
  ]);

  const week = groupWeek(items.map(toWeekItem), { timeZone, now, offsetWeeks: opts.offsetWeeks });
  const canvasFailing = canvas.connected && canvas.health !== "ok";
  return {
    week,
    canvas,
    googleConnected,
    allowHosts: weekAllowHosts(canvas.connected ? canvas.host : null),
    timeZone,
    tzLabel: timeZoneLabel(timeZone, now),
    offsetWeeks: opts.offsetWeeks,
    canvasFailing,
    canvasFailingSince: canvasFailing && canvas.syncedAt ? sinceLabel(canvas.syncedAt, timeZone) : null,
  };
}
