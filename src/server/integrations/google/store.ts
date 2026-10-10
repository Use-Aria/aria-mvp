import "server-only";
// OWNER: 2.4

/**
 * Typed `integrations` row access for Google (service role; V2-07 §7.1 `store.ts`).
 *
 * Token columns hold `encryptSecret` output only; this module never decrypts. Callers that need
 * a usable access token go through `tokens.ts#getGoogleAccess`.
 */
import { db } from "@/server/db";
import type { Tables } from "@/server/db";

export type GoogleIntegration = Tables<"integrations"> & { provider: "google" };

type Row = Tables<"integrations">;

/** Columns a patch may never change (identity of the row). */
const IMMUTABLE: readonly (keyof Row)[] = ["id", "user_id", "provider", "created_at"];

/**
 * Narrow a raw row to a Google integration.
 * @param row any `integrations` row (or null)
 * @returns the row typed as Google, or null when absent or another provider
 */
export function asGoogleIntegration(row: Row | null | undefined): GoogleIntegration | null {
  if (!row || row.provider !== "google") return null;
  return { ...row, provider: "google" };
}

/**
 * The user's Google integration row (any status, including `disconnected`).
 * @param userId owner
 * @returns the row, or null
 * @throws on a DB error
 */
export async function getGoogleIntegration(userId: string): Promise<GoogleIntegration | null> {
  const { data, error } = await db()
    .from("integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  if (error) throw new Error(`getGoogleIntegration: ${error.message}`);
  return asGoogleIntegration(data);
}

/**
 * Find the integration that owns a Google account (Gmail push `emailAddress`). Only rows that are
 * not `disconnected` are considered; a unique index makes that at most one (AUD-01). Callers must
 * still check `status === "active"` before doing work.
 * @param email account email (any case; trimmed and lower-cased here)
 * @returns the row, or null
 * @throws on a DB error
 */
export async function findIntegrationByAccountEmail(email: string): Promise<GoogleIntegration | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const { data, error } = await db()
    .from("integrations")
    .select("*")
    .eq("provider", "google")
    .eq("account_email", normalized)
    .neq("status", "disconnected")
    .maybeSingle();
  if (error) throw new Error(`findIntegrationByAccountEmail: ${error.message}`);
  return asGoogleIntegration(data);
}

/**
 * Find the integration that owns a calendar watch channel (unique index on `gcal_channel_id`).
 * @param channelId `X-Goog-Channel-ID`
 * @returns the row, or null
 * @throws on a DB error
 */
export async function findIntegrationByChannelId(channelId: string): Promise<GoogleIntegration | null> {
  if (!channelId) return null;
  const { data, error } = await db()
    .from("integrations")
    .select("*")
    .eq("provider", "google")
    .eq("gcal_channel_id", channelId)
    .maybeSingle();
  if (error) throw new Error(`findIntegrationByChannelId: ${error.message}`);
  return asGoogleIntegration(data);
}

/**
 * Patch a Google integration row. `id`, `user_id`, `provider` and `created_at` are ignored.
 * @param id integrations.id
 * @param patch columns to update
 * @throws on a DB error
 */
export async function updateGoogleIntegration(id: string, patch: Partial<Tables<"integrations">>): Promise<void> {
  const clean: Partial<Row> = { ...patch };
  for (const k of IMMUTABLE) delete clean[k];
  if (Object.keys(clean).length === 0) return;
  const { error } = await db().from("integrations").update(clean).eq("id", id).eq("provider", "google");
  if (error) throw new Error(`updateGoogleIntegration: ${error.message}`);
}

/**
 * Persist refreshed tokens. Only applies while the row is still `active`, so a refresh that
 * finishes after a disconnect/revoke can't resurrect tokens.
 * @param id integrations.id
 * @param patch encrypted access token + expiry, and the rotated encrypted refresh token if any
 * @returns true when the row was updated
 * @throws on a DB error
 */
export async function saveRefreshedTokens(
  id: string,
  patch: { enc_access_token: string; token_expires_at: string; enc_refresh_token?: string },
): Promise<boolean> {
  const { data, error } = await db()
    .from("integrations")
    .update(patch)
    .eq("id", id)
    .eq("provider", "google")
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(`saveRefreshedTokens: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Mark the user's Google integration unusable and wipe its tokens (V2-07 §2.4).
 * Skips `disconnected` rows. When `expectEncRefreshToken` is given, only a row still holding that
 * exact ciphertext is changed, so a stale failure can't clobber a fresh reconnect.
 * @param userId owner
 * @param status "revoked" (invalid_grant) or "error" (admin block)
 * @param reason `status_reason` code
 * @param expectEncRefreshToken optional compare-and-set guard
 * @returns the affected row's id and `connected_at`, or null when nothing changed
 * @throws on a DB error
 */
export async function markIntegrationUnavailable(
  userId: string,
  status: "revoked" | "error",
  reason: string,
  expectEncRefreshToken?: string,
): Promise<{ id: string; connectedAt: string | null } | null> {
  let q = db()
    .from("integrations")
    .update({
      status,
      status_reason: reason,
      enc_access_token: null,
      enc_refresh_token: null,
      token_expires_at: null,
    })
    .eq("user_id", userId)
    .eq("provider", "google")
    .neq("status", "disconnected");
  if (expectEncRefreshToken !== undefined) q = q.eq("enc_refresh_token", expectEncRefreshToken);
  const { data, error } = await q.select("id, connected_at");
  if (error) throw new Error(`markIntegrationUnavailable: ${error.message}`);
  const row = data?.[0];
  return row ? { id: row.id, connectedAt: row.connected_at } : null;
}

/**
 * Atomically claim the one-time "Google stopped working" notice
 * (`UPDATE … WHERE status_notified_at IS NULL RETURNING`). Exactly one concurrent caller wins.
 * @param id integrations.id
 * @param at claim timestamp (ISO)
 * @returns true for the single winner
 * @throws on a DB error
 */
export async function claimStatusNotice(id: string, at: string): Promise<boolean> {
  const { data, error } = await db()
    .from("integrations")
    .update({ status_notified_at: at })
    .eq("id", id)
    .eq("provider", "google")
    .is("status_notified_at", null)
    .select("id");
  if (error) throw new Error(`claimStatusNotice: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Release a notice claim (only the claim made at `at`), so a failed send can be retried.
 * @param id integrations.id
 * @param at the timestamp passed to `claimStatusNotice`
 * @throws on a DB error
 */
export async function releaseStatusNotice(id: string, at: string): Promise<void> {
  const { error } = await db()
    .from("integrations")
    .update({ status_notified_at: null })
    .eq("id", id)
    .eq("provider", "google")
    .eq("status_notified_at", at);
  if (error) throw new Error(`releaseStatusNotice: ${error.message}`);
}
