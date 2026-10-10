import "server-only";
/**
 * Fixed-window rate limiting on Upstash Redis (spec §3.6 abuse controls).
 * Server-only.
 *
 * Without Upstash configured, dev allows everything and production fails
 * closed (denies) so a missing env var can't silently remove the limit.
 */
import { Redis } from "@upstash/redis";
import { isProduction, optionalEnv } from "@/server/env";

let redis: Redis | null | undefined;

function client(): Redis | null {
  if (redis === undefined) {
    const url = optionalEnv("UPSTASH_REDIS_REST_URL");
    const token = optionalEnv("UPSTASH_REDIS_REST_TOKEN");
    redis = url && token ? new Redis({ url, token }) : null;
  }
  return redis;
}

/**
 * Count one hit for `key` in a window of `windowSec` seconds.
 * Returns true if the caller is still within `limit`.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const r = client();
  if (!r) return !isProduction;
  const bucket = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  try {
    const hits = await r.incr(bucket);
    if (hits === 1) await r.expire(bucket, windowSec);
    return hits <= limit;
  } catch (err) {
    console.error("[ratelimit] redis error:", err);
    return !isProduction;
  }
}

/** Best-effort client IP from Vercel's forwarding headers. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
