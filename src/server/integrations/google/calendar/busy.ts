import "server-only";
// OWNER: 4.2

/**
 * Busy time for slot finding, the `create_block` conflict re-check and briefing suggestions
 * (V2-07 §2.7 step 3, §7.2 `calendar/busy.ts`; master plan §1.12 `readBusy` in the barrel).
 *
 * Busy = the union of
 * - **live** Google events (V2-07 §2.5: live reads at booking time) on every selected calendar
 *   (`integrations.gcal_calendar_ids`, primary as fallback) and the Aria calendar, filtered by
 *   `isBusy` (cancelled, declined, transparent and all-day events never block time);
 * - timeline items with a time range from non-Google sources (Canvas events, syllabus exam times;
 *   a timed item without an end counts as `DEFAULT_ITEM_MIN`);
 * - weekly class meetings: `user_profile.class_times` and saved syllabus meetings, expanded per
 *   local date in the user's zone.
 *
 * Without Google (not connected, no calendar scope, revoked) the other sources still count and
 * `google` is `"not_connected"`. Any other Google failure throws, so a caller never mistakes an
 * unread calendar for free time. Only instants leave this module — never titles.
 */
import type { TimelineItemView } from "@/server/timeline/types";
import { addLocalDays, localDateOf, localDatesBetween, parseHHMM, safeTimeZone, weekdayOf, zonedToUtc, type Weekday } from "@/shared/time/tz";
import { featuresFor } from "@/server/integrations/google/config";
import { GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { getGoogleIntegration, type GoogleIntegration } from "@/server/integrations/google/store";
import { listEventsWindow, type CalendarApiDeps } from "@/server/integrations/google/calendar/api";
import { eventInterval, externalIdOf, isBusy } from "@/server/integrations/google/calendar/normalize";
import { mergeIntervals } from "@/server/integrations/google/calendar/slots";

/** Half-open time interval [start, end). (`calendar/slots.ts` reuses this type.) */
export interface Interval {
  start: Date;
  end: Date;
}

/** Assumed length of a timed timeline item (exam, Canvas event) that has no end. */
export const DEFAULT_ITEM_MIN = 60;

/** One busy interval with where it came from (`key` = `<calendarId>|<eventId>` for Google events). */
export interface BusyInterval extends Interval {
  source: "gcal" | "aria" | "timeline" | "class";
  key?: string;
}

/** Full busy read. */
export interface BusyDetail {
  /** unmerged, tagged intervals overlapping [from, to) */
  intervals: BusyInterval[];
  /** Google calendars read successfully */
  calendarsChecked: number;
  google: "ok" | "not_connected";
}

/** A weekly meeting: weekdays + local "HH:MM" bounds. */
export interface WeeklyMeeting {
  days: readonly Weekday[];
  start: string;
  end: string;
}

/** Timeline fields the busy read needs. */
export type BusyTimelineItem = Pick<TimelineItemView, "source" | "kind" | "startsAt" | "endsAt" | "allDay">;

/** Injectable seams (tests); production uses the defaults. */
export interface BusyDeps {
  /** HTTP seam for the Calendar API */
  api?: CalendarApiDeps;
  load?: (userId: string) => Promise<GoogleIntegration | null>;
  /** non-Google timeline items anchored in [from, to) */
  timeline?: (userId: string, from: Date, to: Date, tz: string) => Promise<BusyTimelineItem[]>;
  /** class times + syllabus meetings */
  meetings?: (userId: string) => Promise<WeeklyMeeting[]>;
  timezone?: (userId: string) => Promise<string>;
}

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIMED_KINDS = new Set(["event", "class", "exam"]);

function overlaps(x: Interval, from: Date, to: Date): boolean {
  return x.end > from && x.start < to;
}

/**
 * Expand weekly meetings over [from, to) in the user's zone (per local date, DST-safe).
 * Meetings with an end at or before the start, or malformed times, are skipped.
 * @param meetings weekly meetings
 * @param from window start
 * @param to window end
 * @param tz IANA zone
 * @returns intervals overlapping the window
 */
export function weeklyIntervals(meetings: readonly WeeklyMeeting[], from: Date, to: Date, tz: string): Interval[] {
  const valid = meetings.filter(
    (m) => HHMM_RE.test(m.start) && HHMM_RE.test(m.end) && m.end > m.start && m.days.length > 0,
  );
  if (valid.length === 0 || to <= from) return [];
  const out: Interval[] = [];
  const dates = [addLocalDays(localDateOf(from, tz), -1), ...localDatesBetween(from, to, tz)];
  for (const date of dates) {
    const wd = weekdayOf(date);
    for (const m of valid) {
      if (!m.days.includes(wd)) continue;
      const start = zonedToUtc({ ...date, ...parseHHMM(m.start) }, tz).instant;
      const end = zonedToUtc({ ...date, ...parseHHMM(m.end) }, tz).instant;
      const iv = { start, end };
      if (end > start && overlaps(iv, from, to)) out.push(iv);
    }
  }
  return out;
}

/**
 * Busy intervals from timeline items: timed (not all-day) events, classes and exams; a missing
 * end counts as `DEFAULT_ITEM_MIN`. Assignments (a due instant, no duration) never block time.
 * @param items timeline items
 * @param from window start
 * @param to window end
 * @returns intervals overlapping the window
 */
export function timelineIntervals(items: readonly BusyTimelineItem[], from: Date, to: Date): Interval[] {
  const out: Interval[] = [];
  for (const it of items) {
    if (it.allDay || !it.startsAt || !TIMED_KINDS.has(it.kind)) continue;
    const end = it.endsAt && it.endsAt > it.startsAt ? it.endsAt : new Date(it.startsAt.getTime() + DEFAULT_ITEM_MIN * MIN_MS);
    const iv = { start: it.startsAt, end };
    if (overlaps(iv, from, to)) out.push(iv);
  }
  return out;
}

async function defaultTimezone(userId: string): Promise<string> {
  const { db } = await import("@/server/db");
  const { data, error } = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
  if (error) throw new Error(`readBusy: user lookup failed: ${error.message}`);
  return safeTimeZone(data?.timezone);
}

async function defaultTimeline(userId: string, from: Date, to: Date, tz: string): Promise<BusyTimelineItem[]> {
  // Lazy: keeps the timeline graph out of the google barrel's load path.
  const { listTimeline } = await import("@/server/timeline");
  return listTimeline(userId, { from, to }, { sources: ["canvas", "syllabus"], statuses: ["upcoming", "done"], timezone: tz, now: from });
}

async function defaultMeetings(userId: string): Promise<WeeklyMeeting[]> {
  const [{ getProfile }, { getSyllabusSignals }] = await Promise.all([
    import("@/server/memory"),
    import("@/server/integrations/syllabus"),
  ]);
  const [profile, signals] = await Promise.all([getProfile(userId), getSyllabusSignals(userId)]);
  const out: WeeklyMeeting[] = profile.classTimes.map((c) => ({ days: c.days, start: c.start, end: c.end }));
  for (const s of signals) {
    for (const m of s.meetings) {
      if (m.start_local && m.end_local) out.push({ days: m.days, start: m.start_local, end: m.end_local });
    }
  }
  return out;
}

function isGone(e: unknown): boolean {
  return e instanceof GoogleApiError && (e.status === 404 || e.status === 410);
}

function calendarsToRead(row: GoogleIntegration): string[] {
  const stored = (row.gcal_calendar_ids ?? []).filter((id) => id !== row.gcal_aria_calendar_id);
  const base = stored.length > 0 ? stored : [row.account_email ?? "primary"];
  return row.gcal_aria_calendar_id ? [...base, row.gcal_aria_calendar_id] : base;
}

async function googleIntervals(
  userId: string,
  from: Date,
  to: Date,
  tz: string,
  d: BusyDeps,
): Promise<{ intervals: BusyInterval[]; checked: number; google: "ok" | "not_connected" }> {
  const row = await (d.load ?? getGoogleIntegration)(userId);
  if (!row || row.status !== "active" || !featuresFor(row.scopes ?? []).has("calendar_read")) {
    return { intervals: [], checked: 0, google: "not_connected" };
  }
  const intervals: BusyInterval[] = [];
  let checked = 0;
  try {
    for (const calendarId of calendarsToRead(row)) {
      let events;
      try {
        events = await listEventsWindow(userId, calendarId, from, to, d.api);
      } catch (e) {
        if (isGone(e)) continue; // deleted / unsubscribed calendar
        throw e;
      }
      checked++;
      const source = calendarId === row.gcal_aria_calendar_id ? "aria" : "gcal";
      for (const ev of events) {
        if (!isBusy(ev)) continue;
        const iv = eventInterval(ev, tz);
        if (!iv || iv.allDay || iv.end <= iv.start || !overlaps(iv, from, to)) continue;
        intervals.push({ start: iv.start, end: iv.end, source, key: externalIdOf(calendarId, ev.id) });
      }
    }
  } catch (e) {
    if (e instanceof GoogleNotConnectedError || e instanceof GoogleAuthRevokedError) {
      return { intervals: [], checked: 0, google: "not_connected" };
    }
    throw e;
  }
  return { intervals, checked, google: "ok" };
}

/**
 * Every busy interval overlapping [from, to), tagged by source (unmerged).
 * @param userId owner
 * @param from window start
 * @param to window end
 * @param opts user's zone (read from `users.timezone` when omitted) and test seams
 * @returns tagged intervals, Google calendars read, Google availability
 * @throws GoogleApiError on a Google failure other than "calendar gone" / not connected
 */
export async function collectBusy(
  userId: string,
  from: Date,
  to: Date,
  opts?: { timezone?: string; deps?: BusyDeps },
): Promise<BusyDetail> {
  if (to <= from) return { intervals: [], calendarsChecked: 0, google: "ok" };
  const d = opts?.deps ?? {};
  const tz = opts?.timezone ? safeTimeZone(opts.timezone) : await (d.timezone ?? defaultTimezone)(userId);
  // Timeline reads are anchored on start: look back a day so long items that began earlier count.
  const lookBack = new Date(from.getTime() - DAY_MS);
  const [g, items, meetings] = await Promise.all([
    googleIntervals(userId, from, to, tz, d),
    (d.timeline ?? defaultTimeline)(userId, lookBack, to, tz),
    (d.meetings ?? defaultMeetings)(userId),
  ]);
  const intervals: BusyInterval[] = [
    ...g.intervals,
    ...timelineIntervals(items, from, to).map((iv) => ({ ...iv, source: "timeline" as const })),
    ...weeklyIntervals(meetings, from, to, tz).map((iv) => ({ ...iv, source: "class" as const })),
  ];
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  return { intervals, calendarsChecked: g.checked, google: g.google };
}

/**
 * Union of busy time across Google calendars, non-gcal timeline items and class times.
 * @param userId owner
 * @param from window start
 * @param to window end
 * @param opts optional user zone and test seams (callers normally omit it)
 * @returns merged busy intervals (sorted, disjoint, unpadded) and how many Google calendars were read
 * @throws GoogleApiError on a Google failure other than "calendar gone" / not connected
 */
export async function readBusy(
  userId: string,
  from: Date,
  to: Date,
  opts?: { timezone?: string; deps?: BusyDeps },
): Promise<{ busy: Interval[]; calendarsChecked: number }> {
  const detail = await collectBusy(userId, from, to, opts);
  return { busy: mergeIntervals(detail.intervals, 0), calendarsChecked: detail.calendarsChecked };
}
