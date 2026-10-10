import "server-only";
/**
 * Build-safe absolute site URL for `metadataBase` (web plan §6). OWNER: 1.6.
 * Unlike `appBaseUrl()`, this never throws, so preview builds without `APP_BASE_URL`
 * still render metadata; magic links and Origin checks keep using `appBaseUrl()`.
 */
import { optionalEnv } from "@/server/env";

/**
 * Absolute base URL: `APP_BASE_URL`, else `https://$VERCEL_PROJECT_PRODUCTION_URL`,
 * else `http://localhost:3000`. No trailing slash.
 * @returns base URL
 */
export function siteUrl(): string {
  const explicit = optionalEnv("APP_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = optionalEnv("VERCEL_PROJECT_PRODUCTION_URL");
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}
