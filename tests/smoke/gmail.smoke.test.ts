/**
 * Gmail base smoke (task 2.5; V2-07 §10 smoke items 4–5 + 07b-2 criteria).
 *
 * Real DB, fake Gmail: a throwaway user + Google integration (fake encrypted tokens that never
 * need a refresh) on the LOCAL Supabase stack, with Gmail's REST API served by an injected
 * `fetch` at the HTTP boundary (`googleFetch` deps) — nothing reaches Google. Covers:
 * - `advance_gmail_cursor`: forward-only, numeric ordering ("999" < "2000"), CAS reset, CAS-from-null
 * - history sync: NULL cursor seeding, paging, insert-dedupe (no duplicate `email_items`),
 *   metadata stored without bodies, cursor never regresses, failure → no advance → retry
 * - 404 → resync with force-CAS
 * - watch renewal never clobbers a non-NULL cursor; start/stop schedules + teardown
 * - push handler: OIDC (local JWKS), unknown mailbox → 204 no job, valid → exactly one job
 *
 * Set `SMOKE_TARGET=env` to use NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY instead of
 * `supabase status`. Everything hangs off the throwaway user and is deleted in afterAll.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}
function envTarget(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SMOKE_TARGET=env needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  return { url, serviceKey };
}
const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
// Throwaway token-encryption key for this run (the fake tokens are encrypted with it).
const savedAppKey = process.env.APP_ENCRYPTION_KEY;
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// Server modules read env lazily, so importing after the assignment is safe.
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { encryptSecret, parseKey } from "@/server/security/crypto";
import { SCOPES } from "@/server/integrations/google/config";
import {
  advanceGmailCursor,
  renewGmailWatchIfActive,
  runHistorySync,
  startGmailWatch,
  stopGmailWatch,
} from "@/server/integrations/google/gmail/sync";
import { insertEmailItems } from "@/server/integrations/google/gmail/ingest";
import { handleGmailPush } from "@/server/integrations/google/gmail/push";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN = randomUUID().slice(0, 8);
const MAILBOX = `smoke-gmail-${RUN}@example.com`;
const PUSH_ENV = ["GMAIL_PUBSUB_TOPIC", "GMAIL_PUSH_SERVICE_ACCOUNT", "GMAIL_PUSH_AUDIENCE", "GMAIL_PUSH_SUBSCRIPTION"] as const;
const savedEnv: Record<string, string | undefined> = {};
let userId = "";
let integrationId = "";

// ── Fake Gmail (the HTTP boundary) ──────────────────────────────────────────
type MsgSpec = { from: string; subject: string; labels: string[]; unsubscribe?: boolean } | { status: number };
interface FakeGmail {
  profileHistoryId: string;
  /** key: `${startHistoryId}|${pageToken ?? ""}` → JSON body or a status code */
  history: Map<string, Record<string, unknown> | number>;
  messages: Map<string, MsgSpec>;
  listIds: string[];
  watchHistoryId: string;
  calls: string[];
}
const gmail: FakeGmail = {
  profileHistoryId: "1000",
  history: new Map(),
  messages: new Map(),
  listIds: [],
  watchHistoryId: "1",
  calls: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gErr = (status: number) => json({ error: { code: status, message: "fake", errors: [{ reason: "fake" }] } }, status);

function messageJson(id: string, m: Exclude<MsgSpec, { status: number }>) {
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: MAILBOX },
    { name: "Subject", value: m.subject },
    { name: "Message-ID", value: `<${id}@mail.example.com>` },
    ...(m.unsubscribe ? [{ name: "List-Unsubscribe", value: "<mailto:u@x.com>" }] : []),
  ];
  return {
    id,
    threadId: id,
    labelIds: m.labels,
    snippet: "SECRET BODY SNIPPET should never be stored",
    internalDate: String(Date.now() - 60_000),
    payload: { mimeType: "text/plain", headers },
  };
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  const path = url.pathname.replace("/gmail/v1/users/me", "");
  gmail.calls.push(`${method} ${path}`);
  if (url.host !== "gmail.googleapis.com") return gErr(400);
  if (path === "/profile") return json({ emailAddress: MAILBOX, historyId: gmail.profileHistoryId });
  if (path === "/history") {
    const key = `${url.searchParams.get("startHistoryId")}|${url.searchParams.get("pageToken") ?? ""}`;
    const r = gmail.history.get(key);
    if (r === undefined) return json({ historyId: url.searchParams.get("startHistoryId") });
    return typeof r === "number" ? gErr(r) : json(r);
  }
  if (path === "/messages" && method === "GET") return json({ messages: gmail.listIds.map((id) => ({ id, threadId: id })) });
  const mm = /^\/messages\/([0-9a-f]+)$/.exec(path);
  if (mm) {
    const spec = gmail.messages.get(mm[1]);
    if (!spec) return gErr(404);
    if ("status" in spec) return gErr(spec.status);
    return json(messageJson(mm[1], spec));
  }
  if (path === "/watch" && method === "POST") {
    return json({ historyId: gmail.watchHistoryId, expiration: String(Date.now() + 7 * 24 * 3600_000) });
  }
  if (path === "/stop" && method === "POST") return new Response(null, { status: 204 });
  return gErr(404);
};
const deps = { fetch: fakeFetch, sleep: async () => undefined };

const metaCalls = (id: string) => gmail.calls.filter((c) => c === `GET /messages/${id}`).length;

// Gmail ids are hex; they're per user, so fixed ids are fine.
const A = "a0a0a0a0a0a0a0a0"; // professor (.edu) → classify candidate (stays pending: classifier is 4.3)
const B = "b0b0b0b0b0b0b0b0"; // newsletter → skip:bulk
const C = "c0c0c0c0c0c0c0c0"; // promotions → skip:category
const G = "e0e0e0e0e0e0e0e0"; // metadata fails first
const H = "f0f0f0f0f0f0f0f0"; // resync

async function cursor(): Promise<string | null> {
  const { data, error } = await sb.from("integrations").select("gmail_history_id").eq("id", integrationId).single();
  if (error) throw new Error(error.message);
  return data.gmail_history_id;
}
async function items() {
  const { data, error } = await sb
    .from("email_items")
    .select("*")
    .eq("user_id", userId)
    .order("gmail_message_id", { ascending: true });
  if (error) throw new Error(error.message);
  return data;
}
async function pendingJobs(prefix: string) {
  const { data, error } = await sb
    .from("jobs")
    .select("id, kind, dedupe_key, payload, status, run_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .like("dedupe_key", `${prefix}%`);
  if (error) throw new Error(error.message);
  return data;
}
function clearPushEnv() {
  for (const k of PUSH_ENV) delete process.env[k];
}

beforeAll(async () => {
  for (const k of PUSH_ENV) savedEnv[k] = process.env[k];
  clearPushEnv();
  const key = parseKey(process.env.APP_ENCRYPTION_KEY ?? "");
  const { data: u, error: ue } = await sb.from("users").insert({ name: "smoke gmail" }).select("id").single();
  if (ue) throw new Error(ue.message);
  userId = u.id;
  const { data: i, error: ie } = await sb
    .from("integrations")
    .insert({
      user_id: userId,
      provider: "google",
      account_email: MAILBOX,
      scopes: [SCOPES.openid, SCOPES.email, SCOPES.calEventsRead, SCOPES.gmailRead],
      enc_access_token: encryptSecret("fake-access-token", key),
      enc_refresh_token: encryptSecret("fake-refresh-token", key),
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      status: "active",
    })
    .select("id")
    .single();
  if (ie) throw new Error(ie.message);
  integrationId = i.id;
});

afterAll(async () => {
  if (savedAppKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = savedAppKey;
  for (const k of PUSH_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  const errors: string[] = [];
  if (userId) {
    // jobs, integrations and email_items cascade from users.
    const { error } = await sb.from("users").delete().eq("id", userId);
    if (error) errors.push(error.message);
    const [{ count: ic }, { count: ec }, { count: jc }] = await Promise.all([
      sb.from("integrations").select("id", { count: "exact", head: true }).eq("user_id", userId),
      sb.from("email_items").select("id", { count: "exact", head: true }).eq("user_id", userId),
      sb.from("jobs").select("id", { count: "exact", head: true }).eq("user_id", userId),
    ]);
    expect((ic ?? 0) + (ec ?? 0) + (jc ?? 0)).toBe(0);
  }
  expect(errors).toEqual([]);
});

describe("history sync + cursor (fake Gmail, real DB)", () => {
  it("seeds a NULL cursor from getProfile and ingests nothing", async () => {
    expect(await cursor()).toBeNull();
    const r = await runHistorySync(userId, deps);
    expect(r).toMatchObject({ processed: 0, resynced: false, skipped: false });
    expect(await cursor()).toBe("1000");
    expect(await items()).toHaveLength(0);
  });

  it("follows pages, inserts each message once, stores metadata only, advances the cursor", async () => {
    gmail.messages.set(A, { from: '"Prof. Smith" <smith@yale.edu>', subject: "Office hours moved", labels: ["INBOX", "CATEGORY_PERSONAL"] });
    gmail.messages.set(B, { from: "news@company.com", subject: "Our October newsletter", labels: ["INBOX", "CATEGORY_UPDATES"], unsubscribe: true });
    gmail.messages.set(C, { from: "deals@shop.com", subject: "50% off", labels: ["INBOX", "CATEGORY_PROMOTIONS"] });
    gmail.history.set("1000|", {
      history: [{ id: "1001", messagesAdded: [{ message: { id: A } }, { message: { id: B } }] }],
      nextPageToken: "p2",
      historyId: "1050",
    });
    gmail.history.set("1000|p2", {
      history: [{ id: "1002", messagesAdded: [{ message: { id: B } }, { message: { id: C } }] }],
      historyId: "1050",
    });

    const r = await runHistorySync(userId, deps);
    expect(r).toMatchObject({ processed: 3, alerted: 0, resynced: false, backlog: false });
    expect(await cursor()).toBe("1050");
    expect(metaCalls(B)).toBe(1); // B appeared on both pages but was fetched once

    const rows = await items();
    expect(rows.map((x) => x.gmail_message_id)).toEqual([A, B, C]);
    const [a, b, c] = rows;
    expect(a).toMatchObject({
      source: "push",
      prefilter_reason: "classify:school",
      importance: null,
      classified_at: null, // classifier (4.3) not wired yet → stays pending
      from_addr: "Prof. Smith <smith@yale.edu>",
      subject: "Office hours moved",
      category: "personal",
      rfc822_message_id: `<${A}@mail.example.com>`,
      thread_id: A,
      summary: null,
    });
    expect(a.received_at).not.toBeNull();
    expect(b).toMatchObject({ prefilter_reason: "skip:bulk", importance: "skipped" });
    expect(b.classified_at).not.toBeNull();
    expect(c).toMatchObject({ prefilter_reason: "skip:category", importance: "skipped" });
    // No body / snippet anywhere in the stored rows.
    expect(JSON.stringify(rows)).not.toContain("SECRET BODY");
  });

  it("a duplicate push inserts nothing and the cursor never regresses", async () => {
    // A stale / slower concurrent run tries to move the cursor back.
    expect(await advanceGmailCursor(integrationId, "1040")).toBe(false);
    expect(await cursor()).toBe("1050");

    // Duplicate notification: history replays A (already stored).
    gmail.history.set("1050|", { history: [{ id: "1051", messagesAdded: [{ message: { id: A } }] }], historyId: "1060" });
    const before = metaCalls(A);
    const r = await runHistorySync(userId, deps);
    expect(r.resynced).toBe(false);
    expect(await items()).toHaveLength(3);
    expect(await cursor()).toBe("1060");
    // A is still unclassified, so the pending pass retried it exactly once (no new row).
    expect(metaCalls(A)).toBe(before + 1);
  });

  it("concurrent ingests of overlapping ids create each row exactly once", async () => {
    const D = "d0d0d0d0d0d0d0d1";
    const E = "d0d0d0d0d0d0d0d2";
    const F = "d0d0d0d0d0d0d0d3";
    const [x, y] = await Promise.all([insertEmailItems(userId, [D, E, E], "push"), insertEmailItems(userId, [E, F], "triage")]);
    expect(x.length + y.length).toBe(3);
    expect(await insertEmailItems(userId, [D, E, F], "push")).toEqual([]);
    const { error } = await sb.from("email_items").delete().eq("user_id", userId).in("gmail_message_id", [D, E, F]);
    if (error) throw new Error(error.message);
  });

  it("a metadata failure leaves the cursor alone; the next run retries the row and advances", async () => {
    gmail.messages.set(G, { status: 500 });
    gmail.history.set("1060|", { history: [{ id: "1061", messagesAdded: [{ message: { id: G } }] }], historyId: "1070" });
    await expect(runHistorySync(userId, deps)).rejects.toThrow();
    expect(await cursor()).toBe("1060");
    const g1 = (await items()).find((x) => x.gmail_message_id === G);
    expect(g1).toMatchObject({ classified_at: null, importance: null, prefilter_reason: null });

    gmail.messages.set(G, { from: "friend@gmail.com", subject: "dinner?", labels: ["INBOX"] });
    await runHistorySync(userId, deps);
    expect(await cursor()).toBe("1070");
    const rows = await items();
    expect(rows.filter((x) => x.gmail_message_id === G)).toHaveLength(1);
    expect(rows.find((x) => x.gmail_message_id === G)).toMatchObject({ prefilter_reason: "classify:personal" });
  });

  it("404 → resync: lists recent inbox, inserts only new rows, force-CAS resets the cursor", async () => {
    gmail.history.set("1070|", 404);
    gmail.profileHistoryId = "2000";
    gmail.messages.set(H, { from: "ta@yale.edu", subject: "Quiz tomorrow", labels: ["INBOX"] });
    gmail.listIds = [H, A];
    const r = await runHistorySync(userId, deps);
    expect(r.resynced).toBe(true);
    expect(await cursor()).toBe("2000");
    const rows = await items();
    expect(rows.find((x) => x.gmail_message_id === H)).toMatchObject({ source: "resync", prefilter_reason: "classify:school" });
    expect(rows.filter((x) => x.gmail_message_id === A)).toHaveLength(1);
    expect(rows.find((x) => x.gmail_message_id === A)?.source).toBe("push");
  });
});

describe("advance_gmail_cursor RPC", () => {
  it("is numeric, forward-only, and CAS-guarded", async () => {
    expect(await cursor()).toBe("2000");
    expect(await advanceGmailCursor(integrationId, "999")).toBe(false); // "999" > "2000" as text, < as number
    expect(await advanceGmailCursor(integrationId, "2000")).toBe(false); // equal is not forward
    expect(await advanceGmailCursor(integrationId, "abc")).toBe(false);
    expect(await advanceGmailCursor(integrationId, "10000")).toBe(true);
    expect(await advanceGmailCursor(integrationId, "5", { force: true, expected: "2000" })).toBe(false); // stale expected
    expect(await advanceGmailCursor(integrationId, "5", { force: true, expected: null })).toBe(false); // CAS-from-null on non-null
    expect(await cursor()).toBe("10000");
    expect(await advanceGmailCursor(integrationId, "5", { force: true, expected: "10000" })).toBe(true); // reset (may go back)
    expect(await cursor()).toBe("5");
  });
});

describe("watch lifecycle", () => {
  beforeAll(() => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/aria-smoke/topics/gmail-push";
    process.env.GMAIL_PUSH_SERVICE_ACCOUNT = "gmail-push-invoker@aria-smoke.iam.gserviceaccount.com";
    process.env.GMAIL_PUSH_AUDIENCE = "https://aria.test/api/google/gmail-push";
  });
  afterAll(clearPushEnv);

  it("renewal writes only the watch expiry and never clobbers a non-NULL cursor", async () => {
    gmail.watchHistoryId = "999999";
    const { error } = await sb.from("integrations").update({ gmail_watch_expires_at: null }).eq("id", integrationId);
    if (error) throw new Error(error.message);
    expect(await renewGmailWatchIfActive(userId, deps)).toBe(true);
    expect(await cursor()).toBe("5"); // watch's historyId ignored: the cursor already exists
    const { data } = await sb.from("integrations").select("gmail_watch_expires_at").eq("id", integrationId).single();
    expect(new Date(data?.gmail_watch_expires_at ?? 0).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);

    // NULL cursor → the watch seeds it.
    await sb.from("integrations").update({ gmail_history_id: null }).eq("id", integrationId);
    expect(await renewGmailWatchIfActive(userId, deps)).toBe(true);
    expect(await cursor()).toBe("999999");
  });

  it("start schedules renew + periodic sync; stop calls users.stop, clears state, cancels jobs", async () => {
    await startGmailWatch(userId, deps);
    const renew = await pendingJobs(`gmail_watch_renew:${userId}`);
    const periodic = await pendingJobs(`gmail_sync_periodic:${userId}`);
    expect(renew).toHaveLength(1);
    expect(periodic).toHaveLength(1);
    expect(periodic[0].payload).toEqual({ reason: "periodic" });
    expect(new Date(renew[0].run_at).getTime()).toBeGreaterThan(Date.now() + 22 * 3600_000);
    expect(await cursor()).toBe("999999"); // start never clobbers either

    const stopsBefore = gmail.calls.filter((c) => c === "POST /stop").length;
    await stopGmailWatch(userId, deps);
    expect(gmail.calls.filter((c) => c === "POST /stop").length).toBe(stopsBefore + 1);
    const { data } = await sb.from("integrations").select("gmail_watch_expires_at, gmail_history_id").eq("id", integrationId).single();
    expect(data).toEqual({ gmail_watch_expires_at: null, gmail_history_id: null });
    expect(await pendingJobs(`gmail_watch_renew:${userId}`)).toHaveLength(0);
    expect(await pendingJobs(`gmail_sync_periodic:${userId}`)).toHaveLength(0);
  });

  it("skips users without Gmail access", async () => {
    await sb.from("integrations").update({ status: "revoked" }).eq("id", integrationId);
    try {
      expect(await runHistorySync(userId, deps)).toMatchObject({ skipped: true });
      expect(await renewGmailWatchIfActive(userId, deps)).toBe(false);
    } finally {
      await sb.from("integrations").update({ status: "active" }).eq("id", integrationId);
    }
  });
});

describe("push handler", () => {
  const AUD = "https://aria.test/api/google/gmail-push";
  const SA = "gmail-push-invoker@aria-smoke.iam.gserviceaccount.com";
  let keys: ReturnType<typeof createLocalJWKSet>;
  let sign: (claims: Record<string, unknown>, aud?: string) => Promise<string>;

  beforeAll(async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/aria-smoke/topics/gmail-push";
    process.env.GMAIL_PUSH_SERVICE_ACCOUNT = SA;
    process.env.GMAIL_PUSH_AUDIENCE = AUD;
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "smoke", alg: "RS256", use: "sig" };
    keys = createLocalJWKSet({ keys: [jwk] });
    sign = (claims, aud = AUD) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "smoke" })
        .setIssuer("https://accounts.google.com")
        .setAudience(aud)
        .setSubject("1234567890")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
  });
  afterAll(clearPushEnv);

  const envelope = (emailAddress: string, subscription?: string) =>
    JSON.stringify({
      message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId: 123456 })).toString("base64"), messageId: "1" },
      ...(subscription ? { subscription } : {}),
    });
  const push = (token: string | null, body: string) =>
    handleGmailPush(
      new Request(AUD, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body,
      }),
      { keys },
    );

  async function clearPushJobs() {
    await sb.from("jobs").delete().eq("user_id", userId).like("dedupe_key", "gmail_sync:%");
  }

  it("rejects missing / invalid / wrong-audience / wrong-account tokens with 401", async () => {
    const body = envelope(MAILBOX);
    expect((await push(null, body)).status).toBe(401);
    expect((await push("not.a.jwt", body)).status).toBe(401);
    expect((await push(await sign({ email: SA, email_verified: true }, "https://evil.test"), body)).status).toBe(401);
    expect((await push(await sign({ email: "someone@else.com", email_verified: true }), body)).status).toBe(401);
    expect((await push(await sign({ email: SA, email_verified: false }), body)).status).toBe(401);
    expect(await pendingJobs(`gmail_sync:${userId}`)).toHaveLength(0);
  });

  it("acks an unknown mailbox with 204 and enqueues nothing", async () => {
    const res = await push(await sign({ email: SA, email_verified: true }), envelope(`nobody-${RUN}@example.com`));
    expect(res.status).toBe(204);
    expect(await pendingJobs(`gmail_sync:${userId}`)).toHaveLength(0);
  });

  it("400 on a malformed payload", async () => {
    const token = await sign({ email: SA, email_verified: true });
    expect((await push(token, "{not json")).status).toBe(400);
    expect((await push(token, JSON.stringify({ message: { data: "!!!" } }))).status).toBe(400);
  });

  it("a valid push enqueues exactly one gmail_history_sync (bursts dedupe)", async () => {
    try {
      const token = await sign({ email: SA, email_verified: true });
      expect((await push(token, envelope(MAILBOX.toUpperCase()))).status).toBe(204);
      expect((await push(token, envelope(MAILBOX))).status).toBe(204);
      const jobs = await pendingJobs(`gmail_sync:${userId}`);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: "gmail_history_sync", payload: { reason: "push" } });
    } finally {
      await clearPushJobs();
    }
  });

  it("enforces GMAIL_PUSH_SUBSCRIPTION when set", async () => {
    process.env.GMAIL_PUSH_SUBSCRIPTION = "projects/aria-smoke/subscriptions/gmail-push";
    try {
      const token = await sign({ email: SA, email_verified: true });
      expect((await push(token, envelope(MAILBOX, "projects/other/subscriptions/x"))).status).toBe(401);
      expect((await push(token, envelope(MAILBOX, "projects/aria-smoke/subscriptions/gmail-push"))).status).toBe(204);
    } finally {
      delete process.env.GMAIL_PUSH_SUBSCRIPTION;
      await clearPushJobs();
    }
  });
});
