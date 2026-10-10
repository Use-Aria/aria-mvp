import "server-only";
// OWNER: 2.4

/**
 * Google OAuth scopes, endpoints and env access (V2-07 §2.1, §6.1, §7.1 `config.ts`).
 *
 * `featuresFor`, `normalizeScopes` and `missingRequiredScopes` are pure. The env getters read
 * `process.env` on every call (no caching), so tests can set variables per case.
 */
import { appBaseUrl, optionalEnv, requireEnv } from "@/server/env";
import type { GoogleFeature } from "@/server/integrations/google";

export type { GoogleFeature } from "@/server/integrations/google";

/** Every scope Aria may request (V2-07 §2.1). */
export const SCOPES = {
  openid: "openid",
  email: "email",
  calEventsRead: "https://www.googleapis.com/auth/calendar.events.readonly",
  calList: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  calAppCreated: "https://www.googleapis.com/auth/calendar.app.created",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
} as const;

/** The full request, in a stable order (V2-07 §2.1 "Final request"). */
export const REQUESTED_SCOPES: readonly string[] = [
  SCOPES.openid,
  SCOPES.email,
  SCOPES.calEventsRead,
  SCOPES.calList,
  SCOPES.calAppCreated,
  SCOPES.gmailRead,
  SCOPES.gmailSend,
];

/** Without these the connect is refused ("Aria needs at least calendar read access"). */
export const REQUIRED_SCOPES: readonly string[] = [SCOPES.openid, SCOPES.email, SCOPES.calEventsRead];

/** Google endpoints (V2-07 §2.2–§2.4, F16). */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

/** Google returns the long form of the identity scopes in the token response `scope` string. */
const SCOPE_ALIASES: Readonly<Record<string, string>> = {
  "https://www.googleapis.com/auth/userinfo.email": SCOPES.email,
};

/** Stable feature order for arrays built from `featuresFor`. */
export const FEATURE_ORDER: readonly GoogleFeature[] = ["calendar_read", "calendar_write", "gmail_read", "gmail_send"];

/**
 * Parse a granted-scope list (a space-separated `scope` string or an array) into short canonical
 * names: `userinfo.email` → `email`, duplicates and blanks removed, order preserved. Pure.
 * @param granted the token response `scope` string, or a stored `integrations.scopes` array
 * @returns canonical scope list
 */
export function normalizeScopes(granted: string | readonly string[] | null | undefined): string[] {
  const raw = typeof granted === "string" ? granted.split(/\s+/) : (granted ?? []);
  const out: string[] = [];
  for (const s of raw) {
    const t = s.trim();
    if (!t) continue;
    const canon = SCOPE_ALIASES[t] ?? t;
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

/**
 * Which required scopes are missing from a granted list. Pure.
 * @param granted granted scopes (string or array; aliases accepted)
 * @returns the missing entries of `REQUIRED_SCOPES` (empty when the connect may proceed)
 */
export function missingRequiredScopes(granted: string | readonly string[] | null | undefined): string[] {
  const have = new Set(normalizeScopes(granted));
  return REQUIRED_SCOPES.filter((s) => !have.has(s));
}

/**
 * Which features a granted scope list enables (V2-07 §2.1 granular consent). Pure.
 * - `calendar_read` ← `calendar.events.readonly`
 * - `calendar_write` ← `calendar.app.created` (Aria calendar only)
 * - `gmail_read` ← `gmail.readonly`
 * - `gmail_send` ← `gmail.send`
 * @param scopes granted scopes (aliases accepted)
 * @returns the enabled features
 */
export function featuresFor(scopes: readonly string[]): Set<GoogleFeature> {
  const have = new Set(normalizeScopes(scopes));
  const out = new Set<GoogleFeature>();
  if (have.has(SCOPES.calEventsRead)) out.add("calendar_read");
  if (have.has(SCOPES.calAppCreated)) out.add("calendar_write");
  if (have.has(SCOPES.gmailRead)) out.add("gmail_read");
  if (have.has(SCOPES.gmailSend)) out.add("gmail_send");
  return out;
}

/**
 * `featuresFor` as an array in `FEATURE_ORDER` (for JSON / status views). Pure.
 * @param scopes granted scopes
 * @returns ordered features
 */
export function featureList(scopes: readonly string[]): GoogleFeature[] {
  const set = featuresFor(scopes);
  return FEATURE_ORDER.filter((f) => set.has(f));
}

/**
 * The OAuth redirect URI: `GOOGLE_REDIRECT_URI` if set (must equal a Console-registered URI),
 * else `appBaseUrl() + "/api/google/callback"`. Never derived from the request Host.
 * @returns absolute redirect URI
 */
export function googleRedirectUri(): string {
  return optionalEnv("GOOGLE_REDIRECT_URI") ?? `${appBaseUrl()}/api/google/callback`;
}

/**
 * OAuth client credentials.
 * @returns client id and secret
 * @throws when `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is unset
 */
export function googleClient(): { clientId: string; clientSecret: string } {
  return { clientId: requireEnv("GOOGLE_CLIENT_ID"), clientSecret: requireEnv("GOOGLE_CLIENT_SECRET") };
}

/**
 * Gmail Pub/Sub push settings, or null when `GMAIL_PUBSUB_TOPIC` is unset (dev → polling).
 * @returns topic, push service-account email, expected JWT audience, optional subscription
 * @throws when the topic is set but `GMAIL_PUSH_SERVICE_ACCOUNT` is missing (misconfiguration)
 */
export function gmailPushConfig(): { topic: string; serviceAccount: string; audience: string; subscription?: string } | null {
  const topic = optionalEnv("GMAIL_PUBSUB_TOPIC");
  if (!topic) return null;
  const serviceAccount = requireEnv("GMAIL_PUSH_SERVICE_ACCOUNT");
  const audience = optionalEnv("GMAIL_PUSH_AUDIENCE") ?? `${appBaseUrl()}/api/google/gmail-push`;
  const subscription = optionalEnv("GMAIL_PUSH_SUBSCRIPTION");
  return subscription ? { topic, serviceAccount, audience, subscription } : { topic, serviceAccount, audience };
}

/**
 * Whether to send PKCE (S256) on the authorization request. `GOOGLE_PKCE=off` is the escape hatch
 * if Google rejects PKCE for Web-application clients (V2-07 §2.3, F18 [verify]).
 * @returns true unless `GOOGLE_PKCE` is "off"
 */
export function pkceEnabled(): boolean {
  return (optionalEnv("GOOGLE_PKCE") ?? "on").trim().toLowerCase() !== "off";
}
