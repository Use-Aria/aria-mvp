import "server-only";
// OWNER: 2.1

/**
 * Per-user conversation run lease (V2-03 §2.2).
 *
 * - **Upstash** (production): `SET lease:<userId> <owner> NX PX ttl`; extend and release are Lua
 *   compare-and-`PEXPIRE` / compare-and-`DEL`, so only the owner can touch its lease and mutual
 *   exclusion never depends on read consistency.
 * - **DB fallback** (local/dev, no Upstash): `acquire_user_lease` RPC on `user_runtime`
 *   (same call extends for the owner); release is an owner-filtered UPDATE.
 *
 * The backend is chosen statically from the environment and never mixed at runtime. Production
 * without Upstash throws (the run fails closed and its job is retried).
 */
import { Redis } from "@upstash/redis";
import { db, type Db } from "@/server/db";
import { isProduction, optionalEnv } from "@/server/env";

/** Lease storage (one lease per user; `owner` is a random UUID per run). */
export interface LeaseStore {
  /** Take the lease if free or expired. @returns true when acquired (re-acquiring a lease the
   *  caller already holds is backend-specific; use `extend`). */
  acquire(userId: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Push the expiry out, only while `owner` still holds it. @returns false when lost */
  extend(userId: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Drop the lease, only if `owner` holds it (no-op otherwise). */
  release(userId: string, owner: string): Promise<void>;
  /** Whether any run currently holds the user's lease. */
  isHeld(userId: string): Promise<boolean>;
}

/** The subset of the Upstash client the Redis lease store uses (fakeable in tests). */
export interface LeaseRedis {
  set(key: string, value: string, opts: { nx: true; px: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  exists(key: string): Promise<number>;
}

/** Redis key of a user's lease. */
export function leaseKey(userId: string): string {
  return `lease:${userId}`;
}

/** Lua: extend only when the caller owns the key. ARGV = [owner, ttlMs]. Returns 1 or 0. */
export const EXTEND_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
/** Lua: delete only when the caller owns the key. ARGV = [owner]. Returns 1 or 0. */
export const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

function ttl(ms: number): number {
  return Math.max(1, Math.round(ms));
}

/**
 * Lease store on Upstash Redis.
 * @param redis Upstash client (or a fake with the same three commands)
 * @returns the store
 */
export function createRedisLeaseStore(redis: LeaseRedis): LeaseStore {
  return {
    async acquire(userId, owner, ttlMs) {
      const r = await redis.set(leaseKey(userId), owner, { nx: true, px: ttl(ttlMs) });
      return r === "OK";
    },
    async extend(userId, owner, ttlMs) {
      const r = await redis.eval(EXTEND_SCRIPT, [leaseKey(userId)], [owner, String(ttl(ttlMs))]);
      return Number(r) === 1;
    },
    async release(userId, owner) {
      await redis.eval(RELEASE_SCRIPT, [leaseKey(userId)], [owner]);
    },
    async isHeld(userId) {
      return (await redis.exists(leaseKey(userId))) > 0;
    },
  };
}

/**
 * Lease store on Postgres (`user_runtime.lease_until` / `lease_owner`). The user row must exist.
 * @param client service-role client (default `db()`)
 * @returns the store
 */
export function createDbLeaseStore(client: Db = db()): LeaseStore {
  const acquire = async (userId: string, owner: string, ttlMs: number): Promise<boolean> => {
    const { data, error } = await client.rpc("acquire_user_lease", {
      p_user_id: userId,
      p_owner: owner,
      p_ttl_ms: ttl(ttlMs),
    });
    if (error) throw new Error(`acquire_user_lease: ${error.message}`);
    return data === true;
  };
  return {
    acquire,
    // Same RPC: the owner may re-acquire (extend). If the lease expired and nobody else took it,
    // that re-takes it, which keeps exclusivity.
    extend: acquire,
    async release(userId, owner) {
      const { error } = await client
        .from("user_runtime")
        .update({ lease_until: null, lease_owner: null })
        .eq("user_id", userId)
        .eq("lease_owner", owner);
      if (error) throw new Error(`release lease: ${error.message}`);
    },
    async isHeld(userId) {
      const { data, error } = await client
        .from("user_runtime")
        .select("lease_until")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(`lease isHeld: ${error.message}`);
      return !!data?.lease_until && Date.parse(data.lease_until) > Date.now();
    },
  };
}

/**
 * Which lease backend this environment uses (pure; exported for tests).
 * @param env Upstash URL/token and whether this is production
 * @returns "redis" when Upstash is configured, else "db" outside production
 * @throws Error in production without Upstash
 */
export function chooseLeaseBackend(env: {
  upstashUrl?: string | null;
  upstashToken?: string | null;
  production: boolean;
}): "redis" | "db" {
  if (env.upstashUrl && env.upstashToken) return "redis";
  if (env.production) throw new Error("Upstash Redis is required for the run lease in production");
  return "db";
}

let cached: LeaseStore | null = null;

/**
 * The process-wide lease store (static choice by env; see `chooseLeaseBackend`).
 * @returns the store
 * @throws Error in production without Upstash
 */
export function getLeaseStore(): LeaseStore {
  if (cached) return cached;
  const url = optionalEnv("UPSTASH_REDIS_REST_URL");
  const token = optionalEnv("UPSTASH_REDIS_REST_TOKEN");
  const backend = chooseLeaseBackend({ upstashUrl: url, upstashToken: token, production: isProduction });
  cached = backend === "redis" && url && token ? createRedisLeaseStore(new Redis({ url, token })) : createDbLeaseStore();
  return cached;
}

/**
 * Keeps a lease alive: extends every `everyMs`; on a failed or throwing extend, stops and calls
 * `onLost` once (the run must abort its sends). Overlapping extends are skipped.
 * @param store lease store
 * @param userId lease user
 * @param owner run's owner token
 * @param ttlMs TTL set on each extend
 * @param everyMs heartbeat interval (< ttlMs)
 * @param onLost called once when the lease is lost
 * @returns stop function (idempotent; does not release the lease)
 */
export function withHeartbeat(
  store: LeaseStore,
  userId: string,
  owner: string,
  ttlMs: number,
  everyMs: number,
  onLost: () => void,
): () => void {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void (async () => {
      let ok = false;
      try {
        ok = await store.extend(userId, owner, ttlMs);
      } catch {
        ok = false;
      }
      inFlight = false;
      if (!ok && !stopped) {
        stopped = true;
        clearInterval(timer);
        onLost();
      }
    })();
  }, Math.max(1, everyMs));
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
