import "server-only";
// OWNER: 3.6

/**
 * Zod schemas for the Google Calendar fields Aria reads (V2-07 §2.2, §7.2 `calendar/schemas.ts`).
 * Google responses are untrusted input: everything is validated at the boundary, unknown keys are
 * stripped, and an event's `description` is never parsed (so it can never be stored).
 */
import { z } from "zod";

/** `start` / `end` of an event: `date` (all-day, YYYY-MM-DD) or `dateTime` (RFC 3339). */
export const GCalEventDateTime = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

/** One event (only the fields we use). */
export const GCalEvent = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().optional(),
  start: GCalEventDateTime.optional(),
  end: GCalEventDateTime.optional(),
  transparency: z.string().optional(),
  eventType: z.string().optional(),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
  organizer: z.object({ self: z.boolean().optional() }).optional(),
  recurringEventId: z.string().optional(),
  extendedProperties: z
    .object({
      private: z.record(z.string(), z.string()).optional(),
      shared: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});
export type GCalEventT = z.infer<typeof GCalEvent>;

/**
 * `events.list` page. Items are kept as `unknown` here and validated one by one in `api.ts`, so a
 * single odd event is dropped instead of failing the whole sync.
 */
export const GCalEventList = z.object({
  items: z.array(z.unknown()).optional().default([]),
  nextPageToken: z.string().optional(),
});
export type GCalEventListT = z.infer<typeof GCalEventList>;

/** One `calendarList` entry. */
export const GCalCalendarListEntry = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  primary: z.boolean().optional(),
  selected: z.boolean().optional(),
  hidden: z.boolean().optional(),
  deleted: z.boolean().optional(),
  accessRole: z.string().optional(),
  timeZone: z.string().optional(),
});
export type GCalCalendarListEntryT = z.infer<typeof GCalCalendarListEntry>;

/** `calendarList.list` page. */
export const GCalCalendarList = z.object({
  items: z.array(GCalCalendarListEntry).optional().default([]),
  nextPageToken: z.string().optional(),
});
export type GCalCalendarListT = z.infer<typeof GCalCalendarList>;

/** `events.watch` response. `expiration` is epoch ms, sent as a decimal string. */
export const GCalChannel = z.object({
  id: z.string().min(1),
  resourceId: z.string().min(1),
  expiration: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    }),
});
export type GCalChannelT = z.infer<typeof GCalChannel>;

/** `calendars.get` / `calendars.insert` response. */
export const GCalCalendar = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  timeZone: z.string().optional(),
});
export type GCalCalendarT = z.infer<typeof GCalCalendar>;
