import "server-only";
/**
 * Typed access to server-side environment variables.
 * Throws on a missing required var so misconfiguration fails loudly at the
 * call site instead of producing `undefined` URLs or unsigned requests.
 */

/** Return the env var or throw if it is missing/empty. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Return the env var, or undefined when unset/empty. */
export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const isProduction = process.env.NODE_ENV === "production";

/**
 * Public base URL of the app (magic links, OAuth redirects, Origin checks).
 * Never derived from the request Host header. Falls back to localhost in dev.
 */
export function appBaseUrl(): string {
  const url = optionalEnv("APP_BASE_URL");
  if (url) return url.replace(/\/+$/, "");
  if (isProduction) throw new Error("Missing required env var: APP_BASE_URL");
  return "http://localhost:3000";
}

/** Origin (scheme + host + port) of APP_BASE_URL, for Origin-header checks. */
export function appOrigin(): string {
  return new URL(appBaseUrl()).origin;
}
