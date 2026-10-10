/**
 * `googleFetch` + token layer against scripted HTTP (V2-07 §10 `http.test.ts`):
 * 401 → refresh → 200 (persisted), backoff, retry exhaustion, invalid_grant, schema mismatch,
 * per-user refresh lock, and no token in any log line or error message.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { decryptSecret } from "@/server/security/crypto";
import { GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { buildGoogleUrl, googleFetch, googleFetchNoContent, type GoogleFetchDeps } from "@/server/integrations/google/http";
import { getGoogleAccess, type GoogleTokenDeps } from "@/server/integrations/google/tokens";
import { apiError, googleRow, json, MemoryStore, scriptedFetch, TOKEN_URL, tokenOk } from "./fakes";

const key = randomBytes(32);
const API = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const Schema = z.object({ items: z.array(z.object({ id: z.string() })) });
const USER = "user-1";

const logged: string[] = [];
beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  for (const m of ["log", "info", "warn", "error"] as const) {
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterAll(() => {
  jest.restoreAllMocks();
  // No token value may ever reach a log line.
  for (const line of logged) expect(line).not.toMatch(/at-old|at-new|rt-1|rt-2|test-client-secret/);
});

function setup(rowOver: Parameters<typeof googleRow>[1] = {}) {
  const store = new MemoryStore(googleRow(key, rowOver));
  const unavailable: string[] = [];
  const sleeps: number[] = [];
  const tokens: Omit<GoogleTokenDeps, "fetch"> = {
    store,
    key,
    onUnavailable: async (_u, why) => {
      unavailable.push(why);
      if (store.row) store.row = { ...store.row, status: "revoked", enc_access_token: null, enc_refresh_token: null };
    },
  };
  const deps = (f: typeof fetch): GoogleFetchDeps => ({
    fetch: f,
    tokens,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { store, unavailable, sleeps, deps, tokens };
}

describe("buildGoogleUrl", () => {
  it("appends query params, repeats arrays, skips undefined", () => {
    const u = buildGoogleUrl({ url: API, query: { maxResults: 10, showDeleted: false, labelIds: ["A", "B"], pageToken: undefined } });
    expect(u.toString()).toBe(`${API}?maxResults=10&showDeleted=false&labelIds=A&labelIds=B`);
  });

  it("refuses non-Google and non-HTTPS URLs", () => {
    expect(() => buildGoogleUrl({ url: "https://evil.example/x" })).toThrow(GoogleApiError);
    expect(() => buildGoogleUrl({ url: "https://googleapis.com.evil.example/x" })).toThrow(GoogleApiError);
    expect(() => buildGoogleUrl({ url: "http://www.googleapis.com/x" })).toThrow(GoogleApiError);
  });
});

describe("googleFetch", () => {
  it("uses the stored token when fresh and validates the response", async () => {
    const { deps } = setup();
    const { fetch, calls } = scriptedFetch({ [API]: [() => json(200, { items: [{ id: "primary" }] })] });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).resolves.toEqual({ items: [{ id: "primary" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe("Bearer at-old");
  });

  it("sends a JSON body with POST", async () => {
    const { deps } = setup();
    const { fetch, calls } = scriptedFetch({ [API]: [() => json(200, { items: [] })] });
    await googleFetch(USER, { method: "POST", url: API, body: { summary: "Aria" } }, Schema, deps(fetch));
    expect(calls[0]).toMatchObject({ method: "POST", body: JSON.stringify({ summary: "Aria" }) });
  });

  it("refreshes before use when the token expires within 5 minutes, and persists it encrypted", async () => {
    const { deps, store } = setup({ expiresInMs: 4 * 60_000 });
    const { fetch, calls } = scriptedFetch({
      [TOKEN_URL]: [() => tokenOk("at-new")],
      [API]: [() => json(200, { items: [] })],
    });
    await googleFetch(USER, { url: API }, Schema, deps(fetch));
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, API]);
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
    expect(calls[0]?.body).toContain("refresh_token=rt-1");
    expect(calls[1]?.auth).toBe("Bearer at-new");
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.patch.enc_access_token).toMatch(/^v1:/);
    expect(decryptSecret(store.row?.enc_access_token as string, key)).toBe("at-new");
    expect(store.saves[0]?.patch.enc_refresh_token).toBeUndefined();
  });

  it("401 → force refresh once → 200, refresh persisted", async () => {
    const { deps, store } = setup();
    const { fetch, calls } = scriptedFetch({
      [TOKEN_URL]: [() => tokenOk("at-new")],
      [API]: [() => apiError(401, "authError"), () => json(200, { items: [] })],
    });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).resolves.toEqual({ items: [] });
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      [API, "Bearer at-old"],
      [TOKEN_URL, null],
      [API, "Bearer at-new"],
    ]);
    expect(decryptSecret(store.row?.enc_access_token as string, key)).toBe("at-new");
  });

  it("a second 401 after the refresh is an error (no refresh loop)", async () => {
    const { deps } = setup();
    const { fetch, calls } = scriptedFetch({
      [TOKEN_URL]: [() => tokenOk("at-new")],
      [API]: [() => apiError(401, "authError")],
    });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).rejects.toMatchObject({ status: 401, retryable: false });
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it("persists a rotated refresh token", async () => {
    const { deps, store } = setup({ expiresInMs: 0 });
    const { fetch } = scriptedFetch({
      [TOKEN_URL]: [() => tokenOk("at-new", { refresh_token: "rt-2" })],
      [API]: [() => json(200, { items: [] })],
    });
    await googleFetch(USER, { url: API }, Schema, deps(fetch));
    expect(decryptSecret(store.row?.enc_refresh_token as string, key)).toBe("rt-2");
  });

  it("429 → backoff → 200 (Retry-After honoured)", async () => {
    const { deps, sleeps } = setup();
    const { fetch, calls } = scriptedFetch({
      [API]: [() => apiError(429, "rateLimitExceeded"), () => json(429, {}, { "retry-after": "3" }), () => json(200, { items: [] })],
    });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).resolves.toEqual({ items: [] });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 3000]);
  });

  it("403 userRateLimitExceeded is retried; 403 forbidden is not", async () => {
    const a = setup();
    const r1 = scriptedFetch({ [API]: [() => apiError(403, "userRateLimitExceeded"), () => json(200, { items: [] })] });
    await expect(googleFetch(USER, { url: API }, Schema, a.deps(r1.fetch))).resolves.toEqual({ items: [] });
    const b = setup();
    const r2 = scriptedFetch({ [API]: [() => apiError(403, "insufficientPermissions")] });
    await expect(googleFetch(USER, { url: API }, Schema, b.deps(r2.fetch))).rejects.toMatchObject({
      status: 403,
      reason: "insufficientPermissions",
      retryable: false,
    });
    expect(r2.calls).toHaveLength(1);
  });

  it("500 ×3 → GoogleApiError(retryable) after exactly 3 tries", async () => {
    const { deps, sleeps } = setup();
    const { fetch, calls } = scriptedFetch({ [API]: [() => apiError(500, "backendError")] });
    const err = await googleFetch(USER, { url: API }, Schema, deps(fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ status: 500, reason: "backendError", retryable: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 2000]);
  });

  it("jitter scales the backoff by up to 1.3x", async () => {
    const { tokens } = setup();
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch({ [API]: [() => apiError(503, "backendError"), () => json(200, { items: [] })] });
    await googleFetch(USER, { url: API }, Schema, {
      fetch,
      tokens,
      random: () => 0.999,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThanOrEqual(650);
  });

  it("network errors are retried", async () => {
    const { deps } = setup();
    const { fetch, calls } = scriptedFetch({
      [API]: [
        () => {
          throw new TypeError("fetch failed");
        },
        () => json(200, { items: [] }),
      ],
    });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).resolves.toEqual({ items: [] });
    expect(calls).toHaveLength(2);
  });

  it("404 is a non-retryable GoogleApiError", async () => {
    const { deps } = setup();
    const { fetch, calls } = scriptedFetch({ [API]: [() => apiError(404, "notFound")] });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).rejects.toMatchObject({ status: 404, reason: "notFound", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("a schema mismatch throws (never silent)", async () => {
    const { deps } = setup();
    const { fetch } = scriptedFetch({ [API]: [() => json(200, { items: [{ id: 42 }] })] });
    const err = await googleFetch(USER, { url: API }, Schema, deps(fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ reason: "invalid_response", retryable: false });
    expect((err as Error).message).toContain("items.0.id");
  });

  it("non-JSON 200 throws invalid_response", async () => {
    const { deps } = setup();
    const { fetch } = scriptedFetch({ [API]: [() => new Response("<html>", { status: 200 })] });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).rejects.toMatchObject({ reason: "invalid_response" });
  });

  it("error messages never contain the query string or the token", async () => {
    const { deps } = setup();
    const { fetch } = scriptedFetch({ [API]: [() => apiError(400, "badRequest")] });
    const err = (await googleFetch(USER, { url: API, query: { q: "secret-search" } }, Schema, deps(fetch)).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("GET www.googleapis.com/calendar/v3/users/me/calendarList failed (400 badRequest)");
  });
});

describe("refresh failures", () => {
  it("400 invalid_grant on refresh → GoogleAuthRevokedError and the unavailable hook runs once", async () => {
    const { deps, unavailable, store } = setup({ expiresInMs: 0 });
    const { fetch, calls } = scriptedFetch({
      [TOKEN_URL]: [() => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })],
    });
    const err = await googleFetch(USER, { url: API }, Schema, deps(fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthRevokedError);
    expect(err).toMatchObject({ kind: "invalid_grant" });
    expect(unavailable).toEqual(["invalid_grant"]);
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    // Subsequent calls see a revoked row → not connected, no further token calls.
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).rejects.toBeInstanceOf(GoogleNotConnectedError);
    expect(calls).toHaveLength(1);
    expect(store.row?.status).toBe("revoked");
  });

  it("admin_policy_enforced → GoogleAuthRevokedError(admin_policy_enforced)", async () => {
    const { deps, unavailable } = setup({ expiresInMs: 0 });
    const { fetch } = scriptedFetch({ [TOKEN_URL]: [() => json(400, { error: "admin_policy_enforced" })] });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).rejects.toMatchObject({ kind: "admin_policy_enforced" });
    expect(unavailable).toEqual(["admin_policy_enforced"]);
  });

  it("invalid_grant after another instance rotated the refresh token → retry with the new one", async () => {
    const { deps, store, unavailable } = setup({ expiresInMs: 0 });
    const { fetch, calls } = scriptedFetch({
      [TOKEN_URL]: [
        () => {
          // Simulate the other instance persisting rt-2 while our rt-1 request was in flight.
          const rotated = googleRow(key, { refresh: "rt-2", expiresInMs: 0 });
          store.row = { ...rotated, enc_access_token: store.row?.enc_access_token ?? null };
          return json(400, { error: "invalid_grant" });
        },
        () => tokenOk("at-new"),
      ],
      [API]: [() => json(200, { items: [] })],
    });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).resolves.toEqual({ items: [] });
    expect(unavailable).toEqual([]);
    expect(calls.filter((c) => c.url === TOKEN_URL).map((c) => c.body?.includes("refresh_token=rt-2"))).toEqual([false, true]);
  });

  it("token endpoint 503 → retryable GoogleApiError, row untouched", async () => {
    const { deps, unavailable, store } = setup({ expiresInMs: 0 });
    const { fetch } = scriptedFetch({ [TOKEN_URL]: [() => json(503, {})] });
    await expect(googleFetch(USER, { url: API }, Schema, deps(fetch))).rejects.toMatchObject({ status: 503, retryable: true });
    expect(unavailable).toEqual([]);
    expect(store.row?.status).toBe("active");
  });
});

describe("getGoogleAccess", () => {
  it("throws GoogleNotConnectedError for no row, a revoked row, or a missing feature scope", async () => {
    const deps: GoogleTokenDeps = { store: new MemoryStore(null), key };
    await expect(getGoogleAccess(USER, { deps })).rejects.toBeInstanceOf(GoogleNotConnectedError);
    const revoked: GoogleTokenDeps = { store: new MemoryStore(googleRow(key, { status: "revoked" })), key };
    await expect(getGoogleAccess(USER, { deps: revoked })).rejects.toBeInstanceOf(GoogleNotConnectedError);
    const ok: GoogleTokenDeps = { store: new MemoryStore(googleRow(key)), key };
    await expect(getGoogleAccess(USER, { require: "gmail_send", deps: ok })).rejects.toMatchObject({ feature: "gmail_send" });
    await expect(getGoogleAccess(USER, { require: "gmail_read", deps: ok })).resolves.toMatchObject({ accessToken: "at-old" });
  });

  it("per-user refresh lock: 10 concurrent callers → one token request", async () => {
    const store = new MemoryStore(googleRow(key, { expiresInMs: 0 }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetch, calls } = scriptedFetch({
      [TOKEN_URL]: [
        async () => {
          await gate;
          return tokenOk("at-new");
        },
      ],
    });
    const deps: GoogleTokenDeps = { store, key, fetch };
    const all = Promise.all(Array.from({ length: 10 }, () => getGoogleAccess(USER, { deps })));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await all;
    expect(results.every((r) => r.accessToken === "at-new")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(store.saves).toHaveLength(1);
  });

  it("forced refresh with a stale token reuses a token another caller already refreshed", async () => {
    const store = new MemoryStore(googleRow(key, { access: "at-new" }));
    const { fetch, calls } = scriptedFetch({ [TOKEN_URL]: [() => tokenOk("at-newer")] });
    const deps: GoogleTokenDeps = { store, key, fetch };
    await expect(getGoogleAccess(USER, { forceRefresh: true, staleAccessToken: "at-old", deps })).resolves.toMatchObject({ accessToken: "at-new" });
    expect(calls).toHaveLength(0);
    await expect(getGoogleAccess(USER, { forceRefresh: true, staleAccessToken: "at-new", deps })).resolves.toMatchObject({ accessToken: "at-newer" });
    await expect(getGoogleAccess(USER, { forceRefresh: true, deps })).resolves.toBeDefined();
    expect(calls).toHaveLength(2);
  });

  it("a refresh that finishes after a disconnect does not resurrect the row", async () => {
    const store = new MemoryStore(googleRow(key, { expiresInMs: 0 }));
    const { fetch } = scriptedFetch({
      [TOKEN_URL]: [
        () => {
          if (store.row) store.row = { ...store.row, status: "disconnected" };
          return tokenOk("at-new");
        },
      ],
    });
    await expect(getGoogleAccess(USER, { deps: { store, key, fetch } })).rejects.toBeInstanceOf(GoogleNotConnectedError);
  });
});

describe("googleFetchNoContent", () => {
  it("accepts 204 and retries 503", async () => {
    const { deps } = setup();
    const { fetch, calls } = scriptedFetch({ [API]: [() => json(503, {}), () => new Response(null, { status: 204 })] });
    await expect(googleFetchNoContent(USER, { method: "DELETE", url: API }, deps(fetch))).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
  });
});
