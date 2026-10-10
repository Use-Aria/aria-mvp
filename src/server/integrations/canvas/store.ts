import "server-only";
// OWNER: 3.4

/**
 * Canvas integration row (V2-05 §7.2 `store.ts`): the `integrations` row with
 * `provider = 'canvas_ical'`.
 *
 * - The feed URL is a bearer secret: stored only as `enc_ical_url` (AES-256-GCM `v1:`), never
 *   logged. Logs and errors carry the host and `fp8` (first 8 hex of the fingerprint) at most.
 * - `ical_url_fp` = HMAC-SHA256 of the normalized href under an HKDF subkey of
 *   `APP_ENCRYPTION_KEY` (`info = "aria/ical-url-fp/v1"`). A unique partial index makes the same
 *   feed connectable to one account only.
 * - `last_error` = last sync error CODE; `status_reason` = why the status changed (master plan C25).
 */
import { createHmac, hkdfSync } from "node:crypto";
import { db, type Tables } from "@/server/db";
import { requireEnv } from "@/server/env";
import { decryptSecret, encryptSecret, parseKey } from "@/server/security/crypto";
import type { FailureDecision } from "@/server/integrations/canvas/schedule";
import { normalizeCanvasFeedUrl, type CanvasFeedUrl } from "@/shared/canvas-url";
import { safeTimeZone } from "@/shared/time/tz";

/** `integrations.provider` value for Canvas. */
export const CANVAS_PROVIDER = "canvas_ical";
/** Default sync lease (V2-05 §2.7). */
export const SYNC_LEASE_MS = 2 * 60_000;
/** `next_sync_at` written at save time (replaced by the first successful sync). */
const CONNECT_RETRY_MS = 10 * 60_000;
const FP_INFO = "aria/ical-url-fp/v1";
const UNIQUE_VIOLATION = "23505";

/** Integration status values (003 check constraint). */
export type CanvasIntegrationStatus = "active" | "error" | "revoked" | "disconnected";

/** The Canvas integration row, camel-cased; no secrets. */
export interface CanvasIntegration {
  id: string;
  userId: string;
  status: CanvasIntegrationStatus;
  host: string | null;
  urlFp: string | null;
  nextSyncAt: Date | null;
  syncedAt: Date | null;
  consecutiveFailures: number;
  firstFailureAt: Date | null;
  lastError: string | null;
  feedHash: string | null;
  statusNotifiedAt: Date | null;
}

type Row = Tables<"integrations">;

function fail(op: string, message: string): never {
  throw new Error(`[canvas/store] ${op}: ${message}`);
}

function date(v: string | null): Date | null {
  return v === null ? null : new Date(v);
}

function statusOf(v: string): CanvasIntegrationStatus {
  return v === "error" || v === "revoked" || v === "disconnected" ? v : "active";
}

function encryptionKey(): Buffer {
  return parseKey(requireEnv("APP_ENCRYPTION_KEY"));
}

/**
 * Maps a DB row to {@link CanvasIntegration} (pure).
 * @param r integrations row
 * @returns camel-cased view without the encrypted URL
 */
export function rowToIntegration(r: Row): CanvasIntegration {
  return {
    id: r.id,
    userId: r.user_id,
    status: statusOf(r.status),
    host: r.ical_host,
    urlFp: r.ical_url_fp,
    nextSyncAt: date(r.next_sync_at),
    syncedAt: date(r.synced_at),
    consecutiveFailures: r.consecutive_failures,
    firstFailureAt: date(r.first_failure_at),
    lastError: r.last_error,
    feedHash: r.feed_hash,
    statusNotifiedAt: date(r.status_notified_at),
  };
}

/**
 * Keyed fingerprint of a normalized feed URL (dedupe across accounts, safe to log as `fp8`).
 * @param href normalized feed href (`CanvasFeedUrl.href`)
 * @param key optional 32-byte master key (default `APP_ENCRYPTION_KEY`)
 * @returns 64 hex chars
 */
export function feedUrlFingerprint(href: string, key?: Buffer): string {
  const sub = Buffer.from(hkdfSync("sha256", key ?? encryptionKey(), Buffer.alloc(0), FP_INFO, 32));
  return createHmac("sha256", sub).update(href, "utf8").digest("hex");
}

/**
 * The Canvas integration of a user.
 * @param userId owner
 * @returns the row (any status), or null when none exists
 */
export async function getCanvasIntegration(userId: string): Promise<CanvasIntegration | null> {
  const { data, error } = await db()
    .from("integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER)
    .maybeSingle();
  if (error) fail("getCanvasIntegration", error.message);
  return data ? rowToIntegration(data) : null;
}

/**
 * Decrypts and re-normalizes the stored feed URL. Never log the result.
 * @param userId owner
 * @returns the normalized URL, or null when there is no row, no URL, or it can't be decrypted
 */
export async function readFeedUrl(userId: string): Promise<CanvasFeedUrl | null> {
  const { data, error } = await db()
    .from("integrations")
    .select("enc_ical_url")
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER)
    .maybeSingle();
  if (error) fail("readFeedUrl", error.message);
  if (!data?.enc_ical_url) return null;
  let href: string;
  try {
    href = decryptSecret(data.enc_ical_url, encryptionKey());
  } catch {
    console.error("[canvas/store] readFeedUrl: stored feed URL could not be decrypted");
    return null;
  }
  const n = normalizeCanvasFeedUrl(href);
  return n.ok ? n.url : null;
}

/**
 * Upserts the `canvas_ical` row: encrypted URL, host, fingerprint; resets failure, notice and
 * sync state; status `active`. When the URL changed, `synced_at`/`feed_hash` are cleared so the
 * next sync is the "initial" one (V2-05 §2.4).
 * @param userId owner
 * @param url normalized feed URL
 * @param now clock (default now)
 * @returns `urlChanged` (no previous row, or a different fingerprint), or `already_connected_elsewhere`
 */
export async function saveCanvasIntegration(
  userId: string,
  url: CanvasFeedUrl,
  now: Date = new Date(),
): Promise<{ ok: true; urlChanged: boolean } | { ok: false; code: "already_connected_elsewhere" }> {
  const key = encryptionKey();
  const fp = feedUrlFingerprint(url.href, key);
  const prev = await getCanvasIntegration(userId);
  const urlChanged = !prev || prev.urlFp !== fp || prev.status === "disconnected";
  const row = {
    user_id: userId,
    provider: CANVAS_PROVIDER,
    enc_ical_url: encryptSecret(url.href, key),
    ical_host: url.host,
    ical_url_fp: fp,
    status: "active",
    status_reason: null,
    status_notified_at: null,
    consecutive_failures: 0,
    first_failure_at: null,
    last_error: null,
    last_error_at: null,
    connected_at: now.toISOString(),
    // Safety net: if the connect's own initial sync fails, the 5-min cron picks the row up.
    next_sync_at: new Date(now.getTime() + CONNECT_RETRY_MS).toISOString(),
    ...(urlChanged ? { synced_at: null, feed_hash: null } : {}),
  };
  const { error } = await db().from("integrations").upsert(row, { onConflict: "user_id,provider" });
  if (error) {
    // (user_id, provider) is the ON CONFLICT target, so the only other unique index that can
    // fire is `integrations_ical_url_fp_key`: the same feed on another account.
    if (error.code === UNIQUE_VIOLATION) return { ok: false, code: "already_connected_elsewhere" };
    fail("saveCanvasIntegration", error.message);
  }
  return { ok: true, urlChanged };
}

/**
 * Claims the per-user sync lease (conditional UPDATE), so connect and a scheduled sync never overlap.
 * @param userId owner
 * @param ms lease length (default 2 min)
 * @returns true when this caller now holds the lease
 */
export async function claimSyncLease(userId: string, ms: number = SYNC_LEASE_MS): Promise<boolean> {
  const now = new Date();
  const { data, error } = await db()
    .from("integrations")
    .update({ sync_lease_until: new Date(now.getTime() + ms).toISOString() })
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER)
    .or(`sync_lease_until.is.null,sync_lease_until.lt.${now.toISOString()}`)
    .select("id");
  if (error) fail("claimSyncLease", error.message);
  return (data?.length ?? 0) > 0;
}

/**
 * Releases the sync lease (idempotent).
 * @param userId owner
 */
export async function releaseSyncLease(userId: string): Promise<void> {
  const { error } = await db()
    .from("integrations")
    .update({ sync_lease_until: null })
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER);
  if (error) fail("releaseSyncLease", error.message);
}

/**
 * Records a successful sync: status active, failure streak and notice cleared, next sync scheduled.
 * @param userId owner
 * @param p.feedHash sha256(body ‖ tz)
 * @param p.nextSyncAt next scheduled sync
 * @param p.lastError `"removal_deferred"` when the mass-removal guard held removals back, else null
 * @param p.now clock (default now) for `synced_at`
 */
export async function recordSyncSuccess(
  userId: string,
  p: { feedHash: string; nextSyncAt: Date; lastError: "removal_deferred" | null; now?: Date },
): Promise<void> {
  const now = p.now ?? new Date();
  const { error } = await db()
    .from("integrations")
    .update({
      status: "active",
      status_reason: null,
      status_notified_at: null,
      synced_at: now.toISOString(),
      next_sync_at: p.nextSyncAt.toISOString(),
      feed_hash: p.feedHash,
      consecutive_failures: 0,
      first_failure_at: null,
      last_error: p.lastError,
      last_error_at: p.lastError ? now.toISOString() : null,
    })
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER)
    .neq("status", "disconnected");
  if (error) fail("recordSyncSuccess", error.message);
}

/**
 * Integration patch for a failed sync (pure).
 * @param prev current row state
 * @param p.code error code (stored in `last_error`)
 * @param p.decision outcome of `decideAfterFailure`
 * @param p.now clock
 * @returns the column update: streak +1, streak start kept, error code/time, and the decision's
 *   status / next sync (`revoke` → `revoked` + no next sync; `error_notify` → `error`)
 */
export function failurePatch(
  prev: Pick<CanvasIntegration, "consecutiveFailures" | "firstFailureAt" | "status">,
  p: { code: string; decision: FailureDecision; now: Date },
): {
  consecutive_failures: number;
  first_failure_at: string;
  last_error: string;
  last_error_at: string;
  next_sync_at: string | null;
  status: CanvasIntegrationStatus;
  status_reason?: string;
} {
  const base = {
    consecutive_failures: prev.consecutiveFailures + 1,
    first_failure_at: (prev.firstFailureAt ?? p.now).toISOString(),
    last_error: p.code,
    last_error_at: p.now.toISOString(),
  };
  switch (p.decision.action) {
    case "revoke":
      return { ...base, next_sync_at: null, status: "revoked", status_reason: p.code };
    case "error_notify":
      return { ...base, next_sync_at: p.decision.at.toISOString(), status: "error", status_reason: p.code };
    default:
      return { ...base, next_sync_at: p.decision.at.toISOString(), status: prev.status === "error" ? "error" : "active" };
  }
}

/**
 * Records a failed sync per {@link failurePatch}.
 * @param userId owner
 * @param p.code error code (`FeedFetchErrorCode` or `parse_error` / `not_canvas`)
 * @param p.decision outcome of `decideAfterFailure`
 * @param p.now clock
 * @param p.prev the row as read at the start of this sync (avoids a re-read)
 */
export async function recordSyncFailure(
  userId: string,
  p: { code: string; decision: FailureDecision; now: Date; prev?: CanvasIntegration | null },
): Promise<void> {
  const prev = p.prev ?? (await getCanvasIntegration(userId));
  if (!prev) return;
  const { error } = await db()
    .from("integrations")
    .update(failurePatch(prev, p))
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER)
    .neq("status", "disconnected");
  if (error) fail("recordSyncFailure", error.message);
}

/**
 * Moves the next scheduled sync without touching sync state (kill-switch path).
 * @param userId owner
 * @param at next `next_sync_at`
 */
export async function setNextSyncAt(userId: string, at: Date): Promise<void> {
  const { error } = await db()
    .from("integrations")
    .update({ next_sync_at: at.toISOString() })
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER)
    .in("status", ["active", "error"]);
  if (error) fail("setNextSyncAt", error.message);
}

/**
 * Claims the one-time "Canvas broke" notice (sets `status_notified_at` only if unset).
 * @param userId owner
 * @returns true when this caller should send the notice
 */
export async function markStatusNotified(userId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("integrations")
    .update({ status_notified_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("provider", CANVAS_PROVIDER)
    .is("status_notified_at", null)
    .select("id");
  if (error) fail("markStatusNotified", error.message);
  return (data?.length ?? 0) > 0;
}

/**
 * Deletes the Canvas integration row (disconnect). Idempotent.
 * @param userId owner
 */
export async function deleteCanvasIntegration(userId: string): Promise<void> {
  const { error } = await db().from("integrations").delete().eq("user_id", userId).eq("provider", CANVAS_PROVIDER);
  if (error) fail("deleteCanvasIntegration", error.message);
}

/**
 * The user's IANA zone (validated; default America/New_York) for date-only Canvas items.
 * @param userId owner
 * @returns a zone safe for tz.ts
 */
export async function readUserTimezone(userId: string): Promise<string> {
  const { data, error } = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
  if (error) fail("readUserTimezone", error.message);
  return safeTimeZone(data?.timezone);
}
