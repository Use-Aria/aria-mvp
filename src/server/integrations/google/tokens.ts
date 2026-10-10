import "server-only";
// OWNER: 2.4

/**
 * Google access tokens (V2-07 §2.4, §7.1 `tokens.ts`; fixes AUD-20).
 *
 * - Refresh 5 minutes before expiry; persist the new access token, expiry, and the rotated
 *   refresh token when Google returns one (encrypted, AES-256-GCM).
 * - **Per-user refresh lock:** concurrent callers in one process share a single in-flight
 *   refresh (no thundering herd on the token endpoint). Across processes, every refresh first
 *   re-reads the row and reuses a token another instance already refreshed.
 * - `invalid_grant` / `admin_policy_enforced` → `markGoogleUnavailable` (once), then the
 *   `GoogleAuthRevokedError` propagates. A refresh token rotated by another instance in the
 *   meantime is retried once instead of being treated as a revocation.
 *
 * Tokens never enter logs, errors, job payloads or Redis.
 */
import { requireEnv } from "@/server/env";
import { decryptSecret, encryptSecret, parseKey } from "@/server/security/crypto";
import type { GoogleFeature } from "@/server/integrations/google";
import { featuresFor } from "@/server/integrations/google/config";
import { GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { refreshAccessToken } from "@/server/integrations/google/oauth/flow";
import {
  claimStatusNotice,
  getGoogleIntegration,
  markIntegrationUnavailable,
  releaseStatusNotice,
  saveRefreshedTokens,
  type GoogleIntegration,
} from "@/server/integrations/google/store";

/** Refresh when the access token expires within this window. */
export const REFRESH_SKEW_MS = 5 * 60_000;

/** Row access the token manager needs (the real one is `store.ts`; tests pass an in-memory fake). */
export interface GoogleTokenStore {
  load(userId: string): Promise<GoogleIntegration | null>;
  saveRefreshed(id: string, patch: { enc_access_token: string; token_expires_at: string; enc_refresh_token?: string }): Promise<boolean>;
}

/** Injectable dependencies (all optional; production uses the defaults). */
export interface GoogleTokenDeps {
  store?: GoogleTokenStore;
  /** Fetch for the token endpoint (the HTTP boundary). */
  fetch?: typeof fetch;
  now?: () => Date;
  /** 32-byte encryption key (default: `APP_ENCRYPTION_KEY`). */
  key?: Buffer;
  /** Called once when the refresh token is dead (default: `markGoogleUnavailable`). */
  onUnavailable?: (userId: string, why: GoogleAuthRevokedError["kind"], expectEncRefreshToken: string) => Promise<void>;
}

const defaultStore: GoogleTokenStore = { load: getGoogleIntegration, saveRefreshed: saveRefreshedTokens };

/** `force`: refresh even if the stored token looks fresh; `stale`: the token that got a 401. */
interface RefreshMode {
  force: boolean;
  stale: string | null;
}

/** In-flight refreshes, keyed by user id (single-flight per process). */
const inflight = new Map<string, Promise<{ accessToken: string; integration: GoogleIntegration }>>();

interface Resolved {
  store: GoogleTokenStore;
  fetch: typeof fetch | undefined;
  now: () => Date;
  key: Buffer;
  onUnavailable: NonNullable<GoogleTokenDeps["onUnavailable"]>;
}

function resolve(d: GoogleTokenDeps | undefined): Resolved {
  return {
    store: d?.store ?? defaultStore,
    fetch: d?.fetch,
    now: d?.now ?? (() => new Date()),
    key: d?.key ?? parseKey(requireEnv("APP_ENCRYPTION_KEY")),
    onUnavailable: d?.onUnavailable ?? ((userId, why, enc) => markGoogleUnavailable(userId, why, { expectEncRefreshToken: enc })),
  };
}

function usable(row: GoogleIntegration | null, require?: GoogleFeature): GoogleIntegration {
  if (!row || row.status !== "active" || !row.enc_refresh_token) throw new GoogleNotConnectedError(require);
  if (require && !featuresFor(row.scopes ?? []).has(require)) throw new GoogleNotConnectedError(require);
  return row;
}

function freshAccess(row: GoogleIntegration, d: Resolved): string | null {
  if (!row.enc_access_token || !row.token_expires_at) return null;
  if (new Date(row.token_expires_at).getTime() <= d.now().getTime() + REFRESH_SKEW_MS) return null;
  try {
    return decryptSecret(row.enc_access_token, d.key);
  } catch {
    return null; // undecryptable (key rotated / corrupted) → refresh
  }
}

/**
 * A valid access token for the user. Refreshes when it expires within 5 minutes (or when
 * `forceRefresh`, e.g. after a 401) and persists the result.
 * @param userId owner
 * @param opts `forceRefresh`; `staleAccessToken` = the token that just got a 401 (lets a joined or
 *   cross-instance refresh be reused); `require` = feature whose scope must be granted; `deps` (tests)
 * @returns the decrypted access token and the (updated) row
 * @throws GoogleNotConnectedError (no active row / missing scope), GoogleAuthRevokedError, GoogleApiError
 */
export async function getGoogleAccess(
  userId: string,
  opts?: { forceRefresh?: boolean; require?: GoogleFeature; staleAccessToken?: string; deps?: GoogleTokenDeps },
): Promise<{ accessToken: string; integration: GoogleIntegration }> {
  const d = resolve(opts?.deps);
  const row = usable(await d.store.load(userId), opts?.require);
  if (!opts?.forceRefresh) {
    const token = freshAccess(row, d);
    if (token) return { accessToken: token, integration: row };
  }

  // Single flight: join a refresh already running for this user in this process.
  let p = inflight.get(userId);
  if (!p) {
    const mode: RefreshMode = { force: opts?.forceRefresh === true, stale: opts?.staleAccessToken ?? null };
    p = refreshFor(userId, d, mode).finally(() => inflight.delete(userId));
    inflight.set(userId, p);
  }
  const out = await p;
  return { accessToken: out.accessToken, integration: usable(out.integration, opts?.require) };
}

/**
 * Refresh under the per-user lock. Re-reads the row first so a refresh made by another instance
 * (or one that finished just before the lock) is reused.
 */
async function refreshFor(
  userId: string,
  d: Resolved,
  mode: RefreshMode,
): Promise<{ accessToken: string; integration: GoogleIntegration }> {
  const stale = mode.stale;
  let row = usable(await d.store.load(userId));
  const current = freshAccess(row, d);
  // Not forced: anything fresh will do. Forced after a 401: only a token other than the rejected
  // one. Forced without a stale token: always refresh.
  if (current && (!mode.force || (stale !== null && current !== stale))) {
    return { accessToken: current, integration: row };
  }

  for (let attempt = 0; ; attempt++) {
    const encRefresh = row.enc_refresh_token as string;
    let refreshToken: string;
    try {
      refreshToken = decryptSecret(encRefresh, d.key);
    } catch {
      throw new GoogleNotConnectedError(undefined, "google refresh token unreadable");
    }
    try {
      const t = await refreshAccessToken(refreshToken, d.fetch);
      const patch: { enc_access_token: string; token_expires_at: string; enc_refresh_token?: string } = {
        enc_access_token: encryptSecret(t.access_token, d.key),
        token_expires_at: new Date(d.now().getTime() + t.expires_in * 1000).toISOString(),
      };
      if (t.refresh_token && t.refresh_token !== refreshToken) patch.enc_refresh_token = encryptSecret(t.refresh_token, d.key);
      const saved = await d.store.saveRefreshed(row.id, patch);
      if (!saved) throw new GoogleNotConnectedError(undefined, "google integration changed during refresh");
      return { accessToken: t.access_token, integration: { ...row, ...patch } };
    } catch (err) {
      if (!(err instanceof GoogleAuthRevokedError)) throw err;
      // Another instance may have rotated the refresh token while we used the old one.
      const latest = await d.store.load(userId);
      if (
        attempt === 0 &&
        latest &&
        latest.status === "active" &&
        latest.enc_refresh_token &&
        latest.enc_refresh_token !== encRefresh
      ) {
        row = latest;
        const reuse = freshAccess(row, d);
        if (reuse && reuse !== stale) return { accessToken: reuse, integration: row };
        continue;
      }
      try {
        await d.onUnavailable(userId, err.kind, encRefresh);
      } catch (markErr) {
        console.error("[google] markGoogleUnavailable failed:", markErr instanceof Error ? markErr.name : "unknown");
      }
      throw err;
    }
  }
}

/** Google job kinds cancelled when the integration becomes unusable. */
const GOOGLE_JOB_KINDS = [
  "google_post_connect",
  "gcal_sync",
  "gcal_watch_renew",
  "gmail_watch_renew",
  "gmail_history_sync",
  "gmail_triage_chunk",
] as const;

/** One-time notice texts (templates, register-neutral; friend-protection 3: offer, never send, a link). */
export const GOOGLE_UNAVAILABLE_NOTICE: Readonly<Record<GoogleAuthRevokedError["kind"], readonly string[]>> = {
  invalid_grant: [
    "heads up: my google access was removed or expired, so i can't see your calendar or email anymore",
    "want a link to reconnect? just say the word",
  ],
  admin_policy_enforced: [
    "heads up: your school's google admin blocked aria, so i can't see that calendar or email",
    "a personal gmail works if you want. just ask and i'll send a link",
  ],
};

/**
 * Mark the user's Google integration unusable, wipe its tokens, cancel pending Google jobs, and
 * send the one-time notice (V2-07 §2.4). Idempotent: concurrent or repeated calls send at most
 * one notice per connection (atomic `status_notified_at` claim + `deliver` dedupe key).
 * @param userId owner
 * @param why `invalid_grant` → status `revoked`; `admin_policy_enforced` → status `error` / `admin_blocked`
 * @param opts `expectEncRefreshToken`: only act if the row still holds this refresh-token
 *   ciphertext (so a stale failure can't clobber a fresh reconnect)
 * @throws on a DB error, or when `deliver` throws (the claim is released first so a retry can send)
 */
export async function markGoogleUnavailable(
  userId: string,
  why: "invalid_grant" | "admin_policy_enforced",
  opts?: { expectEncRefreshToken?: string },
): Promise<void> {
  const status = why === "invalid_grant" ? "revoked" : "error";
  const reason = why === "invalid_grant" ? "invalid_grant" : "admin_blocked";
  const row = await markIntegrationUnavailable(userId, status, reason, opts?.expectEncRefreshToken);
  if (!row) return;

  // Lazy imports keep the token layer free of the jobs/channels module graph at load time.
  try {
    const { cancelJobs } = await import("@/server/jobs/enqueue");
    await cancelJobs({ userId, kinds: [...GOOGLE_JOB_KINDS] });
  } catch (err) {
    console.error("[google] cancel jobs after revoke failed:", err instanceof Error ? err.message : "unknown");
  }

  const claimedAt = new Date().toISOString();
  if (!(await claimStatusNotice(row.id, claimedAt))) return;

  const connectedMs = row.connectedAt ? new Date(row.connectedAt).getTime() : 0;
  try {
    const [{ deliver }, { textPlan }] = await Promise.all([import("@/server/channels/deliver"), import("@/server/channels/plan")]);
    const res = await deliver(userId, textPlan([...GOOGLE_UNAVAILABLE_NOTICE[why]]), {
      proactive: true,
      reason: "google_revoked",
      dedupeKey: `google_unavailable:${row.id}:${connectedMs}`,
    });
    if (res.status === "failed") console.error("[google] unavailable notice failed:", res.error);
  } catch (err) {
    await releaseStatusNotice(row.id, claimedAt).catch(() => undefined);
    throw err;
  }
}
