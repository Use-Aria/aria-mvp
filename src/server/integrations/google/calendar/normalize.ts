import "server-only";
// OWNER: 3.6

/**
 * Google Calendar event → timeline row (V2-07 §2.5 "Event normalization"; master plan §1.9). Pure.
 *
 * - Cancelled, declined, `workingLocation` and `birthday` events are skipped (the window replace
 *   then prunes any stored copy).
 * - All-day events: `starts_at` = local midnight of `start.date` in the user's zone, `ends_at` =
 *   local midnight of `end.date` (exclusive, Google convention), `allDay`, timing key
 *   `D:YYYYMMDD` (so a later zone change re-bases them). Never busy.
 * - Transparent ("show as available") events are kept for the agenda but are not busy.
 * - Stored fields: title, location, htmlLink, organizer.self, recurringEventId. **Never the
 *   description.** Titles of events the user didn't organize are attacker-controllable: they get
 *   `raw.external = true`, and every model-facing render goes through `renderTimelineForModel`,
 *   which wraps gcal/aria titles in `wrapUntrusted({source:"calendar"})` (master plan §1.0.6).
 * - `external_id` = `<calendarId>|<eventId>` (recurring instance ids are already unique).
 */
import { addLocalDays, formatLocalDate, parseLocalDate, zonedToUtc, type LocalDate } from "@/shared/time/tz";
import type { JsonValue, TimelineItemInput, TimelineKind } from "@/server/timeline/types";
import type { GCalCalendarListEntryT, GCalEventT } from "@/server/integrations/google/calendar/schemas";

/** Per-sync context for `normalizeEvent`. */
export interface NormalizeCtx {
  /** User's IANA zone (all-day bounds). */
  tz: string;
  /** Calendar the event came from. */
  calendarId: string;
  /** The Aria calendar id (its events become `block`s), if any. */
  ariaCalendarId: string | null;
  /** Course names/codes from `user_profile.courses` (class detection). */
  courses: string[];
}

/** Event types never shown on the timeline. */
const SKIP_EVENT_TYPES = new Set(["workingLocation", "birthday"]);
/** Calendars never read: holidays, contacts' birthdays, week numbers. */
const SKIP_CALENDAR_ID = /#holiday@|#contacts@|addressbook#|#weeknum@|#birthday@/i;
/** Most calendars read per user (V2-07 §2.5). */
export const MAX_CALENDARS = 10;

const TITLE_MAX = 300;
const LOCATION_MAX = 200;
const EXAM_RE = /\b(exam|midterm|final|quiz)\b/i;
const CLASS_WORD_RE = /\b(lecture|section|seminar|recitation|lab|class)\b/i;
const COURSE_CODE_RE = /\b([A-Z]{2,4})\s?(\d{3,4})\b/;
const HTML_LINK_RE = /^https:\/\/(www\.)?google\.com\/calendar\//;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The external id for a calendar event.
 * @param calendarId calendar id
 * @param eventId event (or instance) id
 * @returns `<calendarId>|<eventId>`
 */
export function externalIdOf(calendarId: string, eventId: string): string {
  return `${calendarId}|${eventId}`;
}

/**
 * Whether the user declined the event (their own attendee entry says `declined`).
 * @param ev event
 * @returns true when declined
 */
export function isDeclined(ev: GCalEventT): boolean {
  return ev.attendees?.some((a) => a.self === true && a.responseStatus === "declined") ?? false;
}

function localMidnight(d: LocalDate, tz: string): Date {
  return zonedToUtc({ ...d, hour: 0, minute: 0 }, tz).instant;
}

/**
 * Absolute bounds of an event. Timed events use their RFC 3339 instants; all-day events use local
 * midnights of `start.date` / `end.date` (end exclusive; a missing end means one day).
 * @param ev event
 * @param tz user's IANA zone
 * @returns start, end (never before start), all-day flag; null when the event has no usable start
 */
export function eventInterval(ev: GCalEventT, tz: string): { start: Date; end: Date; allDay: boolean } | null {
  const s = ev.start;
  if (!s) return null;
  if (s.dateTime) {
    const start = new Date(s.dateTime);
    if (Number.isNaN(start.getTime())) return null;
    const endRaw = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
    const end = endRaw && !Number.isNaN(endRaw.getTime()) && endRaw >= start ? endRaw : start;
    return { start, end, allDay: false };
  }
  if (s.date) {
    const sd = parseLocalDate(s.date);
    if (!sd) return null;
    const ed = ev.end?.date ? parseLocalDate(ev.end.date) : null;
    const start = localMidnight(sd, tz);
    let end = localMidnight(ed ?? addLocalDays(sd, 1), tz);
    if (end <= start) end = localMidnight(addLocalDays(sd, 1), tz);
    return { start, end, allDay: true };
  }
  return null;
}

/**
 * Whether the event blocks time: not cancelled, not declined, not transparent, not all-day
 * (all-day events are never busy, §13 Q12), not a skipped type.
 * @param ev event
 * @returns true when busy
 */
export function isBusy(ev: GCalEventT): boolean {
  if (ev.status === "cancelled" || isDeclined(ev)) return false;
  if (ev.transparency === "transparent") return false;
  if (ev.eventType && SKIP_EVENT_TYPES.has(ev.eventType)) return false;
  if (!ev.start?.dateTime) return false;
  return true;
}

/**
 * Class / exam detection from the title (V2-07 §2.5 "Kind").
 * - `exam`: exam | midterm | final | quiz
 * - `class`: the title contains a known course, a class word (lecture, section, …), or a course code
 * - otherwise `event`
 * @param title event title
 * @param courses known course names/codes
 * @returns kind and the matched course (null for plain events)
 */
export function classifyEventKind(title: string, courses: readonly string[]): { kind: TimelineKind; course: string | null } {
  const squashed = squash(title);
  let course: string | null = null;
  for (const c of courses) {
    const k = squash(c);
    if (k.length >= 3 && squashed.includes(k)) {
      course = c.trim();
      break;
    }
  }
  const code = COURSE_CODE_RE.exec(title);
  if (!course && code) course = `${code[1]} ${code[2]}`;
  if (EXAM_RE.test(title)) return { kind: "exam", course };
  if (course || CLASS_WORD_RE.test(title)) return { kind: "class", course };
  return { kind: "event", course: null };
}

/**
 * Map one event to a timeline row, or null when it must not appear (cancelled, declined,
 * working-location / birthday, no usable start).
 * @param ev event from `events.list`
 * @param ctx zone, calendar ids, known courses
 * @returns the timeline input (source is chosen by the caller: `gcal`, or `aria` for the Aria calendar)
 */
export function normalizeEvent(ev: GCalEventT, ctx: NormalizeCtx): TimelineItemInput | null {
  if (ev.status === "cancelled") return null;
  if (ev.eventType && SKIP_EVENT_TYPES.has(ev.eventType)) return null;
  if (isDeclined(ev)) return null;
  const iv = eventInterval(ev, ctx.tz);
  if (!iv) return null;

  const isAria = ctx.ariaCalendarId !== null && ctx.calendarId === ctx.ariaCalendarId;
  const title = clip(ev.summary ?? "", TITLE_MAX) || "(no title)";
  const { kind, course } = isAria ? { kind: "block" as const, course: null } : classifyEventKind(title, ctx.courses);

  const raw: { [k: string]: JsonValue } = {
    calendar_id: ctx.calendarId,
    all_day: iv.allDay,
    busy: isBusy(ev),
    external: !isAria && ev.organizer?.self !== true,
  };
  if (ev.location) raw.location = clip(ev.location, LOCATION_MAX);
  if (ev.recurringEventId) raw.recurring_event_id = ev.recurringEventId;
  if (ev.eventType && ev.eventType !== "default") raw.event_type = ev.eventType;
  if (ev.transparency === "transparent") raw.transparent = true;
  const ariaKey = ev.extendedProperties?.private?.aria_key;
  if (isAria && ariaKey) raw.aria_key = ariaKey;

  const item: TimelineItemInput = {
    externalId: externalIdOf(ctx.calendarId, ev.id),
    kind,
    title,
    course,
    startsAt: iv.start,
    endsAt: iv.end,
    dueAt: null,
    allDay: iv.allDay,
    url: ev.htmlLink && HTML_LINK_RE.test(ev.htmlLink) ? ev.htmlLink : null,
    raw,
  };
  if (iv.allDay && ev.start?.date) {
    const d = parseLocalDate(ev.start.date);
    if (d) item.timingKey = `D:${formatLocalDate(d).replace(/-/g, "")}`;
  }
  return item;
}

/**
 * Which calendars to read (V2-07 §2.5): selected (or primary), not deleted, not free/busy-only,
 * not holiday/contacts/week-number calendars, not the Aria calendar (synced separately as
 * `aria`). Primary first, then Google's order; at most 10.
 * @param entries `calendarList` entries
 * @param ariaCalendarId the Aria calendar id, if any
 * @returns calendar ids
 */
export function selectCalendars(entries: readonly GCalCalendarListEntryT[], ariaCalendarId: string | null): string[] {
  const keep = entries.filter(
    (e) =>
      e.deleted !== true &&
      e.id !== ariaCalendarId &&
      e.accessRole !== "freeBusyReader" &&
      !SKIP_CALENDAR_ID.test(e.id) &&
      (e.selected === true || e.primary === true),
  );
  const primary = keep.filter((e) => e.primary === true);
  const rest = keep.filter((e) => e.primary !== true);
  return [...new Set([...primary, ...rest].map((e) => e.id))].slice(0, MAX_CALENDARS);
}
