/**
 * pipeline/lease.ts (V2-03 §2.2, §10.1 lease.test): one contract suite run against the in-memory
 * store and the Redis store (over a fake Upstash client with the real Lua scripts' semantics),
 * with an injected clock: exclusive acquire, owner-only extend/release, expiry hands over.
 * Plus the heartbeat (`onLost` on a failed or throwing extend; stop) and the static backend choice.
 * The DB store is exercised against Postgres in tests/smoke/pipeline.smoke.test.ts.
 */
import {
  chooseLeaseBackend,
  createRedisLeaseStore,
  leaseKey,
  withHeartbeat,
  type LeaseStore,
} from "@/server/pipeline/lease";
import { createFakeLeaseRedis, createMemoryLeaseStore } from "../../helpers/memory-store";

const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const A = "owner-a";
const B = "owner-b";
const TTL = 60_000;

type Factory = (clock: () => number) => LeaseStore;

const backends: [string, Factory][] = [
  ["memory", (clock) => createMemoryLeaseStore(clock)],
  ["redis (fake upstash)", (clock) => createRedisLeaseStore(createFakeLeaseRedis(clock))],
];

describe.each(backends)("LeaseStore contract: %s", (_name, make) => {
  let t = 1_000_000;
  const clock = () => t;
  let store: LeaseStore;
  beforeEach(() => {
    t = 1_000_000;
    store = make(clock);
  });

  it("acquire is exclusive per user, independent across users", async () => {
    expect(await store.isHeld(U)).toBe(false);
    expect(await store.acquire(U, A, TTL)).toBe(true);
    expect(await store.acquire(U, B, TTL)).toBe(false);
    expect(await store.isHeld(U)).toBe(true);
    expect(await store.acquire(V, B, TTL)).toBe(true);
  });

  it("only the owner can extend or release", async () => {
    await store.acquire(U, A, TTL);
    expect(await store.extend(U, B, TTL)).toBe(false);
    await store.release(U, B);
    expect(await store.isHeld(U)).toBe(true);
    expect(await store.extend(U, A, TTL)).toBe(true);
    await store.release(U, A);
    expect(await store.isHeld(U)).toBe(false);
    expect(await store.acquire(U, B, TTL)).toBe(true);
  });

  it("extend pushes the expiry out", async () => {
    await store.acquire(U, A, 1_000);
    t += 900;
    expect(await store.extend(U, A, 1_000)).toBe(true);
    t += 900; // 1800ms after acquire, 900ms after extend
    expect(await store.isHeld(U)).toBe(true);
    expect(await store.acquire(U, B, TTL)).toBe(false);
  });

  it("expiry hands the lease over; the old owner can neither extend nor release it", async () => {
    await store.acquire(U, A, 1_000);
    t += 1_001;
    expect(await store.isHeld(U)).toBe(false);
    expect(await store.acquire(U, B, TTL)).toBe(true);
    expect(await store.extend(U, A, TTL)).toBe(false);
    await store.release(U, A);
    expect(await store.isHeld(U)).toBe(true);
    expect(await store.extend(U, B, TTL)).toBe(true);
  });
});

describe("Redis lease store wiring", () => {
  it("uses lease:<userId> keys and SET NX PX / Lua for every operation", async () => {
    const redis = createFakeLeaseRedis(() => 0);
    const store = createRedisLeaseStore(redis);
    await store.acquire(U, A, TTL);
    await store.extend(U, A, TTL);
    await store.isHeld(U);
    await store.release(U, A);
    expect(redis.calls).toEqual(["set", "extend", "exists", "release"]);
    expect(leaseKey(U)).toBe(`lease:${U}`);
  });
});

describe("withHeartbeat", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("keeps the lease alive past its TTL while extends succeed", async () => {
    const store = createMemoryLeaseStore(Date.now);
    await store.acquire(U, A, 60_000);
    const onLost = jest.fn();
    const stop = withHeartbeat(store, U, A, 60_000, 20_000, onLost);
    await jest.advanceTimersByTimeAsync(200_000);
    expect(await store.isHeld(U)).toBe(true);
    expect(store.holder(U)).toBe(A);
    expect(onLost).not.toHaveBeenCalled();
    stop();
  });

  it("fires onLost exactly once when the lease was taken over, then stops extending", async () => {
    const store = createMemoryLeaseStore(Date.now);
    await store.acquire(U, A, 30_000);
    const extend = jest.spyOn(store, "extend");
    const onLost = jest.fn();
    withHeartbeat(store, U, A, 30_000, 40_000, onLost); // heartbeat slower than the TTL
    await jest.advanceTimersByTimeAsync(31_000);
    expect(await store.acquire(U, B, 60_000)).toBe(true);
    await jest.advanceTimersByTimeAsync(10_000); // first beat at 40s fails
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(store.holder(U)).toBe(B); // the lost heartbeat never touched B's lease
    const calls = extend.mock.calls.length;
    await jest.advanceTimersByTimeAsync(200_000);
    expect(extend.mock.calls.length).toBe(calls);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing extend (store outage) as lost", async () => {
    const store = createMemoryLeaseStore(Date.now);
    await store.acquire(U, A, 60_000);
    jest.spyOn(store, "extend").mockRejectedValue(new Error("redis down"));
    const onLost = jest.fn();
    withHeartbeat(store, U, A, 60_000, 20_000, onLost);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("stop() halts extends and never reports a loss", async () => {
    const store = createMemoryLeaseStore(Date.now);
    await store.acquire(U, A, 60_000);
    const extend = jest.spyOn(store, "extend");
    const onLost = jest.fn();
    const stop = withHeartbeat(store, U, A, 60_000, 20_000, onLost);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(extend).toHaveBeenCalledTimes(1);
    stop();
    stop();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(extend).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe("chooseLeaseBackend", () => {
  it("uses Upstash whenever it is configured", () => {
    expect(chooseLeaseBackend({ upstashUrl: "https://x.upstash.io", upstashToken: "t", production: true })).toBe("redis");
    expect(chooseLeaseBackend({ upstashUrl: "https://x.upstash.io", upstashToken: "t", production: false })).toBe("redis");
  });

  it("falls back to the DB lease only outside production", () => {
    expect(chooseLeaseBackend({ production: false })).toBe("db");
    expect(chooseLeaseBackend({ upstashUrl: "https://x.upstash.io", production: false })).toBe("db");
  });

  it("refuses production without Upstash (fail closed)", () => {
    expect(() => chooseLeaseBackend({ production: true })).toThrow(/Upstash/);
    expect(() => chooseLeaseBackend({ upstashUrl: "https://x.upstash.io", upstashToken: "", production: true })).toThrow();
  });
});
