/**
 * `GET /api/google/oauth` and `GET /api/google/callback` (master plan §1.12, C20; V2-07 07a-3).
 *
 * Real state/cookie/PKCE code (2.4's `beginGoogleOAuth` / `checkGoogleCallback`) and the real
 * `exchangeCode` against a stubbed global `fetch` (the HTTP boundary). Mocked at module
 * boundaries: the session lookup (DB), `completeConnect` (DB; smoke-tested end to end in
 * `tests/smoke/gcal.smoke.test.ts`) and `enqueueJob`.
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

const readSession = jest.fn();
jest.mock("@/server/security/sessions", () => ({
  ...jest.requireActual("@/server/security/sessions"),
  readSession: (raw: string | undefined) => readSession(raw),
}));
const completeConnect = jest.fn();
jest.mock("@/server/integrations/google/oauth/flow", () => ({
  ...jest.requireActual("@/server/integrations/google/oauth/flow"),
  completeConnect: (input: unknown) => completeConnect(input),
}));
const enqueueJob = jest.fn();
jest.mock("@/server/jobs/enqueue", () => ({
  enqueueJob: (input: unknown) => enqueueJob(input),
  cancelJobs: jest.fn(async () => 0),
}));

import { GET as oauthGET } from "@/app/api/google/oauth/route";
import { GET as callbackGET } from "@/app/api/google/callback/route";
import { OAUTH_COOKIE_NAME } from "@/server/integrations/google/oauth/flow";
import { SESSION_COOKIE } from "@/server/security/sessions";

const BASE = "https://aria-test.vercel.app";
const CODES = ["connected", "missing_scopes", "denied", "admin_blocked", "stale", "expired", "account_in_use", "error"];
const key = randomBytes(32);
const ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "csecret",
  APP_BASE_URL: BASE,
  APP_ENCRYPTION_KEY: key.toString("base64"),
  SESSION_SECRET: "test-session-secret",
};
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let tokenCalls: URLSearchParams[] = [];
let tokenResponse: () => Response;

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.GOOGLE_REDIRECT_URI;
  delete process.env.GOOGLE_PKCE;
});
afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
});

const SESSION_RAW = "raw-session-id-abc";
const USER = "11111111-1111-4111-8111-111111111111";
const ALL_FEATURES = ["calendar_read", "calendar_write", "gmail_read", "gmail_send"];

beforeEach(() => {
  readSession.mockReset();
  completeConnect.mockReset();
  enqueueJob.mockReset();
  enqueueJob.mockResolvedValue({ id: "job-1", runAt: new Date(), dbNow: new Date(), created: true });
  readSession.mockImplementation(async (raw: string | undefined) =>
    raw === SESSION_RAW ? { userId: USER, scope: "setup", createdAt: new Date(Date.now() - 60_000) } : null,
  );
  tokenCalls = [];
  tokenResponse = () =>
    Response.json({ access_token: "at-x", expires_in: 3599, refresh_token: "rt-x", scope: "openid", id_token: "idt", token_type: "Bearer" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
      return tokenResponse();
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

function startReq(o: { site?: string | null; session?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = {};
  const site = o.site === undefined ? "same-origin" : o.site;
  if (site !== null) headers["sec-fetch-site"] = site;
  const session = o.session === undefined ? SESSION_RAW : o.session;
  if (session !== null) headers.cookie = `${SESSION_COOKIE}=${session}`;
  return new NextRequest(`${BASE}/api/google/oauth`, { headers });
}

function setupCode(res: Response): string | null {
  const loc = res.headers.get("location");
  if (!loc) return null;
  const u = new URL(loc);
  expect(u.origin).toBe(BASE);
  expect(u.pathname).toBe("/setup");
  return u.searchParams.get("google");
}

/** Run the start route and return the state + OAuth cookie it issued. */
async function begin(): Promise<{ state: string; cookie: string; challenge: string | null }> {
  const res = await oauthGET(startReq());
  const loc = new URL(res.headers.get("location") as string);
  const cookie = res.cookies.get(OAUTH_COOKIE_NAME)?.value as string;
  return { state: loc.searchParams.get("state") as string, cookie, challenge: loc.searchParams.get("code_challenge") };
}

function callbackReq(q: Record<string, string>, cookies: Record<string, string>): NextRequest {
  const url = new URL(`${BASE}/api/google/callback`);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(url, { headers: cookie ? { cookie } : {} });
}

describe("GET /api/google/oauth", () => {
  it("fresh setup session + same-origin → 303 to Google, no-store, encrypted OAuth cookie", async () => {
    const res = await oauthGET(startReq());
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("client_id")).toBe(ENV.GOOGLE_CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/api/google/callback`);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
    const cookie = res.cookies.get(OAUTH_COOKIE_NAME);
    expect(cookie?.value).toMatch(/^v1:/);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
  });

  it("Sec-Fetch-Site none (typed URL) is allowed", async () => {
    expect((await oauthGET(startReq({ site: "none" }))).status).toBe(303);
  });

  it("cross-site, same-site, or missing Sec-Fetch-Site → 403, no cookie", async () => {
    for (const site of ["cross-site", "same-site", null]) {
      const res = await oauthGET(startReq({ site }));
      expect(res.status).toBe(403);
      expect(res.cookies.get(OAUTH_COOKIE_NAME)).toBeUndefined();
    }
    expect(readSession).not.toHaveBeenCalled();
  });

  it("no session, view session, or a setup session older than 15 min → /setup?google=stale", async () => {
    expect(setupCode(await oauthGET(startReq({ session: null })))).toBe("stale");
    readSession.mockResolvedValueOnce({ userId: USER, scope: "view", createdAt: new Date() });
    expect(setupCode(await oauthGET(startReq()))).toBe("stale");
    readSession.mockResolvedValueOnce({ userId: USER, scope: "setup", createdAt: new Date(Date.now() - 16 * 60_000) });
    const res = await oauthGET(startReq());
    expect(setupCode(res)).toBe("stale");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.cookies.get(OAUTH_COOKIE_NAME)).toBeUndefined();
  });

  it("missing client config → /setup?google=error", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      expect(setupCode(await oauthGET(startReq()))).toBe("error");
    } finally {
      process.env.GOOGLE_CLIENT_ID = ENV.GOOGLE_CLIENT_ID;
    }
  });
});

describe("GET /api/google/callback", () => {
  it("happy path: exchanges with the PKCE verifier, connects, enqueues post-connect, → connected", async () => {
    const { state, cookie } = await begin();
    completeConnect.mockResolvedValue({ ok: true, integrationId: "int-1", accountEmail: "a@b.edu", features: ALL_FEATURES });
    const res = await callbackGET(callbackReq({ code: "auth-code", state }, { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: cookie }));

    expect(res.status).toBe(303);
    expect(setupCode(res)).toBe("connected");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.cookies.get(OAUTH_COOKIE_NAME)?.value).toBe("");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.get("code")).toBe("auth-code");
    expect(tokenCalls[0]?.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(completeConnect).toHaveBeenCalledWith({ userId: USER, tokens: expect.objectContaining({ access_token: "at-x" }) });
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: "google_post_connect",
      userId: USER,
      dedupeKey: `google_post_connect:${USER}`,
      payload: {},
    });
  });

  it("connected with some boxes unticked → missing_scopes (still enqueues post-connect)", async () => {
    const { state, cookie } = await begin();
    completeConnect.mockResolvedValue({ ok: true, integrationId: "int-1", accountEmail: "a@b.edu", features: ["calendar_read"] });
    const res = await callbackGET(callbackReq({ code: "c", state }, { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: cookie }));
    expect(setupCode(res)).toBe("missing_scopes");
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it("completeConnect refusals map to fixed codes and never enqueue", async () => {
    const cases: [string, string][] = [
      ["missing_required_scopes", "missing_scopes"],
      ["account_in_use", "account_in_use"],
      ["no_refresh_token", "error"],
      ["email_unverified", "error"],
    ];
    for (const [reason, code] of cases) {
      const { state, cookie } = await begin();
      completeConnect.mockResolvedValueOnce({ ok: false, reason });
      const res = await callbackGET(callbackReq({ code: "c", state }, { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: cookie }));
      expect(setupCode(res)).toBe(code);
    }
    completeConnect.mockRejectedValueOnce(new Error("id_token verification failed"));
    const { state, cookie } = await begin();
    expect(setupCode(await callbackGET(callbackReq({ code: "c", state }, { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: cookie })))).toBe("error");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("Google error params: access_denied → denied, admin_policy_enforced → admin_blocked, other → error", async () => {
    expect(setupCode(await callbackGET(callbackReq({ error: "access_denied" }, {})))).toBe("denied");
    expect(setupCode(await callbackGET(callbackReq({ error: "admin_policy_enforced" }, {})))).toBe("admin_blocked");
    const res = await callbackGET(callbackReq({ error: "<script>x</script>" }, {}));
    expect(setupCode(res)).toBe("error");
    expect(res.cookies.get(OAUTH_COOKIE_NAME)?.value).toBe("");
    expect(tokenCalls).toEqual([]);
  });

  it("binding failures: bad/expired state or missing/mismatched cookie → expired; no/other session → stale", async () => {
    const { state, cookie } = await begin();
    const other = await begin();
    const both = { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: cookie };
    const tampered = `${state.split(".")[0]}x.${state.split(".")[1]}`;
    expect(setupCode(await callbackGET(callbackReq({ code: "c", state: tampered }, both)))).toBe("expired");
    expect(setupCode(await callbackGET(callbackReq({ code: "c" }, both)))).toBe("expired");
    expect(setupCode(await callbackGET(callbackReq({ code: "c", state }, { [SESSION_COOKIE]: SESSION_RAW })))).toBe("expired");
    expect(
      setupCode(await callbackGET(callbackReq({ code: "c", state }, { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: other.cookie }))),
    ).toBe("expired");
    expect(setupCode(await callbackGET(callbackReq({ code: "c", state }, { [OAUTH_COOKIE_NAME]: cookie })))).toBe("stale");
    // Same user, a different session (another browser tab signed in later).
    const res = await callbackGET(callbackReq({ code: "c", state }, { [SESSION_COOKIE]: "other-raw", [OAUTH_COOKIE_NAME]: cookie }));
    expect(setupCode(res)).toBe("stale");

    jest.useFakeTimers({ now: Date.now() + 11 * 60_000, doNotFake: ["nextTick", "setImmediate"] });
    try {
      expect(setupCode(await callbackGET(callbackReq({ code: "c", state }, both)))).toBe("expired");
    } finally {
      jest.useRealTimers();
    }
    expect(tokenCalls).toEqual([]);
    expect(completeConnect).not.toHaveBeenCalled();
  });

  it("code exchange failures: invalid_grant → expired, 5xx → error, missing code → error", async () => {
    let b = await begin();
    const cookies = () => ({ [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: b.cookie });
    tokenResponse = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    expect(setupCode(await callbackGET(callbackReq({ code: "c", state: b.state }, cookies())))).toBe("expired");
    b = await begin();
    tokenResponse = () => new Response("oops", { status: 503 });
    expect(setupCode(await callbackGET(callbackReq({ code: "c", state: b.state }, cookies())))).toBe("error");
    b = await begin();
    expect(setupCode(await callbackGET(callbackReq({ state: b.state }, cookies())))).toBe("error");
    expect(completeConnect).not.toHaveBeenCalled();
  });

  it("enqueue failure → error (the row is active but nothing would sync)", async () => {
    const { state, cookie } = await begin();
    completeConnect.mockResolvedValue({ ok: true, integrationId: "int-1", accountEmail: "a@b.edu", features: ALL_FEATURES });
    enqueueJob.mockRejectedValueOnce(new Error("db down"));
    expect(setupCode(await callbackGET(callbackReq({ code: "c", state }, { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: cookie })))).toBe(
      "error",
    );
  });

  it("every redirect code is a GoogleConnectStatus, and nothing secret reaches a log line", async () => {
    const seen = new Set<string>();
    const logs: string[] = [];
    for (const m of ["info", "warn", "error"] as const) {
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
    }
    const { state, cookie } = await begin();
    completeConnect.mockResolvedValue({ ok: true, integrationId: "int-1", accountEmail: "a@b.edu", features: ALL_FEATURES });
    const queries: Record<string, string>[] = [{ code: "auth-code-secret", state }, { error: "access_denied" }, { code: "c", state: "x.y" }];
    for (const q of queries) {
      const code = setupCode(await callbackGET(callbackReq(q, { [SESSION_COOKIE]: SESSION_RAW, [OAUTH_COOKIE_NAME]: cookie })));
      seen.add(code as string);
    }
    for (const c of seen) expect(CODES).toContain(c);
    const joined = logs.join("\n");
    for (const secret of ["auth-code-secret", "at-x", "rt-x", SESSION_RAW, cookie, state]) expect(joined).not.toContain(secret);
  });
});
