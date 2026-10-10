/**
 * src/server/proactive/reconcile.ts — pure parts: cron authorization (bearer, constant-time;
 * loopback-only without a secret outside production) and the briefing-chain health check.
 */
import { briefingChainHealthy, isCronAuthorized } from "@/server/proactive/reconcile";

describe("isCronAuthorized", () => {
  const base = { authorization: null, secret: "s3cret", production: true, host: "aria.vercel.app" };
  it("requires the exact bearer when a secret is set", () => {
    expect(isCronAuthorized({ ...base, authorization: "Bearer s3cret" })).toBe(true);
    expect(isCronAuthorized({ ...base, authorization: "Bearer s3cret2" })).toBe(false);
    expect(isCronAuthorized({ ...base, authorization: "s3cret" })).toBe(false);
    expect(isCronAuthorized(base)).toBe(false);
    expect(isCronAuthorized({ ...base, host: "localhost:3000" })).toBe(false);
  });
  it("without a secret: closed in production, loopback-only in dev", () => {
    expect(isCronAuthorized({ ...base, secret: undefined })).toBe(false);
    expect(isCronAuthorized({ ...base, secret: undefined, production: false, host: "localhost:3000" })).toBe(true);
    expect(isCronAuthorized({ ...base, secret: undefined, production: false, host: "127.0.0.1" })).toBe(true);
    expect(isCronAuthorized({ ...base, secret: undefined, production: false, host: "evil.example" })).toBe(false);
  });
});

describe("briefingChainHealthy", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  const next = new Date("2026-10-12T12:00:00Z");
  it("healthy: future next_briefing_at with a matching pending job (or a running one)", () => {
    expect(briefingChainHealthy({ nextBriefingAt: next, job: { status: "pending", payload: { targetAt: next.toISOString() } }, now })).toBe(true);
    expect(briefingChainHealthy({ nextBriefingAt: next, job: { status: "running", payload: {} }, now })).toBe(true);
  });
  it("broken: missing/past next_briefing_at, missing job, mismatched target", () => {
    expect(briefingChainHealthy({ nextBriefingAt: null, job: null, now })).toBe(false);
    expect(briefingChainHealthy({ nextBriefingAt: new Date(now.getTime() - 1), job: { status: "pending", payload: {} }, now })).toBe(false);
    expect(briefingChainHealthy({ nextBriefingAt: next, job: null, now })).toBe(false);
    expect(briefingChainHealthy({ nextBriefingAt: next, job: { status: "pending", payload: { targetAt: now.toISOString() } }, now })).toBe(false);
  });
});
