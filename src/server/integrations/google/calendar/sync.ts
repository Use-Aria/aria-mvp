import "server-only";
// OWNER: 3.6

/**
 * Google Calendar → timeline window sync (V2-07 §2.5 option C; master plan §1.9).
 *
 * Every run re-reads the window [local midnight yesterday, local midnight today + 15 days) of each
 * selected calendar (`singleEvents=true`) and hands the complete set to
 * `replaceSourceWindow({source:"gcal"})`: rows not returned are soft-removed, which prunes deleted
 * and declined events. The Aria calendar (task 4.2 creates it) syncs the same way as source
 * `aria`, kind `block`. A calendar that fails for any reason other than 404/410 fails the whole
 * run, so a partial read never prunes real events.
 *
 * Schedules (`jobs/kinds/gcal-*.ts`):
 * - push: `gcal_sync` dedupe `gcal_sync:<uid>`, +20s (from `/api/google/calendar-push`)
 * - periodic: `gcal_sync` dedupe `gcal_sync_periodic:<uid>`, every 3h ± 15 min; 15 min when
 *   `APP_BASE_URL` isn't HTTPS (dev: no push channel at all)
 */
import { db } from "@/server/db";
import { appBaseUrl } from "@/server/env";
import { enqueueJob } from "@/server/jobs/enqueue";
import { replaceSourceWindow } from "@/server/timeline";
import type { TimelineItemInput } from "@/server/timeline/types";
import { addLocalDays, localDateOf, safeTimeZone, zonedToUtc } from "@/shared/time/tz";
import { featuresFor } from "@/server/integrations/google/config";
import { GoogleApiError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { getGoogleIntegration, updateGoogleIntegration, type GoogleIntegration } from "@/server/integrations/google/store";
import { listCalendars, listEventsWindow, type CalendarApiDeps } from "@/server/integrations/google/calendar/api";
import { normalizeEvent, selectCalendars } from "@/server/integrations/google/calendar/normalize";
import type { GCalEventT } from "@/server/integrations/google/calendar/schemas";

/** Days before today included in the window. */
export const SYNC_PAST_DAYS = 1;
/** Days after today included in the window (today + 14 full days). */
export const SYNC_AHEAD_DAYS = 14;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Periodic sync with a push channel (covers non-primary calendars and missed pushes). */
export const PERIODIC_SYNC_MS = 3 * HOUR_MS;
/** ± jitter on the periodic sync. */
export const PERIODIC_JITTER_MS = 15 * MINUTE_MS;
/** Polling interval without a push channel (dev over http://). */
export const DEV_POLL_MS = 15 * MINUTE_MS;
/** Push-triggered sync delay (coalesces bursts of pings). */
export const PUSH_SYNC_DELAY_MS = 20_000;

/** Why a sync ran (the `gcal_sync` payload). */
export type CalendarSyncReason = "push" | "periodic" | "connect" | "manual";

/** Injectable dependencies (tests); production uses the defaults. */
export interface CalendarSyncDeps {
  /** HTTP seam for the Calendar API (and the token layer behind it). */
  api?: CalendarApiDeps;
  now?: () => Date;
  load?: (userId: string) => Promise<GoogleIntegration | null>;
  update?: (id: string, patch: Partial<GoogleIntegration>) => Promise<void>;
  /** The user's zone and known courses. */
  context?: (userId: string) => Promise<{ tz: string; courses: string[] }>;
  replace?: typeof replaceSourceWindow;
}

/** Counts from one window sync. */
export interface CalendarSyncResult {
  upserted: number;
  deleted: number;
  calendars: number;
}

/**
 * The HTTPS push address for calendar channels, or null when `APP_BASE_URL` isn't HTTPS (Google
 * only delivers to HTTPS; dev then polls).
 * @returns absolute URL of `/api/google/calendar-push`, or null
 */
export function calendarPushAddress(): string | null {
  const base = appBaseUrl();
  return base.startsWith("https://") ? `${base}/api/google/calendar-push` : null;
}

/**
 * Interval of the periodic `gcal_sync`: 3h with push, 15 min polling without.
 * @returns milliseconds
 */
export function periodicCalendarSyncMs(): number {
  return calendarPushAddress() ? PERIODIC_SYNC_MS : DEV_POLL_MS;
}

/**
 * Next periodic run: now + interval (± 15 min jitter with push; none when polling).
 * @param now logical now
 * @param rand random source in [0,1)
 * @returns run time
 */
export function nextPeriodicSyncAt(now: Date, rand: () => number = Math.random): Date {
  const base = periodicCalendarSyncMs();
  const jitter = base === PERIODIC_SYNC_MS ? Math.round((rand() * 2 - 1) * PERIODIC_JITTER_MS) : 0;
  return new Date(now.getTime() + base + jitter);
}

/**
 * The sync window in the user's zone: [local midnight of yesterday, local midnight of today + 15).
 * DST-safe (local-date arithmetic, then `zonedToUtc`). Pure.
 * @param now logical now
 * @param tz IANA zone
 * @returns window bounds (from inclusive, to exclusive)
 */
export function syncWindow(now: Date, tz: string): { from: Date; to: Date } {
  const today = localDateOf(now, tz);
  const at = (days: number) => zonedToUtc({ ...addLocalDays(today, days), hour: 0, minute: 0 }, tz).instant;
  return { from: at(-SYNC_PAST_DAYS), to: at(SYNC_AHEAD_DAYS + 1) };
}

/**
 * Make sure the periodic sync chain exists (idempotent: `keep` leaves a pending row alone).
 * @param userId owner
 * @param now logical now
 */
export async function ensurePeriodicCalendarSync(userId: string, now: Date): Promise<void> {
  await enqueueJob({
    kind: "gcal_sync",
    userId,
    dedupeKey: `gcal_sync_periodic:${userId}`,
    runAt: nextPeriodicSyncAt(now),
    payload: { reason: "periodic" },
    mode: "keep",
  });
}

/**
 * Queue a one-off sync (push / retry after a failed connect sync). Coalesces with a pending one.
 * @param userId owner
 * @param reason payload reason
 * @param delayMs delay from now
 */
export async function requestCalendarSync(userId: string, reason: "push" | "connect" | "manual", delayMs: number): Promise<void> {
  await enqueueJob({
    kind: "gcal_sync",
    userId,
    dedupeKey: `gcal_sync:${userId}`,
    runAt: new Date(Date.now() + delayMs),
    payload: { reason },
    mode: "keep",
  });
}

async function defaultContext(userId: string): Promise<{ tz: string; courses: string[] }> {
  const { data, error } = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
  if (error) throw new Error(`gcal sync: user lookup failed: ${error.message}`);
  // Lazy: keeps the memory module graph out of the jobs registry's load path.
  const { getProfile } = await import("@/server/memory");
  const profile = await getProfile(userId);
  return { tz: safeTimeZone(data?.timezone), courses: profile.courses };
}

interface Resolved {
  api: CalendarApiDeps | undefined;
  now: () => Date;
  load: (userId: string) => Promise<GoogleIntegration | null>;
  update: (id: string, patch: Partial<GoogleIntegration>) => Promise<void>;
  context: (userId: string) => Promise<{ tz: string; courses: string[] }>;
  replace: typeof replaceSourceWindow;
}

function resolve(d: CalendarSyncDeps | undefined): Resolved {
  return {
    api: d?.api,
    now: d?.now ?? (() => new Date()),
    load: d?.load ?? getGoogleIntegration,
    update: d?.update ?? updateGoogleIntegration,
    context: d?.context ?? defaultContext,
    replace: d?.replace ?? replaceSourceWindow,
  };
}

function readyRow(row: GoogleIntegration | null): GoogleIntegration {
  if (!row || row.status !== "active" || !featuresFor(row.scopes ?? []).has("calendar_read")) {
    throw new GoogleNotConnectedError("calendar_read");
  }
  return row;
}

function isGone(e: unknown): boolean {
  return e instanceof GoogleApiError && (e.status === 404 || e.status === 410);
}

/** The primary calendar's id is the account email; fall back to the `primary` alias. */
function primaryId(row: GoogleIntegration): string {
  return row.account_email ?? "primary";
}

async function refreshList(userId: string, row: GoogleIntegration, d: Resolved): Promise<string[]> {
  let ids: string[];
  try {
    ids = selectCalendars(await listCalendars(userId, d.api), row.gcal_aria_calendar_id);
  } catch (e) {
    // calendar.calendarlist.readonly unticked (granular consent) → primary only.
    if (e instanceof GoogleApiError && e.status === 403 && e.reason !== "rateLimitExceeded" && e.reason !== "userRateLimitExceeded") {
      ids = [];
    } else {
      throw e;
    }
  }
  if (ids.length === 0) ids = [primaryId(row)];
  await d.update(row.id, { gcal_calendar_ids: ids });
  return ids;
}

/**
 * Re-read the calendar list and store the selected ids in `integrations.gcal_calendar_ids`.
 * Without the calendar-list scope (403), falls back to the primary calendar.
 * @param userId owner
 * @param deps injectable seams (tests)
 * @returns the selected calendar ids
 * @throws GoogleNotConnectedError (inactive / no calendar_read), GoogleApiError, GoogleAuthRevokedError
 */
export async function refreshCalendarList(userId: string, deps?: CalendarSyncDeps): Promise<string[]> {
  const d = resolve(deps);
  return refreshList(userId, readyRow(await d.load(userId)), d);
}

/**
 * One window sync of every selected calendar (source `gcal`) and the Aria calendar (source
 * `aria`). The calendar list is re-read on connect / manual / periodic runs (and whenever none is
 * stored); push runs reuse the stored list.
 * @param userId owner
 * @param reason why the sync runs
 * @param deps injectable seams (tests)
 * @returns rows written, rows soft-removed, calendars read
 * @throws GoogleNotConnectedError (inactive / no calendar_read), GoogleApiError, GoogleAuthRevokedError
 */
export async function syncCalendarWindow(
  userId: string,
  reason: CalendarSyncReason,
  deps?: CalendarSyncDeps,
): Promise<CalendarSyncResult> {
  const d = resolve(deps);
  const row = readyRow(await d.load(userId));
  const now = d.now();
  const stored = row.gcal_calendar_ids ?? [];
  const calendarIds = reason === "push" && stored.length > 0 ? stored : await refreshList(userId, row, d);
  const ariaId = row.gcal_aria_calendar_id;
  const { tz, courses } = await d.context(userId);
  const { from, to } = syncWindow(now, tz);

  const gcalItems: TimelineItemInput[] = [];
  const seen = new Set<string>();
  let read = 0;
  for (const calendarId of calendarIds.filter((id) => id !== ariaId)) {
    let events: GCalEventT[];
    try {
      events = await listEventsWindow(userId, calendarId, from, to, d.api);
    } catch (e) {
      if (isGone(e)) continue; // unsubscribed / deleted calendar: its rows are pruned below
      throw e;
    }
    read++;
    for (const ev of events) {
      const item = normalizeEvent(ev, { tz, calendarId, ariaCalendarId: ariaId, courses });
      if (item && !seen.has(item.externalId)) {
        seen.add(item.externalId);
        gcalItems.push(item);
      }
    }
  }
  const g = await d.replace({ userId, source: "gcal", from, to, items: gcalItems, now });
  let upserted = g.upserted;
  let deleted = g.deleted;

  if (ariaId) {
    let ariaEvents: GCalEventT[];
    try {
      ariaEvents = await listEventsWindow(userId, ariaId, from, to, d.api);
      read++;
    } catch (e) {
      if (!isGone(e)) throw e;
      ariaEvents = []; // the user deleted the Aria calendar: its blocks are gone too
    }
    const items = ariaEvents
      .map((ev) => normalizeEvent(ev, { tz, calendarId: ariaId, ariaCalendarId: ariaId, courses }))
      .filter((x): x is TimelineItemInput => x !== null);
    const a = await d.replace({ userId, source: "aria", from, to, items, now });
    upserted += a.upserted;
    deleted += a.deleted;
  }

  await d.update(row.id, { synced_at: now.toISOString() });
  console.info(`[gcal] sync user=${userId} reason=${reason} calendars=${read} upserted=${upserted} removed=${deleted}`);
  return { upserted, deleted, calendars: read };
}
