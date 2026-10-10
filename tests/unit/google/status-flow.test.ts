/**
 * `toStatusView` (§1.12 `GoogleStatusView`) and the token-endpoint calls in `oauth/flow.ts`
 * against a scripted fetch.
 */
import { randomBytes } from "node:crypto";
import { GoogleApiError, GoogleAuthRevokedError } from "@/server/integrations/google/errors";
import {
  beginGoogleOAuth,
  checkGoogleCallback,
  exchangeCode,
  OAUTH_COOKIE_NAME,
  refreshAccessToken,
  revokeToken,
} from "@/server/integrations/google/oauth/flow";
import { toStatusView } from "@/server/integrations/google/status";
import { googleRow, json, scriptedFetch, TOKEN_URL, tokenOk } from "./fakes";

const key = randomBytes(32);
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ENV = {
  GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "csecret",
  APP_BASE_URL: "https://aria-test.vercel.app",
  APP_ENCRYPTION_KEY: key.toString("base64"),
};
const saved: Record<string, string | undefined> = {};
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
});

describe("toStatusView", () => {
  it("no row / disconnected → none; revoked → revoked; error → error", () => {
    expect(toStatusView(null)).toEqual({ connected: false, reason: "none" });
    expect(toStatusView(googleRow(key, { status: "disconnected" }))).toEqual({ connected: false, reason: "none" });
    expect(toStatusView(googleRow(key, { status: "revoked" }))).toEqual({ connected: false, reason: "revoked" });
    expect(toStatusView(googleRow(key, { status: "error" }))).toEqual({ connected: false, reason: "error" });
  });

  it("active → connected with features and capability flags", () => {
    const v = toStatusView(
      googleRow(key, {
        scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/gmail.send"],
      }),
    );
    expect(v).toEqual({
      connected: true,
      email: "student@example.edu",
      features: ["calendar_read", "gmail_send"],
      canReadMail: false,
      canSendMail: true,
      canReadCalendar: true,
      canWriteAriaCalendar: false,
      connectedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(JSON.stringify(v)).not.toMatch(/v1:/); // never exposes token ciphertext
  });

  it("triage: running until completed_at, with total", () => {
    const running = toStatusView(googleRow(key, { gmail_triage: { run_id: "r", started_at: "2026-10-10T00:00:00Z", total: 120 } }));
    expect(running.connected && running.triage).toEqual({ running: true, total: 120 });
    const done = toStatusView(
      googleRow(key, { gmail_triage: { run_id: "r", started_at: "2026-10-10T00:00:00Z", completed_at: "2026-10-10T00:05:00Z" } }),
    );
    expect(done.connected && done.triage).toEqual({ running: false });
    const none = toStatusView(googleRow(key, { gmail_triage: null }));
    expect(none.connected && "triage" in none).toBe(false);
  });
});

describe("token endpoint calls", () => {
  it("exchangeCode posts the code, redirect URI, client creds and PKCE verifier", async () => {
    const { fetch, calls } = scriptedFetch({
      [TOKEN_URL]: [() => tokenOk("at", { refresh_token: "rt", id_token: "idt", scope: "openid email", token_type: "bearer" })],
    });
    const t = await exchangeCode("the-code", "the-verifier", fetch);
    expect(t).toEqual({ access_token: "at", expires_in: 3599, refresh_token: "rt", id_token: "idt", scope: "openid email", token_type: "Bearer" });
    const body = new URLSearchParams(calls[0]?.body ?? "");
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://aria-test.vercel.app/api/google/callback",
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "csecret",
      code_verifier: "the-verifier",
    });
  });

  it("exchangeCode without a verifier omits code_verifier; invalid_grant is a GoogleApiError (bad code, not revocation)", async () => {
    const { fetch, calls } = scriptedFetch({ [TOKEN_URL]: [() => json(400, { error: "invalid_grant" })] });
    const err = await exchangeCode("c", null, fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).not.toBeInstanceOf(GoogleAuthRevokedError);
    expect(err).toMatchObject({ status: 400, reason: "invalid_grant", retryable: false });
    expect(calls[0]?.body).not.toContain("code_verifier");
    expect((err as Error).message).not.toContain("c&");
  });

  it("refreshAccessToken maps invalid_grant / admin_policy_enforced / 5xx / bad shape", async () => {
    const a = scriptedFetch({ [TOKEN_URL]: [() => json(400, { error: "invalid_grant" })] });
    await expect(refreshAccessToken("rt", a.fetch)).rejects.toMatchObject({ name: "GoogleAuthRevokedError", kind: "invalid_grant" });
    const b = scriptedFetch({ [TOKEN_URL]: [() => json(400, { error: "invalid_grant", error_subtype: "admin_policy_enforced" })] });
    await expect(refreshAccessToken("rt", b.fetch)).rejects.toMatchObject({ kind: "admin_policy_enforced" });
    const c = scriptedFetch({ [TOKEN_URL]: [() => json(502, {})] });
    await expect(refreshAccessToken("rt", c.fetch)).rejects.toMatchObject({ name: "GoogleApiError", retryable: true });
    const d = scriptedFetch({ [TOKEN_URL]: [() => json(200, { access_token: "x" })] });
    await expect(refreshAccessToken("rt", d.fetch)).rejects.toMatchObject({ reason: "invalid_response" });
    const e = scriptedFetch({
      [TOKEN_URL]: [
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    });
    await expect(refreshAccessToken("rt", e.fetch)).rejects.toMatchObject({ reason: "network", retryable: true });
  });

  it("revokeToken: 200 ok, 400 invalid_token ok, 500 throws", async () => {
    const ok = scriptedFetch({ [REVOKE_URL]: [() => new Response("", { status: 200 })] });
    await expect(revokeToken("rt", ok.fetch)).resolves.toBeUndefined();
    expect(ok.calls[0]?.body).toBe("token=rt");
    const gone = scriptedFetch({ [REVOKE_URL]: [() => json(400, { error: "invalid_token" })] });
    await expect(revokeToken("rt", gone.fetch)).resolves.toBeUndefined();
    const bad = scriptedFetch({ [REVOKE_URL]: [() => json(500, {})] });
    await expect(revokeToken("rt", bad.fetch)).rejects.toBeInstanceOf(GoogleApiError);
  });
});

describe("beginGoogleOAuth / checkGoogleCallback", () => {
  const USER = "8a1c0e4e-2b1f-4f5e-9a59-3f0f1b2c3d4e";
  const RAW = "raw-session";

  it("builds the Google URL + cookie, and the callback binding round-trips", () => {
    const now = 1_800_000_000_000;
    const { url, cookie } = beginGoogleOAuth({ userId: USER, rawSessionId: RAW, now });
    const q = new URL(url).searchParams;
    expect(q.get("redirect_uri")).toBe("https://aria-test.vercel.app/api/google/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(cookie).toMatchObject({ name: OAUTH_COOKIE_NAME, options: { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 } });
    expect(cookie.value).not.toContain(RAW);

    const ok = checkGoogleCallback({ state: q.get("state"), cookieValue: cookie.value, session: { userId: USER, rawSessionId: RAW }, now: now + 1000 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload).toMatchObject({ u: USER, r: "/setup", e: now + 600_000 });
      expect(ok.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(checkGoogleCallback({ state: q.get("state"), cookieValue: cookie.value, session: { userId: USER, rawSessionId: "other" }, now })).toEqual({
      ok: false,
      reason: "session_mismatch",
    });
  });

  it("GOOGLE_PKCE=off drops the challenge and stores a null verifier", () => {
    process.env.GOOGLE_PKCE = "off";
    try {
      const { url, cookie } = beginGoogleOAuth({ userId: USER, rawSessionId: RAW });
      const q = new URL(url).searchParams;
      expect(q.has("code_challenge")).toBe(false);
      const r = checkGoogleCallback({ state: q.get("state"), cookieValue: cookie.value, session: { userId: USER, rawSessionId: RAW } });
      expect(r.ok && r.verifier).toBeNull();
    } finally {
      delete process.env.GOOGLE_PKCE;
    }
  });
});
