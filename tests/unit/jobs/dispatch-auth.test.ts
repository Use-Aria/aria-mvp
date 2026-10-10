/**
 * V2-03 §10.1 `dispatch-auth.test.ts`: sign/verify round trip, ±60s skew, wrong secret,
 * malformed sig, non-numeric ts, cron bearer, and the method matrix of the dispatch route.
 */
import {
  authorizeDispatchRequest,
  signDispatch,
  verifyCronBearer,
  verifyDispatch,
} from "@/server/jobs/auth";

const SECRET = "test-dispatch-secret";
const NOW = 1_760_000_000;

function headers(h: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (n) => lower.get(n.toLowerCase()) ?? null };
}

describe("signDispatch", () => {
  it("matches pgcrypto: encode(extensions.hmac('v1.' || ts, key, 'sha256'), 'hex')", () => {
    // Computed on the local Supabase stack with the exact expression private.jobs_tick() uses.
    expect(signDispatch(NOW, SECRET)).toBe("1d62cbbaa6348b7ed7c418e0e3d58c501be7721395f55f1776d638bbb8c112a9");
  });
});

describe("verifyDispatch", () => {
  const sig = signDispatch(NOW, SECRET);

  it("round-trips", () => {
    expect(verifyDispatch({ ts: String(NOW), sig }, SECRET, NOW)).toBe(true);
    expect(verifyDispatch({ ts: String(NOW), sig: sig.toUpperCase() }, SECRET, NOW)).toBe(true);
  });

  it("accepts skew up to 60s either way and rejects 61s", () => {
    expect(verifyDispatch({ ts: String(NOW), sig }, SECRET, NOW + 60)).toBe(true);
    expect(verifyDispatch({ ts: String(NOW), sig }, SECRET, NOW - 60)).toBe(true);
    expect(verifyDispatch({ ts: String(NOW), sig }, SECRET, NOW + 61)).toBe(false);
    expect(verifyDispatch({ ts: String(NOW), sig }, SECRET, NOW - 61)).toBe(false);
  });

  it("rejects a wrong secret or a signature for another timestamp", () => {
    expect(verifyDispatch({ ts: String(NOW), sig }, "other-secret", NOW)).toBe(false);
    expect(verifyDispatch({ ts: String(NOW + 1), sig }, SECRET, NOW)).toBe(false);
  });

  it("rejects malformed signatures and timestamps", () => {
    expect(verifyDispatch({ ts: String(NOW), sig: sig.slice(0, 63) }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: String(NOW), sig: `${sig}00` }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: String(NOW), sig: `${sig.slice(0, 63)}z` }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: "abc", sig }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: `${NOW}.0`, sig }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: `-${NOW}`, sig }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: ` ${NOW}`, sig }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: "1".repeat(20), sig }, SECRET, NOW)).toBe(false);
  });

  it("rejects missing headers and an empty secret", () => {
    expect(verifyDispatch({ ts: null, sig }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: String(NOW), sig: null }, SECRET, NOW)).toBe(false);
    expect(verifyDispatch({ ts: String(NOW), sig: signDispatch(NOW, "") }, "", NOW)).toBe(false);
  });
});

describe("verifyCronBearer", () => {
  it("accepts exactly `Bearer <secret>`", () => {
    expect(verifyCronBearer("Bearer cron-s3cret", "cron-s3cret")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(verifyCronBearer("Bearer cron-s3cretX", "cron-s3cret")).toBe(false);
    expect(verifyCronBearer("Bearer cron-s3cre", "cron-s3cret")).toBe(false);
    expect(verifyCronBearer("bearer cron-s3cret", "cron-s3cret")).toBe(false);
    expect(verifyCronBearer("Basic cron-s3cret", "cron-s3cret")).toBe(false);
    expect(verifyCronBearer("cron-s3cret", "cron-s3cret")).toBe(false);
    expect(verifyCronBearer(null, "cron-s3cret")).toBe(false);
    expect(verifyCronBearer("Bearer ", "")).toBe(false);
    expect(verifyCronBearer("Bearer x", "")).toBe(false);
  });
});

describe("authorizeDispatchRequest", () => {
  const secrets = { dispatchSecret: SECRET, cronSecret: "cron-s3cret" };
  const signed = headers({ "x-aria-ts": String(NOW), "x-aria-sig": signDispatch(NOW, SECRET) });
  const bearer = headers({ Authorization: "Bearer cron-s3cret" });

  it("POST takes only the HMAC; GET takes only the bearer", () => {
    expect(authorizeDispatchRequest("POST", signed, secrets, NOW)).toBe(true);
    expect(authorizeDispatchRequest("POST", bearer, secrets, NOW)).toBe(false);
    expect(authorizeDispatchRequest("GET", bearer, secrets, NOW)).toBe(true);
    expect(authorizeDispatchRequest("GET", signed, secrets, NOW)).toBe(false);
    expect(authorizeDispatchRequest("PUT", signed, secrets, NOW)).toBe(false);
  });

  it("closes a path whose secret is unset", () => {
    expect(authorizeDispatchRequest("POST", signed, { cronSecret: "cron-s3cret" }, NOW)).toBe(false);
    expect(authorizeDispatchRequest("GET", bearer, { dispatchSecret: SECRET }, NOW)).toBe(false);
  });
});
