import "server-only";
// OWNER: 4.2

/**
 * Writes to the dedicated "Aria" Google calendar (V2-07 §2.8, §7.2 `calendar/aria-calendar.ts`).
 * Aria never writes to any other calendar: the only scope it holds for writes is
 * `calendar.app.created`, and every call here targets `integrations.gcal_aria_calendar_id`.
 *
 * - `ensureAriaCalendar`: lazily `calendars.insert`s "Aria" on the first write (a read-only user
 *   never gets an empty calendar) and stores its id; afterwards the stored id is reused.
 * - `createBlock`: idempotent per `ariaKey` (a private extended property): a retry finds the event
 *   it already made instead of inserting a second one. Then the live conflict re-check, then
 *   `events.insert`, then the timeline upsert (source `aria`, kind `block`).
 * - The user deleted the Aria calendar → a 404 clears the id, the calendar is recreated once and
 *   the result carries a `note` for the model.
 * - `moveBlock` / `deleteBlock`: only timeline rows of source `aria` whose `raw.calendar_id` is the
 *   current Aria calendar. A 404/410 on delete counts as deleted.
 */
import type { TimelineItem, TimelineItemInput } from "@/server/timeline/types";
import { safeTimeZone } from "@/shared/time/tz";
import { featuresFor } from "@/server/integrations/google/config";
import { GoogleApiError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { getGoogleIntegration, updateGoogleIntegration, type GoogleIntegration } from "@/server/integrations/google/store";
import {
  ARIA_KEY_PROPERTY,
  deleteEvent,
  findEventByAriaKey,
  insertCalendar,
  insertEvent,
  patchEvent,
  type CalendarApiDeps,
} from "@/server/integrations/google/calendar/api";
import { collectBusy, type BusyDeps, type Interval } from "@/server/integrations/google/calendar/busy";
import { externalIdOf, normalizeEvent } from "@/server/integrations/google/calendar/normalize";
import type { GCalEventT } from "@/server/integrations/google/calendar/schemas";
import { mergeIntervals } from "@/server/integrations/google/calendar/slots";

/** Calendar name and description shown in Google Calendar. */
export const ARIA_CALENDAR_SUMMARY = "Aria";
export const ARIA_CALENDAR_DESCRIPTION = "Blocks Aria scheduled for you. Hide or delete anytime.";
/** Event description prefix (Aria-authored only; never third-party text). */
export const ARIA_EVENT_DESCRIPTION = "Added by Aria";
/** Note returned when the Aria calendar had to be recreated. */
export const RECREATED_NOTE = "recreated the Aria calendar (the old one was deleted)";

/** Injectable seams (tests); production uses the defaults. */
export interface AriaCalendarDeps {
  /** HTTP seam for the Calendar API (and the token layer behind it) */
  api?: CalendarApiDeps;
  load?: (userId: string) => Promise<GoogleIntegration | null>;
  update?: (id: string, patch: Partial<GoogleIntegration>) => Promise<void>;
  timezone?: (userId: string) => Promise<string>;
  /** busy read for the conflict re-check (seams forwarded to `collectBusy`) */
  busy?: BusyDeps;
  /** owner-scoped live timeline row */
  getItem?: (userId: string, itemId: string) => Promise<TimelineItem | null>;
  upsertItem?: (userId: string, source: "aria", item: TimelineItemInput) => Promise<{ id: string }>;
  /** soft-remove the aria row(s) with this exact external id */
  removeItem?: (userId: string, externalId: string) => Promise<void>;
}

/** `createBlock` input. */
export interface CreateBlockInput {
  title: string;
  start: Date;
  end: Date;
  /** Aria-authored extra text (appended after "Added by Aria") */
  description?: string;
  /** idempotency key (≤ 64 chars), e.g. sha256(runId|title|start|end)[0..32] */
  ariaKey: string;
  allowOverlap: boolean;
}

/** `createBlock` result. */
export type CreateBlockResult =
  | { ok: true; blockId: string; eventId: string; htmlLink?: string; note?: string }
  | { ok: false; reason: "conflict"; conflicts: Interval[] }
  | { ok: false; reason: "no_permission" };

interface Resolved {
  api: CalendarApiDeps | undefined;
  load: (userId: string) => Promise<GoogleIntegration | null>;
  update: (id: string, patch: Partial<GoogleIntegration>) => Promise<void>;
  timezone: (userId: string) => Promise<string>;
  busy: BusyDeps | undefined;
  getItem: (userId: string, itemId: string) => Promise<TimelineItem | null>;
  upsertItem: (userId: string, source: "aria", item: TimelineItemInput) => Promise<{ id: string }>;
  removeItem: (userId: string, externalId: string) => Promise<void>;
}

async function defaultTimezone(userId: string): Promise<string> {
  const { db } = await import("@/server/db");
  const { data, error } = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
  if (error) throw new Error(`aria calendar: user lookup failed: ${error.message}`);
  return safeTimeZone(data?.timezone);
}

async function defaultGetItem(userId: string, itemId: string): Promise<TimelineItem | null> {
  const { getItem } = await import("@/server/timeline/store");
  return getItem(userId, itemId);
}

async function defaultUpsert(userId: string, source: "aria", item: TimelineItemInput): Promise<{ id: string }> {
  const { upsertTimelineItem } = await import("@/server/timeline");
  return upsertTimelineItem(userId, source, item);
}

async function defaultRemove(userId: string, externalId: string): Promise<void> {
  // Aria-created event ids are Google-generated and all the same length, so no other Aria block's
  // external id can start with this one: the prefix prune removes exactly this row.
  const { pruneTimelineItems } = await import("@/server/timeline");
  await pruneTimelineItems({ userId, source: "aria", externalIdPrefix: externalId, keep: [] });
}

function resolve(d: AriaCalendarDeps | undefined): Resolved {
  return {
    api: d?.api,
    load: d?.load ?? getGoogleIntegration,
    update: d?.update ?? updateGoogleIntegration,
    timezone: d?.timezone ?? defaultTimezone,
    busy: d?.busy,
    getItem: d?.getItem ?? defaultGetItem,
    upsertItem: d?.upsertItem ?? defaultUpsert,
    removeItem: d?.removeItem ?? defaultRemove,
  };
}

function isGone(e: unknown): boolean {
  return e instanceof GoogleApiError && (e.status === 404 || e.status === 410);
}

/** Active, with the `calendar.app.created` scope. */
function writable(row: GoogleIntegration | null): row is GoogleIntegration {
  return row !== null && row.status === "active" && featuresFor(row.scopes ?? []).has("calendar_write");
}

async function createCalendar(userId: string, row: GoogleIntegration, tz: string, d: Resolved): Promise<string> {
  const { id } = await insertCalendar(
    userId,
    { summary: ARIA_CALENDAR_SUMMARY, description: ARIA_CALENDAR_DESCRIPTION, timeZone: tz },
    d.api,
  );
  await d.update(row.id, { gcal_aria_calendar_id: id });
  row.gcal_aria_calendar_id = id;
  console.info(`[gcal] aria calendar created user=${userId}`);
  return id;
}

/**
 * The user's Aria calendar id, creating the calendar on first use.
 * @param userId owner
 * @param deps injectable seams (tests)
 * @returns calendar id; `recreated` is always false here (recreation happens inside the write
 *   helpers when Google reports the stored calendar gone)
 * @throws GoogleNotConnectedError when Google isn't active with `calendar_write`; GoogleApiError
 */
export async function ensureAriaCalendar(
  userId: string,
  deps?: AriaCalendarDeps,
): Promise<{ calendarId: string; recreated: boolean }> {
  const d = resolve(deps);
  const row = await d.load(userId);
  if (!writable(row)) throw new GoogleNotConnectedError("calendar_write");
  if (row.gcal_aria_calendar_id) return { calendarId: row.gcal_aria_calendar_id, recreated: false };
  return { calendarId: await createCalendar(userId, row, await d.timezone(userId), d), recreated: false };
}

function toTimelineInput(ev: GCalEventT, calendarId: string, tz: string): TimelineItemInput {
  const item = normalizeEvent(ev, { tz, calendarId, ariaCalendarId: calendarId, courses: [] });
  if (!item) throw new Error("aria calendar: created event is not a timed event");
  return item;
}

/**
 * Put a block on the Aria calendar (V2-07 §2.8 `create_block` steps 1–3).
 * @param userId owner
 * @param input title, instants, Aria-authored description, idempotency key, overlap override
 * @param deps injectable seams (tests)
 * @returns the timeline row id + event id (and a note when the calendar was recreated), a
 *   conflict with the overlapping busy intervals, or `no_permission`
 * @throws GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError (from the token layer)
 */
export async function createBlock(userId: string, input: CreateBlockInput, deps?: AriaCalendarDeps): Promise<CreateBlockResult> {
  const d = resolve(deps);
  const row = await d.load(userId);
  if (!writable(row)) return { ok: false, reason: "no_permission" };
  const tz = await d.timezone(userId);
  let calendarId = row.gcal_aria_calendar_id;
  let note: string | undefined;

  // 1. Retry idempotency: the event this key already created (no conflict check against itself).
  if (calendarId) {
    try {
      const existing = await findEventByAriaKey(userId, calendarId, input.ariaKey, d.api);
      if (existing) {
        const { id } = await d.upsertItem(userId, "aria", toTimelineInput(existing, calendarId, tz));
        return { ok: true, blockId: id, eventId: existing.id, ...(existing.htmlLink ? { htmlLink: existing.htmlLink } : {}) };
      }
    } catch (e) {
      if (!isGone(e)) throw e;
      calendarId = null; // the user deleted the Aria calendar: recreate below
      note = RECREATED_NOTE;
    }
  }

  // 2. Live conflict re-check.
  if (!input.allowOverlap) {
    const detail = await collectBusy(userId, input.start, input.end, { timezone: tz, deps: { api: d.api, load: async () => row, ...d.busy } });
    const conflicts = mergeIntervals(
      detail.intervals.filter((x) => x.end > input.start && x.start < input.end),
      0,
    );
    if (conflicts.length > 0) return { ok: false, reason: "conflict", conflicts };
  }

  // 3. Insert (recreating the calendar once if it's gone).
  const event = {
    summary: input.title,
    description: input.description ? `${ARIA_EVENT_DESCRIPTION}\n\n${input.description}` : ARIA_EVENT_DESCRIPTION,
    start: input.start,
    end: input.end,
    timeZone: tz,
    privateProperties: { aria: "1", [ARIA_KEY_PROPERTY]: input.ariaKey },
  };
  if (!calendarId) {
    calendarId = await createCalendar(userId, row, tz, d);
  }
  let created: GCalEventT;
  try {
    created = await insertEvent(userId, calendarId, event, d.api);
  } catch (e) {
    if (!isGone(e) || note) throw e;
    await d.update(row.id, { gcal_aria_calendar_id: null });
    calendarId = await createCalendar(userId, row, tz, d);
    note = RECREATED_NOTE;
    created = await insertEvent(userId, calendarId, event, d.api);
  }
  const { id } = await d.upsertItem(userId, "aria", toTimelineInput(created, calendarId, tz));
  console.info(`[gcal] aria block created user=${userId}${note ? " recreated=1" : ""}`);
  return {
    ok: true,
    blockId: id,
    eventId: created.id,
    ...(created.htmlLink ? { htmlLink: created.htmlLink } : {}),
    ...(note ? { note } : {}),
  };
}

type BlockRef = { ok: true; row: GoogleIntegration; calendarId: string; eventId: string; item: TimelineItem } | { ok: false; reason: "not_aria_block" | "not_found" };

async function loadBlock(userId: string, blockId: string, d: Resolved): Promise<BlockRef | { ok: false; reason: "no_permission" }> {
  const row = await d.load(userId);
  if (!writable(row)) return { ok: false, reason: "no_permission" };
  const item = await d.getItem(userId, blockId);
  if (!item) return { ok: false, reason: "not_found" };
  const ariaId = row.gcal_aria_calendar_id;
  const calendarId = item.raw && typeof item.raw.calendar_id === "string" ? item.raw.calendar_id : null;
  const prefix = ariaId ? `${ariaId}|` : null;
  if (item.source !== "aria" || !ariaId || calendarId !== ariaId || !prefix || !item.externalId.startsWith(prefix)) {
    return { ok: false, reason: "not_aria_block" };
  }
  const eventId = item.externalId.slice(prefix.length);
  if (!eventId) return { ok: false, reason: "not_aria_block" };
  return { ok: true, row, calendarId: ariaId, eventId, item };
}

/**
 * Move an Aria block to new times (V2-07 §2.8). Refuses rows that aren't Aria blocks on the
 * current Aria calendar, and times that overlap other busy time (the block itself excluded).
 * @param userId owner
 * @param blockId timeline_items.id of the block
 * @param start new start
 * @param end new end
 * @param deps injectable seams (tests)
 * @returns ok, or why not (`no_permission` when Google lacks `calendar_write`)
 * @throws GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError
 */
export async function moveBlock(
  userId: string,
  blockId: string,
  start: Date,
  end: Date,
  deps?: AriaCalendarDeps,
): Promise<{ ok: true } | { ok: false; reason: "not_aria_block" | "not_found" | "conflict" | "no_permission" }> {
  const d = resolve(deps);
  const ref = await loadBlock(userId, blockId, d);
  if (!ref.ok) return ref;
  const tz = await d.timezone(userId);
  const self = externalIdOf(ref.calendarId, ref.eventId);
  const detail = await collectBusy(userId, start, end, { timezone: tz, deps: { api: d.api, load: async () => ref.row, ...d.busy } });
  if (detail.intervals.some((x) => x.key !== self && x.end > start && x.start < end)) return { ok: false, reason: "conflict" };
  let patched: GCalEventT;
  try {
    patched = await patchEvent(userId, ref.calendarId, ref.eventId, { start, end, timeZone: tz }, d.api);
  } catch (e) {
    if (isGone(e)) return { ok: false, reason: "not_found" };
    throw e;
  }
  await d.upsertItem(userId, "aria", toTimelineInput(patched, ref.calendarId, tz));
  console.info(`[gcal] aria block moved user=${userId}`);
  return { ok: true };
}

/**
 * Delete an Aria block (V2-07 §2.8). Already gone in Google (404/410) counts as deleted; the
 * timeline row is soft-removed either way.
 * @param userId owner
 * @param blockId timeline_items.id of the block
 * @param deps injectable seams (tests)
 * @returns ok, or why not (`no_permission` when Google lacks `calendar_write`)
 * @throws GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError
 */
export async function deleteBlock(
  userId: string,
  blockId: string,
  deps?: AriaCalendarDeps,
): Promise<{ ok: true } | { ok: false; reason: "not_aria_block" | "not_found" | "no_permission" }> {
  const d = resolve(deps);
  const ref = await loadBlock(userId, blockId, d);
  if (!ref.ok) return ref;
  await deleteEvent(userId, ref.calendarId, ref.eventId, d.api);
  await d.removeItem(userId, ref.item.externalId);
  console.info(`[gcal] aria block deleted user=${userId}`);
  return { ok: true };
}
