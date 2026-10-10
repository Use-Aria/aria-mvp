/**
 * Unit tests for src/server/integrations/canvas/schedule.ts (V2-05 §2.7, §10.2). Run: npm test
 */
import { randomUUID } from "node:crypto";
import {
  LONG_OUTAGE_RETRY_MS,
  backoffDelayMs,
  decideAfterFailure,
  nextHourlySync,
  userSlotMinute,
} from "@/server/integrations/canvas/schedule";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("userSlotMinute", () => {
  it("is stable per user and in 0..59", () => {
    const id = "4b0f3a5e-2c1d-4e8f-9a7b-6c5d4e3f2a1b";
    expect(userSlotMinute(id)).toBe(userSlotMinute(id));
    expect(userSlotMinute(id)).toBeGreaterThanOrEqual(0);
    expect(userSlotMinute(id)).toBeLessThan(60);
  });

  it("is roughly uniform over 10k uuids", () => {
    const buckets = new Array<number>(6).fill(0); // 10-minute buckets
    for (let i = 0; i < 10_000; i++) buckets[Math.floor(userSlotMinute(randomUUID()) / 10)]++;
    for (const b of buckets) {
      expect(b).toBeGreaterThan(1_400); // expected ≈ 1,667
      expect(b).toBeLessThan(1_950);
    }
  });
});

describe("nextHourlySync", () => {
  it("lands in (now+30m, now+90m] at the user's slot minute (no jitter)", () => {
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      const now = new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + Math.floor(Math.random() * 7 * 24 * HOUR));
      const at = nextHourlySync(id, now, () => 0);
      const delta = at.getTime() - now.getTime();
      expect(delta).toBeGreaterThan(30 * MIN);
      expect(delta).toBeLessThanOrEqual(90 * MIN);
      expect(at.getUTCMinutes()).toBe(userSlotMinute(id));
      expect(at.getUTCSeconds()).toBe(0);
      expect(at.getUTCMilliseconds()).toBe(0);
    }
  });

  it("adds 0–59 whole seconds of jitter", () => {
    const id = randomUUID();
    const now = new Date("2026-10-10T12:00:00Z");
    const base = nextHourlySync(id, now, () => 0).getTime();
    expect(nextHourlySync(id, now, () => 0.5).getTime() - base).toBe(30_000);
    expect(nextHourlySync(id, now, () => 0.9999999).getTime() - base).toBe(59_000);
  });

  it("is strictly after now+30m when now+30m is exactly the slot", () => {
    const id = randomUUID();
    const slot = userSlotMinute(id);
    const now = new Date(Date.UTC(2026, 9, 10, 12, slot, 0) - 30 * MIN);
    expect(nextHourlySync(id, now, () => 0).getTime() - now.getTime()).toBe(90 * MIN);
  });
});

describe("backoffDelayMs", () => {
  it.each([
    [1, 5 * MIN],
    [2, 15 * MIN],
    [3, 45 * MIN],
    [4, 2 * HOUR],
    [5, 6 * HOUR],
    [9, 6 * HOUR],
    [0, 5 * MIN],
  ])("n=%i → %i ms ±20%%", (n, base) => {
    expect(backoffDelayMs(n, () => 0.5)).toBe(base);
    expect(backoffDelayMs(n, () => 0)).toBe(Math.round(base * 0.8));
    expect(backoffDelayMs(n, () => 0.9999999)).toBeLessThanOrEqual(Math.round(base * 1.2));
    expect(backoffDelayMs(n, () => 0.9999999)).toBeGreaterThan(Math.round(base * 1.19));
  });
});

describe("decideAfterFailure", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const mid = () => 0.5;

  it("definitive: 3 failures within < 2h → retry with backoff", () => {
    expect(
      decideAfterFailure({ cls: "definitive", consecutiveFailures: 3, firstFailureAt: ago(2 * HOUR - 1), now, alreadyNotified: false, rand: mid }),
    ).toEqual({ action: "retry", at: new Date(now.getTime() + 45 * MIN) });
  });

  it("definitive: 3 failures spanning ≥ 2h → revoke; fewer than 3 → retry", () => {
    expect(decideAfterFailure({ cls: "definitive", consecutiveFailures: 3, firstFailureAt: ago(2 * HOUR), now, alreadyNotified: false })).toEqual({
      action: "revoke",
    });
    expect(decideAfterFailure({ cls: "definitive", consecutiveFailures: 2, firstFailureAt: ago(10 * HOUR), now, alreadyNotified: false, rand: mid }).action).toBe(
      "retry",
    );
  });

  it("rejected (policy) at sync counts as definitive", () => {
    expect(decideAfterFailure({ cls: "rejected", consecutiveFailures: 4, firstFailureAt: ago(3 * HOUR), now, alreadyNotified: false })).toEqual({
      action: "revoke",
    });
  });

  it("transient/slow-transient for 48h → error_notify once, then keep retrying every 6h", () => {
    for (const cls of ["transient", "slow_transient"] as const) {
      expect(decideAfterFailure({ cls, consecutiveFailures: 20, firstFailureAt: ago(48 * HOUR), now, alreadyNotified: false })).toEqual({
        action: "error_notify",
        at: new Date(now.getTime() + LONG_OUTAGE_RETRY_MS),
      });
      expect(decideAfterFailure({ cls, consecutiveFailures: 21, firstFailureAt: ago(54 * HOUR), now, alreadyNotified: true })).toEqual({
        action: "retry",
        at: new Date(now.getTime() + LONG_OUTAGE_RETRY_MS),
      });
    }
  });

  it("transient never revokes, and backs off before 48h", () => {
    const d = decideAfterFailure({ cls: "transient", consecutiveFailures: 2, firstFailureAt: ago(10 * MIN), now, alreadyNotified: false, rand: mid });
    expect(d).toEqual({ action: "retry", at: new Date(now.getTime() + 15 * MIN) });
    expect(decideAfterFailure({ cls: "transient", consecutiveFailures: 30, firstFailureAt: ago(47 * HOUR), now, alreadyNotified: false }).action).toBe("retry");
  });

  it("a first failure (no streak start yet) retries in ~5 minutes", () => {
    expect(decideAfterFailure({ cls: "definitive", consecutiveFailures: 1, firstFailureAt: null, now, alreadyNotified: false, rand: mid })).toEqual({
      action: "retry",
      at: new Date(now.getTime() + 5 * MIN),
    });
  });
});
