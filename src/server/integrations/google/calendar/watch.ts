import "server-only";
// OWNER: 3.6

/**
 * Calendar push channels (V2-07 §2.6; fixes AUD-02).
 *
 * - `events.watch` on the **primary** calendar only, with a random per-channel token; the DB keeps
 *   `gcal_channel_id`, `gcal_resource_id`, `sha256(token)` and the expiry Google granted.
 *   Other calendars are covered by the periodic 3h sync.
 * - Renewal (`gcal_watch_renew`, at min(expiry − 24h, now + 6d)) creates the new channel first,
 *   swaps the columns, then stops the old channel (best effort): coverage never has a gap.
 * - Push (`/api/google/calendar-push`): look the channel up by id, compare the token hash in
 *   constant time and the resource id, then enqueue one debounced `gcal_sync`. Notifications
 *   carry no event data. Every outcome answers 200 (a 4xx/5xx only makes Google retry a dead
 *   channel); the periodic sync covers anything missed.
 * - Dev (`APP_BASE_URL` not HTTPS): no channel; the periodic sync polls every 15 min.
 *
 * Never log a channel token; channel ids are logged truncated.
 */
import { randomUUID } from "node:crypto";
import { enqueueJob, cancelJobs } from "@/server/jobs/enqueue";
import { randomToken, safeEqual, sha256Hex } from "@/server/security/crypto";
import { featuresFor } from "@/server/integrations/google/config";
import { GoogleAuthRevokedError } from "@/server/integrations/google/errors";
import {
  findIntegrationByChannelId,
  getGoogleIntegration,
  updateGoogleIntegration,
  type GoogleIntegration,
} from "@/server/integrations/google/store";
import { stopChannel, watchEvents, type CalendarApiDeps } from "@/server/integrations/google/calendar/api";
import {
  calendarPushAddress,
  ensurePeriodicCalendarSync,
  PUSH_SYNC_DELAY_MS,
  requestCalendarSync,
} from "@/server/integrations/google/calendar/sync";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Channel lifetime we ask for (Google caps events channels at ~7 days; it may grant less). */
export const WATCH_TTL_MS = 7 * DAY_MS;
/** Renew this long before expiry. */
export const RENEW_BEFORE_MS = DAY_MS;
/** Never wait longer than this between renewals. */
export const MAX_RENEW_DELAY_MS = 6 * DAY_MS;
/** A channel expiring later than now + this is reused by `startCalendarWatch`. */
const REUSE_MARGIN_MS = DAY_MS;
const MIN_RENEW_DELAY_MS = 60_000;

/** The calendar we watch. */
const WATCHED_CALENDAR = "primary";

/** Google's channel headers (lower-case lookups; `Headers` is case-insensitive). */
export interface CalendarPushHeaders {
  channelId: string | null;
  token: string | null;
  resourceId: string | null;
  state: string | null;
}

/**
 * Read the channel headers of a push notification. Pure.
 * @param h request headers
 * @returns `X-Goog-Channel-ID`, `-Token`, `X-Goog-Resource-ID`, `X-Goog-Resource-State` (null when absent/blank)
 */
export function parseCalendarPushHeaders(h: Headers): CalendarPushHeaders {
  const get = (name: string) => {
    const v = h.get(name)?.trim();
    return v ? v : null;
  };
  return {
    channelId: get("x-goog-channel-id"),
    token: get("x-goog-channel-token"),
    resourceId: get("x-goog-resource-id"),
    state: get("x-goog-resource-state"),
  };
}

/**
 * Authenticate a push against the stored channel: sha256(token) must equal the stored hash
 * (constant time) and the resource id must match. Missing values never verify. Pure.
 * @param h parsed headers
 * @param stored the integration's token hash and resource id
 * @returns true when the push is genuine
 */
export function verifyCalendarPush(h: CalendarPushHeaders, stored: { tokenHash: string | null; resourceId: string | null }): boolean {
  if (!h.token || !h.resourceId || !stored.tokenHash || !stored.resourceId) return false;
  const tokenOk = safeEqual(sha256Hex(h.token), stored.tokenHash);
  const resourceOk = safeEqual(h.resourceId, stored.resourceId);
  return tokenOk && resourceOk;
}

/**
 * When to renew a channel: min(expiry − 24h, now + 6d), but at least a minute from now. Pure.
 * @param expiresAt channel expiry
 * @param now logical now
 * @returns renewal time
 */
export function nextWatchRenewAt(expiresAt: Date, now: Date): Date {
  const t = Math.min(expiresAt.getTime() - RENEW_BEFORE_MS, now.getTime() + MAX_RENEW_DELAY_MS);
  return new Date(Math.max(t, now.getTime() + MIN_RENEW_DELAY_MS));
}

function maskChannel(id: string): string {
  return `…${id.slice(-6)}`;
}

function watchable(row: GoogleIntegration | null): row is GoogleIntegration {
  return row !== null && row.status === "active" && featuresFor(row.scopes ?? []).has("calendar_read");
}

/**
 * Create a channel, store it, then stop the previous one (best effort).
 * @returns the new channel's expiry
 */
async function createAndSwap(userId: string, row: GoogleIntegration, address: string, deps: CalendarApiDeps | undefined): Promise<Date> {
  const now = Date.now();
  const token = randomToken(32);
  const ch = await watchEvents(userId, WATCHED_CALENDAR, { id: randomUUID(), token, address, expirationMs: now + WATCH_TTL_MS }, deps);
  const expiresAt = new Date(Math.min(ch.expiration, now + WATCH_TTL_MS));
  await updateGoogleIntegration(row.id, {
    gcal_channel_id: ch.id,
    gcal_resource_id: ch.resourceId,
    gcal_channel_token_hash: sha256Hex(token),
    gcal_watch_expires_at: expiresAt.toISOString(),
  });
  if (row.gcal_channel_id && row.gcal_resource_id && row.gcal_channel_id !== ch.id) {
    await stopQuietly(userId, { id: row.gcal_channel_id, resourceId: row.gcal_resource_id }, deps);
  }
  return expiresAt;
}

async function stopQuietly(userId: string, ch: { id: string; resourceId: string }, deps: CalendarApiDeps | undefined): Promise<void> {
  try {
    await stopChannel(userId, ch, deps);
  } catch (e) {
    if (e instanceof GoogleAuthRevokedError) throw e;
    // Unstopped channels lapse on their own within 7 days; their pings no longer match a row.
    console.warn(`[gcal] channels.stop failed channel=${maskChannel(ch.id)}: ${e instanceof Error ? e.name : "error"}`);
  }
}

/**
 * Start push for the primary calendar after connect: create a channel (unless a stored one is
 * good for > 24h), schedule `gcal_watch_renew`, and make sure the periodic sync exists.
 * Dev without HTTPS: no channel, 15-minute polling. No-op when Calendar isn't connected.
 * @param userId owner
 * @param deps HTTP seam (tests)
 * @throws GoogleApiError (e.g. the push address was refused), GoogleAuthRevokedError
 */
export async function startCalendarWatch(userId: string, deps?: CalendarApiDeps): Promise<void> {
  const row = await getGoogleIntegration(userId);
  if (!watchable(row)) return;
  const now = new Date();
  const address = calendarPushAddress();
  if (!address) {
    await ensurePeriodicCalendarSync(userId, now);
    console.info(`[gcal] no https push address; polling user=${userId}`);
    return;
  }
  const current = row.gcal_watch_expires_at ? new Date(row.gcal_watch_expires_at) : null;
  const reuse = row.gcal_channel_id && current && current.getTime() > now.getTime() + REUSE_MARGIN_MS;
  const expiresAt = reuse && current ? current : await createAndSwap(userId, row, address, deps);
  await enqueueJob({
    kind: "gcal_watch_renew",
    userId,
    dedupeKey: `gcal_watch_renew:${userId}`,
    runAt: nextWatchRenewAt(expiresAt, now),
    payload: {},
    mode: "replace",
  });
  await ensurePeriodicCalendarSync(userId, now);
  console.info(`[gcal] watch ${reuse ? "kept" : "started"} user=${userId}`);
}

/**
 * Renew the push channel (new channel first, then stop the old one). The caller (job) schedules
 * the next renewal from the returned expiry.
 * @param userId owner
 * @param deps HTTP seam (tests)
 * @returns the new channel's expiry, or null when there is nothing to renew (not connected, or no
 *   HTTPS push address)
 * @throws GoogleApiError, GoogleAuthRevokedError
 */
export async function renewCalendarWatch(userId: string, deps?: CalendarApiDeps): Promise<Date | null> {
  const row = await getGoogleIntegration(userId);
  if (!watchable(row)) return null;
  const address = calendarPushAddress();
  if (!address) return null;
  return createAndSwap(userId, row, address, deps);
}

/**
 * Stop push (disconnect): best-effort `channels.stop`, clear the channel columns, cancel pending
 * `gcal_watch_renew` / `gcal_sync` jobs. Idempotent.
 * @param userId owner
 * @param deps HTTP seam (tests)
 * @throws on a DB error
 */
export async function stopCalendarWatch(userId: string, deps?: CalendarApiDeps): Promise<void> {
  const row = await getGoogleIntegration(userId);
  if (!row) return;
  if (row.status === "active" && row.gcal_channel_id && row.gcal_resource_id) {
    try {
      await stopQuietly(userId, { id: row.gcal_channel_id, resourceId: row.gcal_resource_id }, deps);
    } catch (e) {
      console.warn(`[gcal] channels.stop skipped (auth) user=${userId}: ${e instanceof Error ? e.name : "error"}`);
    }
  }
  await updateGoogleIntegration(row.id, {
    gcal_channel_id: null,
    gcal_resource_id: null,
    gcal_channel_token_hash: null,
    gcal_watch_expires_at: null,
  });
  await cancelJobs({ userId, kinds: ["gcal_watch_renew", "gcal_sync"] });
}

/** What the push handler did (for logs and tests; the HTTP answer is always 200). */
export type CalendarPushOutcome = "no_channel" | "unknown_channel" | "rejected" | "inactive" | "sync_ack" | "ignored_state" | "enqueued";

/** Injectable seams for `handleCalendarPush` (tests). */
export interface CalendarPushDeps {
  find?: (channelId: string) => Promise<GoogleIntegration | null>;
  request?: (userId: string) => Promise<void>;
}

/**
 * Handle one calendar push notification (route logic). Enqueues a debounced `gcal_sync` only for
 * a verified `exists` / `not_exists` ping on an active integration.
 * @param headers request headers
 * @param deps lookup / enqueue seams (tests)
 * @returns what happened
 * @throws on a DB error (the route still answers 200)
 */
export async function handleCalendarPush(headers: Headers, deps?: CalendarPushDeps): Promise<CalendarPushOutcome> {
  const h = parseCalendarPushHeaders(headers);
  if (!h.channelId) return "no_channel";
  const find = deps?.find ?? findIntegrationByChannelId;
  const row = await find(h.channelId);
  if (!row) {
    console.info(`[gcal] push for unknown channel=${maskChannel(h.channelId)}`);
    return "unknown_channel";
  }
  if (!verifyCalendarPush(h, { tokenHash: row.gcal_channel_token_hash, resourceId: row.gcal_resource_id })) {
    console.warn(`[gcal] push rejected (token/resource mismatch) channel=${maskChannel(h.channelId)}`);
    return "rejected";
  }
  if (row.status !== "active") return "inactive";
  if (h.state === "sync") return "sync_ack";
  if (h.state !== "exists" && h.state !== "not_exists") return "ignored_state";
  const request = deps?.request ?? ((userId: string) => requestCalendarSync(userId, "push", PUSH_SYNC_DELAY_MS));
  await request(row.user_id);
  return "enqueued";
}
