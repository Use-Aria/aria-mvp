import "server-only";
// OWNER: 3.6

/**
 * Thin Google Calendar REST wrappers over `googleFetch` (V2-07 §7.2 `calendar/api.ts`).
 *
 * Every response is zod-validated (`calendar/schemas.ts`). The optional trailing `deps` is the
 * HTTP seam (`googleFetch`'s injected `fetch` / token store), used by tests; production omits it.
 * Event descriptions are never requested (`fields` partial responses) and never stored.
 *
 * The write helpers (`insertCalendar`, `insertEvent`, `patchEvent`, `deleteEvent`,
 * `findEventByAriaKey`, `getCalendar`, `findOwnedCalendars`) exist for task 4.2's Aria-calendar
 * writes; the scope `calendar.app.created` only lets them touch calendars Aria created.
 *
 * Retry policy (`http.ts`): the two creating POSTs (`calendars.insert`, `events.insert`) are sent
 * with `retry: "none"`. Everything else keeps the default backoff because a repeat is harmless:
 * GETs, `events.patch` (same body → same result), `events.delete` / `channels.stop` (404 counts
 * as done), and `events.watch` (the client-chosen channel id makes a duplicate open fail rather
 * than create a second channel; an orphan channel expires on its own).
 */
import { z } from "zod";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { googleFetch, googleFetchNoContent, type GoogleFetchDeps } from "@/server/integrations/google/http";
import {
  GCalCalendar,
  GCalCalendarList,
  GCalChannel,
  GCalEvent,
  GCalEventList,
  type GCalCalendarListEntryT,
  type GCalEventT,
} from "@/server/integrations/google/calendar/schemas";

/** Calendar REST base. */
export const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

/** HTTP seam forwarded to `googleFetch` (tests inject `fetch` and a token store). */
export type CalendarApiDeps = GoogleFetchDeps;

/** `events.list` page size and page cap per calendar per window (2,500 events is far beyond a 16-day window). */
export const EVENTS_PAGE_SIZE = 250;
export const MAX_EVENT_PAGES = 10;
/** `calendarList.list` page cap. */
export const MAX_CALENDAR_LIST_PAGES = 5;

/** Partial-response field mask for events (never `description`). */
const EVENT_FIELDS =
  "id,status,summary,location,htmlLink,start,end,transparency,eventType,attendees(self,responseStatus),organizer(self),recurringEventId,extendedProperties";
const EVENT_LIST_FIELDS = `nextPageToken,items(${EVENT_FIELDS})`;

/** Private extended property that marks an Aria-created block (idempotency key, V2-07 §2.8). */
export const ARIA_KEY_PROPERTY = "aria_key";

function cal(calendarId: string): string {
  return `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}`;
}

/** 404 / 410 → the calendar or event is gone. */
function isGone(e: unknown): boolean {
  return e instanceof GoogleApiError && (e.status === 404 || e.status === 410);
}

/** Validate list items one by one: an event we can't read is skipped, not fatal. */
function parseEvents(items: unknown[]): { events: GCalEventT[]; dropped: number } {
  const events: GCalEventT[] = [];
  let dropped = 0;
  for (const it of items) {
    const p = GCalEvent.safeParse(it);
    if (p.success) events.push(p.data);
    else dropped++;
  }
  return { events, dropped };
}

/**
 * `calendarList.list` (all pages up to the cap; hidden and deleted entries excluded by Google's defaults).
 * @param userId owner
 * @param deps HTTP seam (tests)
 * @returns calendar list entries
 * @throws GoogleApiError (403 when `calendar.calendarlist.readonly` wasn't granted), GoogleAuthRevokedError, GoogleNotConnectedError
 */
export async function listCalendars(userId: string, deps?: CalendarApiDeps): Promise<GCalCalendarListEntryT[]> {
  const out: GCalCalendarListEntryT[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_CALENDAR_LIST_PAGES; page++) {
    const r = await googleFetch(
      userId,
      {
        url: `${CALENDAR_BASE}/users/me/calendarList`,
        query: {
          maxResults: 250,
          pageToken,
          fields: "nextPageToken,items(id,summary,primary,selected,hidden,deleted,accessRole,timeZone)",
        },
      },
      GCalCalendarList,
      deps,
    );
    out.push(...r.items);
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * Every event instance overlapping `[from, to)` on one calendar: `singleEvents=true` (recurring
 * events expanded into instances), ordered by start, paged (250 per page).
 * @param userId owner
 * @param calendarId calendar id (`primary` allowed)
 * @param from window start
 * @param to window end
 * @param deps HTTP seam (tests)
 * @returns validated events (unreadable entries dropped)
 * @throws GoogleApiError (404/410 when the calendar is gone; `too_many_events` past the page cap,
 *   so a truncated list never prunes real events), GoogleAuthRevokedError, GoogleNotConnectedError
 */
export async function listEventsWindow(
  userId: string,
  calendarId: string,
  from: Date,
  to: Date,
  deps?: CalendarApiDeps,
): Promise<GCalEventT[]> {
  const out: GCalEventT[] = [];
  let dropped = 0;
  let pageToken: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_EVENT_PAGES) {
      throw new GoogleApiError("calendar events.list exceeded the page cap", { status: 0, reason: "too_many_events", retryable: false });
    }
    const r = await googleFetch(
      userId,
      {
        url: `${cal(calendarId)}/events`,
        query: {
          singleEvents: true,
          orderBy: "startTime",
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          maxResults: EVENTS_PAGE_SIZE,
          maxAttendees: 1,
          pageToken,
          fields: EVENT_LIST_FIELDS,
        },
      },
      GCalEventList,
      deps,
    );
    const p = parseEvents(r.items);
    out.push(...p.events);
    dropped += p.dropped;
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  if (dropped > 0) console.warn(`[gcal] dropped ${dropped} unreadable event(s) user=${userId}`);
  return out;
}

/**
 * The event carrying a given `aria_key` private property (retry idempotency for `create_block`).
 * @param userId owner
 * @param calendarId the Aria calendar
 * @param ariaKey idempotency key
 * @param deps HTTP seam (tests)
 * @returns the event, or null
 */
export async function findEventByAriaKey(
  userId: string,
  calendarId: string,
  ariaKey: string,
  deps?: CalendarApiDeps,
): Promise<GCalEventT | null> {
  const r = await googleFetch(
    userId,
    {
      url: `${cal(calendarId)}/events`,
      query: { privateExtendedProperty: `${ARIA_KEY_PROPERTY}=${ariaKey}`, maxResults: 5, fields: EVENT_LIST_FIELDS },
    },
    GCalEventList,
    deps,
  );
  const { events } = parseEvents(r.items);
  return events.find((e) => e.status !== "cancelled") ?? null;
}

/**
 * `calendars.insert` (a secondary calendar owned by the user; needs `calendar.app.created`).
 * Never retried automatically (`retry: "none"`).
 * @param userId owner
 * @param body summary, description, IANA time zone
 * @param deps HTTP seam (tests)
 * @returns the new calendar id
 * @throws GoogleWriteUnknownError when it may or may not have been created; GoogleApiError otherwise
 */
export async function insertCalendar(
  userId: string,
  body: { summary: string; description: string; timeZone: string },
  deps?: CalendarApiDeps,
): Promise<{ id: string }> {
  // Never retried: a resend after a timeout/5xx could create a second "Aria" calendar.
  const r = await googleFetch(userId, { method: "POST", url: `${CALENDAR_BASE}/calendars`, body, retry: "none" }, GCalCalendar, deps);
  return { id: r.id };
}

/** `calendarList` entry fields used to recognise a calendar Aria created. */
const OwnedCalendarList = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        summary: z.string().optional(),
        description: z.string().optional(),
        accessRole: z.string().optional(),
        primary: z.boolean().optional(),
        deleted: z.boolean().optional(),
      }),
    )
    .optional()
    .default([]),
  nextPageToken: z.string().optional(),
});

/**
 * Calendars on the user's list that look like ones Aria created: exact `summary` and
 * `description`, owned by the user, not primary, not deleted. Used after an ambiguous
 * `calendars.insert` to adopt the calendar it may have created instead of making another.
 * `calendarList.list` needs `calendar.calendarlist.readonly` (requested, but optional at consent).
 * @param userId owner
 * @param match exact summary + description Aria sets on its calendar
 * @param deps HTTP seam (tests)
 * @returns matching calendar ids, sorted (deterministic choice when there are several)
 * @throws GoogleApiError (403 without the calendar-list scope), GoogleAuthRevokedError, GoogleNotConnectedError
 */
export async function findOwnedCalendars(
  userId: string,
  match: { summary: string; description: string },
  deps?: CalendarApiDeps,
): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_CALENDAR_LIST_PAGES; page++) {
    const r = await googleFetch(
      userId,
      {
        url: `${CALENDAR_BASE}/users/me/calendarList`,
        query: {
          maxResults: 250,
          minAccessRole: "owner",
          showHidden: true,
          pageToken,
          fields: "nextPageToken,items(id,summary,description,accessRole,primary,deleted)",
        },
      },
      OwnedCalendarList,
      deps,
    );
    for (const c of r.items) {
      if (c.summary === match.summary && c.description === match.description && c.accessRole === "owner" && !c.primary && !c.deleted) {
        out.push(c.id);
      }
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out.sort();
}

/**
 * `calendars.get`.
 * @param userId owner
 * @param calendarId calendar id
 * @param deps HTTP seam (tests)
 * @returns `{id}`, or null when the calendar is gone (404/410)
 */
export async function getCalendar(userId: string, calendarId: string, deps?: CalendarApiDeps): Promise<{ id: string } | null> {
  try {
    const r = await googleFetch(userId, { url: cal(calendarId), query: { fields: "id" } }, GCalCalendar, deps);
    return { id: r.id };
  } catch (e) {
    if (isGone(e)) return null;
    throw e;
  }
}

/** A new (or patched) timed event on the Aria calendar. */
export interface NewEvent {
  summary: string;
  /** Aria-authored text only; never third-party content. */
  description?: string;
  start: Date;
  end: Date;
  /** IANA zone shown in Google's UI (instants are absolute either way). */
  timeZone?: string;
  /** Private extended properties, e.g. `{ aria_key }`. */
  privateProperties?: Record<string, string>;
}

function eventBody(ev: Partial<NewEvent>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (ev.summary !== undefined) body.summary = ev.summary;
  if (ev.description !== undefined) body.description = ev.description;
  const tz = ev.timeZone ? { timeZone: ev.timeZone } : {};
  if (ev.start) body.start = { dateTime: ev.start.toISOString(), ...tz };
  if (ev.end) body.end = { dateTime: ev.end.toISOString(), ...tz };
  if (ev.privateProperties) body.extendedProperties = { private: ev.privateProperties };
  return body;
}

/**
 * `events.insert`. Never retried automatically (`retry: "none"`).
 * @param userId owner
 * @param calendarId target (the Aria calendar)
 * @param ev event
 * @param deps HTTP seam (tests)
 * @returns the created event
 * @throws GoogleWriteUnknownError when it may or may not have been created; GoogleApiError otherwise
 */
export async function insertEvent(userId: string, calendarId: string, ev: NewEvent, deps?: CalendarApiDeps): Promise<GCalEventT> {
  return googleFetch(
    userId,
    // Never retried: a resend after a timeout/5xx could duplicate the event (`aria-calendar.ts`
    // then looks the event up by its `aria_key` instead).
    { method: "POST", url: `${cal(calendarId)}/events`, query: { fields: EVENT_FIELDS }, body: eventBody(ev), retry: "none" },
    GCalEvent,
    deps,
  );
}

/**
 * `events.patch`.
 * @param userId owner
 * @param calendarId calendar
 * @param eventId event
 * @param patch fields to change
 * @param deps HTTP seam (tests)
 * @returns the updated event
 */
export async function patchEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  patch: Partial<NewEvent>,
  deps?: CalendarApiDeps,
): Promise<GCalEventT> {
  return googleFetch(
    userId,
    {
      method: "PATCH",
      url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
      query: { fields: EVENT_FIELDS },
      body: eventBody(patch),
    },
    GCalEvent,
    deps,
  );
}

/**
 * `events.delete`. Already gone (404/410) counts as deleted.
 * @param userId owner
 * @param calendarId calendar
 * @param eventId event
 * @param deps HTTP seam (tests)
 */
export async function deleteEvent(userId: string, calendarId: string, eventId: string, deps?: CalendarApiDeps): Promise<void> {
  try {
    await googleFetchNoContent(userId, { method: "DELETE", url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}` }, deps);
  } catch (e) {
    if (!isGone(e)) throw e;
  }
}

/**
 * `events.watch`: open a push channel for a calendar's events (V2-07 §2.6).
 * @param userId owner
 * @param calendarId calendar (`primary`)
 * @param ch channel id (uuid), secret token, HTTPS address, requested expiry (epoch ms)
 * @param deps HTTP seam (tests)
 * @returns channel id, resource id, and the expiry Google granted (epoch ms; may be shorter than asked)
 */
export async function watchEvents(
  userId: string,
  calendarId: string,
  ch: { id: string; token: string; address: string; expirationMs: number },
  deps?: CalendarApiDeps,
): Promise<{ id: string; resourceId: string; expiration: number }> {
  const r = await googleFetch(
    userId,
    {
      method: "POST",
      url: `${cal(calendarId)}/events/watch`,
      body: { id: ch.id, type: "web_hook", address: ch.address, token: ch.token, expiration: String(ch.expirationMs) },
    },
    GCalChannel,
    deps,
  );
  return { id: r.id, resourceId: r.resourceId, expiration: r.expiration ?? ch.expirationMs };
}

/**
 * `channels.stop`. An already-dead channel (404) counts as stopped.
 * @param userId owner
 * @param ch channel id + resource id
 * @param deps HTTP seam (tests)
 */
export async function stopChannel(userId: string, ch: { id: string; resourceId: string }, deps?: CalendarApiDeps): Promise<void> {
  try {
    await googleFetchNoContent(
      userId,
      { method: "POST", url: `${CALENDAR_BASE}/channels/stop`, body: { id: ch.id, resourceId: ch.resourceId } },
      deps,
    );
  } catch (e) {
    if (!isGone(e)) throw e;
  }
}
