import "server-only";
/**
 * Magic links (spec §3.6). Server-only.
 *
 * URL shape: `<APP_BASE_URL>/m[?k=week&n=3]#t=<token>`. The token lives in the
 * fragment so link-preview fetchers (Sendblue's Mac builds iMessage previews),
 * server logs, and Referer headers never see it. Only a JS POST to
 * /api/session/redeem consumes it — a GET never does.
 */
import { db } from "@/server/db";
import { appBaseUrl } from "@/server/env";
import { randomToken, sha256Hex } from "@/server/security/crypto";
import {
  DEFAULT_TARGET,
  LINK_TTL_MS,
  MINT_LIMIT_PER_HOUR,
  SCOPE_FOR_PURPOSE,
  isLinkPurpose,
  safeTarget,
  type LinkPurpose,
  type SessionScope,
} from "@/server/security/link-policy";

export interface MintInput {
  userId: string;
  purpose: LinkPurpose;
  /** Allow-listed in-app path; defaults per purpose. */
  target?: string;
  /** Non-secret aggregate for the OG preview, e.g. { kind: "week", n: 3 }. */
  preview?: { kind: "week" | "setup" | "email" | "settings"; n?: number };
}

/**
 * Mint a single-use link for a user. Returns null when the user has hit the
 * per-hour mint limit (10/hour).
 */
export async function mintMagicLink(input: MintInput): Promise<string | null> {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count, error: countError } = await db()
    .from("magic_links")
    .select("token_hash", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .gte("created_at", since);
  if (countError) throw new Error(`mintMagicLink count failed: ${countError.message}`);
  if ((count ?? 0) >= MINT_LIMIT_PER_HOUR) return null;

  const token = randomToken(24);
  const { error } = await db().from("magic_links").insert({
    token_hash: sha256Hex(token),
    user_id: input.userId,
    purpose: input.purpose,
    target: safeTarget(input.target, DEFAULT_TARGET[input.purpose]),
    expires_at: new Date(Date.now() + LINK_TTL_MS[input.purpose]).toISOString(),
  });
  if (error) throw new Error(`mintMagicLink insert failed: ${error.message}`);

  const params = new URLSearchParams();
  if (input.preview) {
    params.set("k", input.preview.kind);
    if (input.preview.n !== undefined) params.set("n", String(Math.min(99, input.preview.n)));
  }
  const qs = params.toString();
  const query = qs ? `?${qs}` : "";
  return `${appBaseUrl()}/m${query}#t=${token}`;
}

export type RedeemResult =
  | { ok: true; userId: string; scope: SessionScope; target: string }
  | { ok: false; reason: "unknown" | "expired_or_used"; userId?: string; target?: string };

/**
 * Consume a token. The UPDATE … WHERE used_at IS NULL AND expires_at > now
 * is a single atomic statement, so a token can be redeemed exactly once.
 * On failure, returns the link's owner + target (when the token exists) so the
 * caller can still route a browser that already has a session for that user.
 */
export async function redeemMagicLink(token: string): Promise<RedeemResult> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return { ok: false, reason: "unknown" };
  const tokenHash = sha256Hex(token);
  const now = new Date().toISOString();

  const { data, error } = await db()
    .from("magic_links")
    .update({ used_at: now })
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .gt("expires_at", now)
    .select("user_id, purpose, target")
    .maybeSingle();
  if (error) throw new Error(`redeemMagicLink failed: ${error.message}`);

  if (data && isLinkPurpose(data.purpose)) {
    return {
      ok: true,
      userId: data.user_id,
      scope: SCOPE_FOR_PURPOSE[data.purpose],
      target: safeTarget(data.target, DEFAULT_TARGET[data.purpose]),
    };
  }

  const { data: existing } = await db()
    .from("magic_links")
    .select("user_id, purpose, target")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!existing) return { ok: false, reason: "unknown" };
  const fallback = isLinkPurpose(existing.purpose) ? DEFAULT_TARGET[existing.purpose] : "/week";
  return {
    ok: false,
    reason: "expired_or_used",
    userId: existing.user_id,
    target: safeTarget(existing.target, fallback),
  };
}
