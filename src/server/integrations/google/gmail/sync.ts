import "server-only";
// OWNER: 2.5

/**
 * Gmail watch lifecycle + history sync (V2-07 §2.9; master plan §1.12; fixes AUD-01/04/19 and the
 * V1 cursor-clobber bug).
 *
 * Cursor rules (`integrations.gmail_history_id`), all enforced in SQL by `advance_gmail_cursor`:
 * - normal sync advances it only FORWARD, and only after the new rows are durable
 * - `users.watch` (start AND renew) sets it only when it is NULL (compare-and-set from null);
 *   a watch never overwrites an existing cursor
 * - a 404 resync resets it with compare-and-set against the stale value we read
 * The watch expiry lives in its own column (`gmail_watch_expires_at`, AUD-04).
 *
 * Schedules (job kinds in `jobs/kinds/gmail-*.ts`):
 * - `gmail_watch_renew` daily (24h ± 1h), dedupe `gmail_watch_renew:<uid>`
 * - periodic `gmail_history_sync` every 2h (5 min in dev without `GMAIL_PUBSUB_TOPIC`, which
 *   means no push at all), dedupe `gmail_sync_periodic:<uid>`
 * - push syncs come from `/api/google/gmail-push`, dedupe `gmail_sync:<uid>`, +3s
 */
import { db } from "@/server/db";
import { enqueueJob, cancelJobs } from "@/server/jobs/enqueue";
import { featuresFor, gmailPushConfig } from "@/server/integrations/google/config";
import { getGoogleIntegration, updateGoogleIntegration, type GoogleIntegration } from "@/server/integrations/google/store";
import {
  gmailProfile,
  gmailStop,
  gmailWatch,
  listHistory,
  listMessageIds,
  type GmailApiDeps,
} from "@/server/integrations/google/gmail/api";
import {
  ingestMessages,
  listPendingEmailItems,
  processEmailItems,
  type IngestDeps,
} from "@/server/integrations/google/gmail/ingest";

/** Sync knobs: HTTP seam + job budget. */
export type GmailSyncDeps = IngestDeps;

/** Result of one history sync. */
export interface HistorySyncResult {
  /** Rows processed (pending retries + new rows). */
  processed: number;
  alerted: number;
  /** A 404 forced a resync this run. */
  resynced: boolean;
  /** Work left over (page cap or deadline): the caller should schedule a follow-up sync. */
  backlog: boolean;
  /** Gmail is not connected/active for this user: nothing ran, no follow-ups. */
  skipped: boolean;
}

const HOUR_MS = 60 * 60_000;
/** Periodic safety-net interval with push configured (V2-07 §2.9 "Safety net"). */
export const PERIODIC_SYNC_MS = 2 * HOUR_MS;
/** Polling interval in dev without a Pub/Sub topic. */
export const DEV_POLL_MS = 5 * 60_000;
/** Resync search (V2-07 §2.9 "Resync on 404"). */
export const RESYNC_QUERY = "in:inbox newer_than:2d -category:promotions -category:social";
const RESYNC_MAX = 100;
const PENDING_RETRY_LIMIT = 100;

/**
 * True when the integration can read Gmail right now.
 * @param integ Google integration row (or null)
 * @returns active + `gmail.readonly` granted
 */
export function gmailReady(integ: GoogleIntegration | null): integ is GoogleIntegration {
  return integ !== null && integ.status === "active" && featuresFor(integ.scopes ?? []).has("gmail_read");
}

/**
 * Interval of the periodic `gmail_history_sync` (2h with push, 5 min polling without a topic).
 * @returns milliseconds
 */
export function periodicSyncIntervalMs(): number {
  return gmailPushConfig() ? PERIODIC_SYNC_MS : DEV_POLL_MS;
}

/**
 * Next daily watch renewal: now + 24h ± 1h (jitter spreads users).
 * @param now logical now
 * @param rand random source in [0,1)
 * @returns run time
 */
export function nextRenewAt(now: Date, rand: () => number = Math.random): Date {
  return new Date(now.getTime() + 24 * HOUR_MS + Math.round((rand() * 2 - 1) * HOUR_MS));
}

/**
 * Move the history cursor through `advance_gmail_cursor` (monotonic forward; or compare-and-set
 * with `force`). The only other write is the teardown NULL in `stopGmailWatch`.
 * @param integrationId integrations.id
 * @param newId new history id (decimal)
 * @param opts `force` → CAS against `expected` (`null`/omitted = only when the cursor is NULL)
 * @returns true when the cursor changed
 */
export async function advanceGmailCursor(
  integrationId: string,
  newId: string,
  opts: { force?: boolean; expected?: string | null } = {},
): Promise<boolean> {
  const args: { p_integration_id: string; p_new: string; p_force?: boolean; p_expected?: string } = {
    p_integration_id: integrationId,
    p_new: newId,
  };
  if (opts.force) {
    args.p_force = true;
    if (opts.expected !== undefined && opts.expected !== null) args.p_expected = opts.expected;
  }
  const { data, error } = await db().rpc("advance_gmail_cursor", args);
  if (error) throw new Error(`advance_gmail_cursor: ${error.message}`);
  return data === true;
}

/**
 * Make sure the periodic-sync chain exists (idempotent: `keep` leaves a pending row alone).
 * @param userId owner
 * @param now logical now
 */
export async function ensurePeriodicGmailSync(userId: string, now: Date): Promise<void> {
  await enqueueJob({
    kind: "gmail_history_sync",
    userId,
    dedupeKey: `gmail_sync_periodic:${userId}`,
    runAt: new Date(now.getTime() + periodicSyncIntervalMs()),
    payload: { reason: "periodic" },
    mode: "keep",
  });
}

/** Watch (if a topic is configured) and seed a NULL cursor. Returns false when Gmail isn't ready. */
async function watchAndSeed(userId: string, deps: GmailApiDeps): Promise<boolean> {
  const integ = await getGoogleIntegration(userId);
  if (!gmailReady(integ)) return false;
  const cfg = gmailPushConfig();
  if (cfg) {
    const w = await gmailWatch(userId, cfg.topic, deps);
    // Only the expiry column; the cursor is touched solely through the RPC below (CAS from NULL).
    await updateGoogleIntegration(integ.id, { gmail_watch_expires_at: new Date(w.expiration).toISOString() });
    if (integ.gmail_history_id === null) await advanceGmailCursor(integ.id, w.historyId, { force: true, expected: null });
  } else if (integ.gmail_history_id === null) {
    const p = await gmailProfile(userId, deps);
    await advanceGmailCursor(integ.id, p.historyId, { force: true, expected: null });
  }
  return true;
}

/**
 * Start Gmail sync after connect: `users.watch` on the Pub/Sub topic (dev without a topic: no
 * watch, polling), cursor seeded only if NULL, renew + periodic-sync jobs scheduled.
 * No-op when Gmail isn't granted / the integration isn't active.
 * @param userId owner
 * @param deps HTTP seam (tests)
 */
export async function startGmailWatch(userId: string, deps: GmailApiDeps = {}): Promise<void> {
  if (!(await watchAndSeed(userId, deps))) return;
  const now = new Date();
  // Fresh watch → next renewal 24h out (replace any older pending renew).
  await enqueueJob({
    kind: "gmail_watch_renew",
    userId,
    dedupeKey: `gmail_watch_renew:${userId}`,
    runAt: nextRenewAt(now),
    payload: {},
    mode: "replace",
  });
  await ensurePeriodicGmailSync(userId, now);
  console.info(`[gmail] watch started user=${userId} push=${gmailPushConfig() ? "on" : "off(poll)"}`);
}

/**
 * Renew the watch (daily job body). Writes only `gmail_watch_expires_at` (+ the cursor if NULL).
 * @param userId owner
 * @param deps HTTP seam (tests)
 * @returns false when Gmail isn't ready (the renew chain should stop)
 */
export async function renewGmailWatchIfActive(userId: string, deps: GmailApiDeps = {}): Promise<boolean> {
  return watchAndSeed(userId, deps);
}

/**
 * Renew the Gmail watch (daily). Never overwrites a non-NULL history cursor.
 * @param userId owner
 */
export async function renewGmailWatch(userId: string): Promise<void> {
  await renewGmailWatchIfActive(userId);
}

/**
 * Stop Gmail sync (disconnect / revoke): best-effort `users.stop`, clear the watch expiry and the
 * cursor (history ids are per mailbox; a reconnect may be another account), cancel pending
 * renew/sync jobs.
 * @param userId owner
 * @param deps HTTP seam (tests)
 */
export async function stopGmailWatch(userId: string, deps: GmailApiDeps = {}): Promise<void> {
  const integ = await getGoogleIntegration(userId);
  if (!integ) return;
  if (integ.gmail_watch_expires_at && gmailPushConfig()) {
    try {
      await gmailStop(userId, deps);
    } catch (e) {
      // Tokens may already be revoked; the watch then lapses on its own within 7 days.
      console.warn(`[gmail] users.stop failed user=${userId}: ${e instanceof Error ? e.name : "error"}`);
    }
  }
  await updateGoogleIntegration(integ.id, { gmail_watch_expires_at: null, gmail_history_id: null });
  await cancelJobs({ userId, kinds: ["gmail_watch_renew", "gmail_history_sync"] });
}

/**
 * One history sync (V2-07 §2.9): retry leftover pending rows, then read history from the stored
 * cursor, ingest new INBOX messages and advance the cursor only after the rows are durable.
 * A 404 (cursor too old) runs the resync path. NULL cursor → seed from `getProfile` and stop.
 * @param userId owner
 * @param deps HTTP seam + job deadline
 * @returns counts and whether a follow-up is needed
 */
export async function runHistorySync(userId: string, deps: GmailSyncDeps = {}): Promise<HistorySyncResult> {
  const out: HistorySyncResult = { processed: 0, alerted: 0, resynced: false, backlog: false, skipped: false };
  const integ = await getGoogleIntegration(userId);
  if (!gmailReady(integ)) return { ...out, skipped: true };
  const now = deps.now?.() ?? new Date();

  // 1. Rows a failed / deferred run left behind (AUD-19: retry without re-inserting or re-alerting).
  const pending = await listPendingEmailItems(userId, now, PENDING_RETRY_LIMIT);
  if (pending.length > 0) {
    const r = await processEmailItems(userId, pending, deps);
    out.processed += pending.length - r.deferred;
    out.alerted += r.alerted;
    if (r.deferred > 0) out.backlog = true;
  }

  // 2. Cursor.
  const h0 = integ.gmail_history_id;
  if (h0 === null) {
    const p = await gmailProfile(userId, deps);
    await advanceGmailCursor(integ.id, p.historyId);
    return out;
  }

  const hist = await listHistory(userId, h0, deps);
  if ("notFound" in hist) {
    // 3. Resync: history expired (or the cursor is invalid).
    out.resynced = true;
    const p = await gmailProfile(userId, deps);
    const ids = await listMessageIds(userId, RESYNC_QUERY, { max: RESYNC_MAX }, deps);
    const r = await ingestMessages(userId, ids.reverse(), "resync", deps);
    out.processed += r.inserted - r.deferred;
    out.alerted += r.alerted;
    if (r.deferred > 0) out.backlog = true;
    const moved = await advanceGmailCursor(integ.id, p.historyId, { force: true, expected: h0 });
    console.info(`[gmail] resync user=${userId} inserted=${r.inserted} cursorReset=${moved}`);
    return out;
  }

  // 4. Normal path: insert-dedupe + process, then advance (monotonic) once rows are durable.
  const r = await ingestMessages(userId, hist.messageIds, "push", deps);
  out.processed += r.inserted - r.deferred;
  out.alerted += r.alerted;
  if (r.deferred > 0 || hist.truncated) out.backlog = true;
  await advanceGmailCursor(integ.id, hist.historyId);
  return out;
}
