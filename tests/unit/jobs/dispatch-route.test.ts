/**
 * `/api/jobs/dispatch` route (V2-03 §11 T2): 401 on a bad HMAC / bearer, 202 on a good one, and
 * the work is deferred to `after()` (captured here, not run). Bearer only on GET, HMAC only on POST.
 */
const afterCallbacks: Array<() => unknown> = [];
jest.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

import { GET, POST, maxDuration } from "@/app/api/jobs/dispatch/route";
import { signDispatch } from "@/server/jobs/auth";

const URL_ = "http://localhost:3000/api/jobs/dispatch";
const DISPATCH = "unit-dispatch-secret-0123456789abcdef";
const CRON = "unit-cron-secret";

function signedPost(tsSec: number, secret = DISPATCH): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "x-aria-ts": String(tsSec), "x-aria-sig": signDispatch(tsSec, secret) },
    body: "{}",
  });
}

describe("dispatch route", () => {
  const saved = { d: process.env.JOBS_DISPATCH_SECRET, c: process.env.CRON_SECRET };
  beforeEach(() => {
    afterCallbacks.length = 0;
    process.env.JOBS_DISPATCH_SECRET = DISPATCH;
    process.env.CRON_SECRET = CRON;
  });
  afterAll(() => {
    for (const [k, v] of [["JOBS_DISPATCH_SECRET", saved.d], ["CRON_SECRET", saved.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("allows the full 300s Hobby duration", () => {
    expect(maxDuration).toBe(300);
  });

  it("POST: 202 + after() for a fresh HMAC; 401 otherwise, with no work scheduled", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ok = await POST(signedPost(now));
    expect(ok.status).toBe(202);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(afterCallbacks).toHaveLength(1);

    afterCallbacks.length = 0;
    for (const bad of [
      signedPost(now, "wrong-secret"),
      signedPost(now - 120),
      new Request(URL_, { method: "POST" }),
      new Request(URL_, { method: "POST", headers: { authorization: `Bearer ${CRON}` } }),
    ]) {
      expect((await POST(bad)).status).toBe(401);
    }
    expect(afterCallbacks).toHaveLength(0);
  });

  it("GET: 202 for the cron bearer; 401 for anything else", async () => {
    const ok = await GET(new Request(URL_, { headers: { authorization: `Bearer ${CRON}` } }));
    expect(ok.status).toBe(202);
    expect(afterCallbacks).toHaveLength(1);
    expect((await GET(new Request(URL_, { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const hmacOnGet = new Request(URL_, {
      headers: { "x-aria-ts": String(now), "x-aria-sig": signDispatch(now, DISPATCH) },
    });
    expect((await GET(hmacOnGet)).status).toBe(401);
  });

  it("unset secrets close both paths", async () => {
    delete process.env.JOBS_DISPATCH_SECRET;
    delete process.env.CRON_SECRET;
    expect((await POST(signedPost(Math.floor(Date.now() / 1000)))).status).toBe(401);
    expect((await GET(new Request(URL_, { headers: { authorization: "Bearer " } }))).status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);
  });
});
