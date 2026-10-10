/**
 * Test fakes for the Google token layer: an in-memory `GoogleTokenStore` and a scripted
 * `fetch` that answers by URL (the HTTP boundary is the only mock seam).
 */
import { encryptSecret } from "@/server/security/crypto";
import type { GoogleIntegration } from "@/server/integrations/google/store";
import type { GoogleTokenStore } from "@/server/integrations/google/tokens";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * A full Google integrations row with sensible defaults.
 * @param key encryption key for the token columns
 * @param over column overrides; `access`/`refresh` are plaintext tokens to encrypt
 * @returns row
 */
export function googleRow(
  key: Buffer,
  over: Partial<GoogleIntegration> & { access?: string | null; refresh?: string | null; expiresInMs?: number; now?: Date } = {},
): GoogleIntegration {
  const { access = "at-old", refresh = "rt-1", expiresInMs = 3600_000, now = new Date(), ...cols } = over;
  return {
    id: "int-1",
    user_id: "user-1",
    provider: "google",
    account_email: "student@example.edu",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    enc_access_token: access === null ? null : encryptSecret(access, key),
    enc_refresh_token: refresh === null ? null : encryptSecret(refresh, key),
    token_expires_at: new Date(now.getTime() + expiresInMs).toISOString(),
    status: "active",
    status_reason: null,
    status_notified_at: null,
    connected_at: "2026-10-01T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    consecutive_failures: 0,
    enc_ical_url: null,
    feed_hash: null,
    first_failure_at: null,
    gcal_aria_calendar_id: null,
    gcal_calendar_ids: [],
    gcal_channel_id: null,
    gcal_channel_token_hash: null,
    gcal_resource_id: null,
    gcal_watch_expires_at: null,
    gmail_history_id: null,
    gmail_synced_at: null,
    gmail_triage: null,
    gmail_watch_expires_at: null,
    ical_host: null,
    ical_url_fp: null,
    last_error: null,
    last_error_at: null,
    next_sync_at: null,
    sync_lease_until: null,
    synced_at: null,
    ...cols,
  };
}

/** In-memory store holding one row; records every save. */
export class MemoryStore implements GoogleTokenStore {
  saves: { id: string; patch: Record<string, string> }[] = [];
  constructor(public row: GoogleIntegration | null) {}

  async load(userId: string): Promise<GoogleIntegration | null> {
    return this.row && this.row.user_id === userId ? { ...this.row } : null;
  }

  async saveRefreshed(id: string, patch: { enc_access_token: string; token_expires_at: string; enc_refresh_token?: string }): Promise<boolean> {
    this.saves.push({ id, patch: { ...patch } });
    if (!this.row || this.row.id !== id || this.row.status !== "active") return false;
    this.row = { ...this.row, ...patch };
    return true;
  }
}

/** One recorded request. */
export interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string | null;
}

type Responder = (call: Call) => Response | Promise<Response>;

/**
 * Scripted fetch: each URL prefix has a queue of responders; the last one repeats.
 * @param routes prefix → responders
 * @returns the fetch function and the recorded calls
 */
export function scriptedFetch(routes: Record<string, Responder[]>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const prefix = [...queues.keys()].find((p) => url.startsWith(p));
    if (!prefix) throw new Error(`unscripted fetch: ${url}`);
    const q = queues.get(prefix) as Responder[];
    const r = q.length > 1 ? (q.shift() as Responder) : (q[0] as Responder);
    return r(call);
  };
  return { fetch: f, calls };
}

/**
 * JSON response helper.
 * @param status HTTP status
 * @param body JSON body
 * @param headers extra headers
 * @returns Response
 */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A successful token-endpoint response. */
export function tokenOk(access: string, extra: Record<string, unknown> = {}): Response {
  return json(200, { access_token: access, expires_in: 3599, scope: "openid", token_type: "Bearer", ...extra });
}

/** Google API error envelope. */
export function apiError(status: number, reason: string): Response {
  return json(status, { error: { code: status, message: "x", status: reason.toUpperCase(), errors: [{ reason, domain: "global" }] } });
}
