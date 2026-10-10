/**
 * Google core smoke (task 2.4; V2-07 §10 smoke items 1–3, 7 + 07a-2 token criteria).
 *
 * Real DB (LOCAL Supabase stack by default; `SMOKE_TARGET=env` uses the env project), fake Google:
 * the token endpoint and the JWKS are served by an injected `fetch`, and the `id_token` is signed
 * with a locally generated RSA key. `deliver` is replaced by a counter here (the real one is
 * gate-tested once task 2.1 lands). Throwaway users (and everything hanging off them) are deleted
 * in afterAll.
 *
 * Covers: completeConnect upsert (encrypted tokens) + read-back, account-in-use refusal + the
 * unique index, lookups by email / channel id, refresh persistence + rotation, the per-user
 * refresh lock, invalid_grant → revoked + tokens wiped + Google jobs cancelled + exactly ONE
 * notice under concurrency, reconnect resetting the claim (and keeping the Gmail cursor),
 * admin_policy_enforced, and getGoogleStatus shapes. No token may appear in any log line.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import type { Database } from "@/server/db/types";

// ── Target selection (before any server module calls db()) ─────────────────
function localTarget(): { url: string; serviceKey: string } {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL as string, serviceKey: s.SERVICE_ROLE_KEY as string };
}
function envTarget(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SMOKE_TARGET=env needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return { url, serviceKey };
}
const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
const APP_KEY = randomBytes(32);
process.env.APP_ENCRYPTION_KEY = APP_KEY.toString("base64");
process.env.GOOGLE_CLIENT_ID = "smoke-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "smoke-client-secret";

// `deliver` is task 2.1's; count calls here (module boundary, not a call chain).
const delivered: { userId: string; reason: string; dedupeKey?: string; proactive: boolean; texts: string[] }[] = [];
jest.mock("@/server/channels/deliver", () => ({
  deliver: jest.fn(
    async (userId: string, plan: { bubbles: { text: string }[] }, opts: { reason: string; dedupeKey?: string; proactive: boolean }) => {
      await new Promise((r) => setTimeout(r, 20));
      delivered.push({ userId, reason: opts.reason, dedupeKey: opts.dedupeKey, proactive: opts.proactive, texts: plan.bubbles.map((b) => b.text) });
      return { status: "queued", jobId: "smoke", runAt: new Date() };
    },
  ),
}));

import { decryptSecret } from "@/server/security/crypto";
import { GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { completeConnect, type TokenResponse } from "@/server/integrations/google/oauth/flow";
import { getGoogleStatus } from "@/server/integrations/google/status";
import {
  findIntegrationByAccountEmail,
  findIntegrationByChannelId,
  getGoogleIntegration,
  updateGoogleIntegration,
} from "@/server/integrations/google/store";
import { getGoogleAccess, markGoogleUnavailable } from "@/server/integrations/google/tokens";

const sb: SupabaseClient<Database> = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN = randomUUID().slice(0, 8);
const EMAIL = `smoke-google-${RUN}@example.edu`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const userIds: string[] = [];
const logged: string[] = [];

let signingKey: CryptoKey;
let jwks: { keys: JWK[] };
let userA = "";
let userB = "";

/** Fake Google: JWKS + a scripted token endpoint. */
function fakeGoogle(tokenResponder: (body: URLSearchParams) => Response | Promise<Response>) {
  const tokenCalls: URLSearchParams[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === JWKS_URL) return Response.json(jwks);
    if (url === TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      tokenCalls.push(body);
      return tokenResponder(body);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch: f, tokenCalls };
}

async function idToken(email: string, verified = true): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: verified })
    .setProtectedHeader({ alg: "RS256", kid: "smoke" })
    .setIssuer("https://accounts.google.com")
    .setAudience(process.env.GOOGLE_CLIENT_ID as string)
    .setSubject(`sub-${RUN}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);
}

const ALL_SCOPES =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events.readonly " +
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created " +
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

async function tokens(over: Partial<TokenResponse> & { email?: string; verified?: boolean } = {}): Promise<TokenResponse> {
  const { email = EMAIL, verified = true, ...rest } = over;
  return {
    access_token: `at-connect-${RUN}`,
    expires_in: 3599,
    refresh_token: `rt-connect-${RUN}`,
    scope: ALL_SCOPES,
    id_token: await idToken(email, verified),
    token_type: "Bearer",
    ...rest,
  };
}

async function makeUser(): Promise<string> {
  const { data, error } = await sb.from("users").insert({ name: `smoke-google-${RUN}` }).select("id").single();
  if (error) throw new Error(error.message);
  userIds.push(data.id);
  return data.id;
}

async function expire(userId: string) {
  const row = await getGoogleIntegration(userId);
  await updateGoogleIntegration(row?.id as string, { token_expires_at: new Date(Date.now() - 1000).toISOString() });
}

beforeAll(async () => {
  for (const m of ["log", "info", "warn", "error"] as const) {
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    });
  }
  const kp = await generateKeyPair("RS256", { extractable: true });
  signingKey = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "smoke", alg: "RS256", use: "sig" }] };
  userA = await makeUser();
  userB = await makeUser();
});

afterAll(async () => {
  jest.restoreAllMocks();
  const errors: string[] = [];
  if (userIds.length) {
    const j = await sb.from("jobs").delete().in("user_id", userIds);
    if (j.error) errors.push(j.error.message);
    const i = await sb.from("integrations").delete().in("user_id", userIds);
    if (i.error) errors.push(i.error.message);
    const u = await sb.from("users").delete().in("id", userIds);
    if (u.error) errors.push(u.error.message);
  }
  const { count } = await sb.from("integrations").select("id", { count: "exact", head: true }).ilike("account_email", `%${RUN}%`);
  if (count) errors.push(`${count} integration rows left behind`);
  // No token, secret or code may ever reach a log line.
  const leaks = logged.filter((l) => /at-|rt-|smoke-client-secret|eyJ/.test(l));
  if (leaks.length) errors.push(`token-like value logged: ${leaks.length} line(s)`);
  if (errors.length) throw new Error(`google smoke cleanup/log check: ${errors.join("; ")}`);
});

describe("google core (local DB, fake Google)", () => {
  it("completeConnect writes an encrypted active row that reads back", async () => {
    const { fetch } = fakeGoogle(() => new Response("", { status: 500 }));
    const res = await completeConnect({ userId: userA, tokens: await tokens({ email: EMAIL.toUpperCase() }), fetch });
    expect(res).toEqual({
      ok: true,
      integrationId: expect.any(String),
      accountEmail: EMAIL,
      features: ["calendar_read", "calendar_write", "gmail_read", "gmail_send"],
    });

    const row = await getGoogleIntegration(userA);
    expect(row).toMatchObject({ provider: "google", status: "active", account_email: EMAIL, status_notified_at: null });
    expect(row?.scopes).toContain("email");
    expect(row?.enc_access_token).toMatch(/^v1:/);
    expect(row?.enc_refresh_token).toMatch(/^v1:/);
    expect(decryptSecret(row?.enc_refresh_token as string, APP_KEY)).toBe(`rt-connect-${RUN}`);
    expect(new Date(row?.token_expires_at as string).getTime()).toBeGreaterThan(Date.now() + 3500_000);

    const status = await getGoogleStatus(userA);
    expect(status).toMatchObject({ connected: true, email: EMAIL, canReadMail: true, canSendMail: true, canReadCalendar: true, canWriteAriaCalendar: true });
    expect(status.connected && status.connectedAt).toBeInstanceOf(Date);
  });

  it("refuses: unverified email, missing required scopes, no refresh token, account in use", async () => {
    const { fetch } = fakeGoogle(() => new Response("", { status: 500 }));
    await expect(completeConnect({ userId: userB, tokens: await tokens({ email: `other-${RUN}@example.edu`, verified: false }), fetch })).resolves.toEqual({
      ok: false,
      reason: "email_unverified",
    });
    await expect(
      completeConnect({ userId: userB, tokens: await tokens({ email: `other-${RUN}@example.edu`, scope: "openid email https://www.googleapis.com/auth/gmail.readonly" }), fetch }),
    ).resolves.toEqual({ ok: false, reason: "missing_required_scopes" });
    await expect(
      completeConnect({ userId: userB, tokens: await tokens({ email: `other-${RUN}@example.edu`, refresh_token: undefined }), fetch }),
    ).resolves.toEqual({ ok: false, reason: "no_refresh_token" });
    await expect(completeConnect({ userId: userB, tokens: await tokens(), fetch })).resolves.toEqual({ ok: false, reason: "account_in_use" });
    expect(await getGoogleIntegration(userB)).toBeNull();

    // The unique index backs the refusal (race path): lower(account_email) where not disconnected.
    const dup = await sb.from("integrations").insert({ user_id: userB, provider: "google", account_email: EMAIL.toUpperCase(), status: "active" });
    expect(dup.error?.code).toBe("23505");
  });

  it("looks rows up by account email (any case) and by calendar channel id", async () => {
    const row = await getGoogleIntegration(userA);
    expect((await findIntegrationByAccountEmail(` ${EMAIL.toUpperCase()} `))?.id).toBe(row?.id);
    expect(await findIntegrationByAccountEmail(`nobody-${RUN}@example.edu`)).toBeNull();
    const channel = `smoke-chan-${RUN}`;
    await updateGoogleIntegration(row?.id as string, { gcal_channel_id: channel, gmail_history_id: "12345", user_id: userB });
    expect((await findIntegrationByChannelId(channel))?.user_id).toBe(userA); // user_id in a patch is ignored
    expect(await findIntegrationByChannelId(`missing-${RUN}`)).toBeNull();
  });

  it("refresh-before-use persists encrypted tokens + rotation, under a per-user lock", async () => {
    await expire(userA);
    let n = 0;
    const g = fakeGoogle(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 50));
      return Response.json({ access_token: `at-fresh-${RUN}`, expires_in: 3599, refresh_token: `rt-rotated-${RUN}`, scope: ALL_SCOPES, token_type: "Bearer" });
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => getGoogleAccess(userA, { deps: { fetch: g.fetch } })));
    expect(results.map((r) => r.accessToken)).toEqual(Array(6).fill(`at-fresh-${RUN}`));
    expect(n).toBe(1);
    expect(g.tokenCalls[0]?.get("refresh_token")).toBe(`rt-connect-${RUN}`);

    const row = await getGoogleIntegration(userA);
    expect(decryptSecret(row?.enc_access_token as string, APP_KEY)).toBe(`at-fresh-${RUN}`);
    expect(decryptSecret(row?.enc_refresh_token as string, APP_KEY)).toBe(`rt-rotated-${RUN}`);
    expect(new Date(row?.token_expires_at as string).getTime()).toBeGreaterThan(Date.now() + 3500_000);

    // Fresh now → no token call.
    await expect(getGoogleAccess(userA, { deps: { fetch: g.fetch } })).resolves.toMatchObject({ accessToken: `at-fresh-${RUN}` });
    expect(n).toBe(1);
    await expect(getGoogleAccess(userA, { require: "gmail_send", deps: { fetch: g.fetch } })).resolves.toBeDefined();
  });

  it("invalid_grant → revoked, tokens wiped, Google jobs cancelled, exactly one notice", async () => {
    const farFuture = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { data: jobs, error } = await sb
      .from("jobs")
      .insert([
        { kind: "gcal_sync", user_id: userA, run_at: farFuture, payload: { reason: "periodic" } },
        { kind: "gmail_history_sync", user_id: userA, run_at: farFuture, payload: { reason: "periodic" } },
        { kind: "reminder_fire", user_id: userA, run_at: farFuture, payload: {} },
      ])
      .select("id, kind");
    if (error) throw new Error(error.message);

    await expire(userA);
    const g = fakeGoogle(() => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
    const settled = await Promise.allSettled([
      getGoogleAccess(userA, { deps: { fetch: g.fetch } }),
      getGoogleAccess(userA, { deps: { fetch: g.fetch } }),
      getGoogleAccess(userA, { deps: { fetch: g.fetch } }),
    ]);
    for (const s of settled) {
      expect(s.status).toBe("rejected");
      if (s.status === "rejected") expect(s.reason).toBeInstanceOf(GoogleAuthRevokedError);
    }
    // A second wave (another invocation) and direct repeat calls must not notify again.
    await Promise.all([markGoogleUnavailable(userA, "invalid_grant"), markGoogleUnavailable(userA, "invalid_grant")]);

    const row = await getGoogleIntegration(userA);
    expect(row).toMatchObject({ status: "revoked", status_reason: "invalid_grant", enc_access_token: null, enc_refresh_token: null, token_expires_at: null });
    expect(row?.status_notified_at).not.toBeNull();

    const notices = delivered.filter((d) => d.userId === userA);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ reason: "google_revoked", proactive: true });
    expect(notices[0]?.dedupeKey).toMatch(new RegExp(`^google_unavailable:${row?.id}:\\d+$`));
    expect(notices[0]?.texts.join(" ")).not.toMatch(/https?:\/\//); // offers a link, never sends one

    const after = await sb.from("jobs").select("kind, status, last_error").in("id", (jobs ?? []).map((j) => j.id));
    const byKind = Object.fromEntries((after.data ?? []).map((j) => [j.kind, j]));
    expect(byKind.gcal_sync).toMatchObject({ status: "done", last_error: "cancelled" });
    expect(byKind.gmail_history_sync).toMatchObject({ status: "done", last_error: "cancelled" });
    expect(byKind.reminder_fire).toMatchObject({ status: "pending" });

    await expect(getGoogleAccess(userA, { deps: { fetch: g.fetch } })).rejects.toBeInstanceOf(GoogleNotConnectedError);
    expect(await getGoogleStatus(userA)).toEqual({ connected: false, reason: "revoked" });
  });

  it("reconnect resets the notice claim and keeps the Gmail cursor; admin block notifies once more", async () => {
    const { fetch } = fakeGoogle(() => new Response("", { status: 500 }));
    await new Promise((r) => setTimeout(r, 5)); // distinct connected_at
    const res = await completeConnect({ userId: userA, tokens: await tokens(), fetch });
    expect(res.ok).toBe(true);
    const row = await getGoogleIntegration(userA);
    expect(row).toMatchObject({ status: "active", status_reason: null, status_notified_at: null, gmail_history_id: "12345", gcal_channel_id: null });

    // A stale failure carrying the OLD refresh-token ciphertext must not clobber the reconnect.
    await markGoogleUnavailable(userA, "invalid_grant", { expectEncRefreshToken: "v1:not-the-current-one" });
    expect((await getGoogleIntegration(userA))?.status).toBe("active");

    await markGoogleUnavailable(userA, "admin_policy_enforced");
    expect(await getGoogleIntegration(userA)).toMatchObject({ status: "error", status_reason: "admin_blocked", enc_refresh_token: null });
    expect(await getGoogleStatus(userA)).toEqual({ connected: false, reason: "error" });
    const notices = delivered.filter((d) => d.userId === userA);
    expect(notices).toHaveLength(2);
    expect(notices[1]?.dedupeKey).not.toBe(notices[0]?.dedupeKey);
    expect(notices[1]?.texts.join(" ")).toContain("admin");
  });

  it("a different account on reconnect resets the cursor; status none without a row", async () => {
    const { fetch } = fakeGoogle(() => new Response("", { status: 500 }));
    const other = `second-${RUN}@example.edu`;
    const res = await completeConnect({ userId: userA, tokens: await tokens({ email: other }), fetch });
    expect(res).toMatchObject({ ok: true, accountEmail: other });
    expect(await getGoogleIntegration(userA)).toMatchObject({ account_email: other, gmail_history_id: null });
    // The first address is free again.
    expect(await findIntegrationByAccountEmail(EMAIL)).toBeNull();
    expect(await getGoogleStatus(userB)).toEqual({ connected: false, reason: "none" });
  });
});
