/**
 * V2-03 §10.1 `backoff.test.ts`: monotonic, capped at 1h, jitter within ±20%.
 */
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, retryDelayMs } from "@/server/jobs/backoff";

const mid = () => 0.5; // factor exactly 1.0

describe("retryDelayMs", () => {
  it("doubles from 15s with no jitter at rng=0.5", () => {
    expect(retryDelayMs(1, mid)).toBe(15_000);
    expect(retryDelayMs(2, mid)).toBe(30_000);
    expect(retryDelayMs(3, mid)).toBe(60_000);
    expect(retryDelayMs(8, mid)).toBe(15_000 * 128);
  });

  it("is monotonic non-decreasing in attempt for a fixed rng", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      let prev = 0;
      for (let a = 1; a <= 40; a++) {
        const d = retryDelayMs(a, () => r);
        expect(d).toBeGreaterThanOrEqual(prev);
        prev = d;
      }
    }
  });

  it("never exceeds 1h, even with maximal jitter or absurd attempts", () => {
    for (const a of [9, 10, 20, 1000, Number.MAX_SAFE_INTEGER]) {
      expect(retryDelayMs(a, () => 0.999999)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      expect(retryDelayMs(a, mid)).toBe(BACKOFF_MAX_MS);
    }
  });

  it("keeps jitter within ±20% of the base", () => {
    for (let a = 1; a <= 8; a++) {
      const base = BACKOFF_BASE_MS * 2 ** (a - 1);
      for (let i = 0; i < 200; i++) {
        const d = retryDelayMs(a);
        expect(d).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
        expect(d).toBeLessThanOrEqual(Math.ceil(base * 1.2));
      }
    }
    expect(retryDelayMs(1, () => 0)).toBe(12_000);
    expect(retryDelayMs(1, () => 0.9999999)).toBe(18_000);
  });

  it("treats attempt < 1 and NaN as the first attempt", () => {
    expect(retryDelayMs(0, mid)).toBe(15_000);
    expect(retryDelayMs(-3, mid)).toBe(15_000);
    expect(retryDelayMs(Number.NaN, mid)).toBe(15_000);
  });

  it("clamps a misbehaving rng into range", () => {
    expect(retryDelayMs(1, () => -5)).toBe(12_000);
    expect(retryDelayMs(1, () => 7)).toBe(18_000);
  });
});
