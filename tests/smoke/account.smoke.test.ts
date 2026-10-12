/**
 * Account export + deletion smoke (task 4.6; web plan §10 `account.smoke`), against the LOCAL
 * Supabase stack by default (`SMOKE_TARGET=env` for the env project).
 *
 *  1. `collectAccountExport`: every included table, paging past 1,000 rows (1,050 messages), only
 *     the signup matched to the user (not another same-phone signup), no IP / user agent, deleted
 *     facts excluded, no secret keys or ciphertext.
 *  2. `POST /api/me/export`: fresh setup session → JSON attachment + no-store; view session → 303
 *     `/settings?export=needs_fresh_link`; foreign Origin → 403; no session → `signed_out`.
 *  3. `deleteAccount({via:"web"})`: real `disconnectGoogle` (Google HTTP faked: the revoke fails →
 *     `googleRevoked:false`), Canvas disconnect, both signups gone, user + cascade gone, safety-net
 *     purge cancelled; a second call is a no-op.
 *  4. `via:"job"` on a soft-deleted user (revoke succeeds → `googleRevoked:true`), and a retry after a
 *     partial teardown (Google already disconnected) completes.
 *
 * Throwaway users only; afterAll deletes them, their signups and their `purge:<id>` jobs. No LLM
 * calls are made (no `llm_calls` rows). No global `runDueJobs`.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

jest.mock("next/server", () => ({ after: () => undefined }));
// Request-scoped headers/cookies for the export route's guard.
const mockRequest: { headers: Headers; cookies: Map<string, string> } = { headers: new Headers(), cookies: new Map() };
jest.mock("next/headers", () => ({
  headers: async () => mockRequest.headers,
  cookies: async () => ({
    get: (name: string) => {
      const value = mockRequest.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
// Fake Google HTTP: the revoke endpoint and the watch stops (everything else in disconnectGoogle is real).
const mockGoogle = { revokeFails: false, revokes: 0 };
jest.mock("@/server/integrations/google/oauth/flow", () => ({
  ...jest.requireActual<object>("@/server/integrations/google/oauth/flow"),
  revokeToken: async () => {
    mockGoogle.revokes++;
    if (mockGoogle.revokeFails) throw new Error("revoke failed (fake)");
  },
}));
jest.mock("@/server/integrations/google/calendar/watch", () => ({
  ...jest.requireActual<object>("@/server/integrations/google/calendar/watch"),
  stopCalendarWatch: async () => undefined,
}));
jest.mock("@/server/integrations/google/gmail/sync", () => ({
  ...jest.requireActual<object>("@/server/integrations/google/gmail/sync"),
  stopGmailWatch: async () => undefined,
}));

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
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.CHANNEL_PROVIDER = "dev";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Server modules read env lazily (db() on first call), so importing after the assignment is safe.
import { POST as exportPOST } from "@/app/api/me/export/route";
import { deleteAccount } from "@/server/account/delete";
import { collectAccountExport } from "@/server/account/export";
import { disconnectGoogle } from "@/server/integrations/google";
import { encryptSecret, parseKey } from "@/server/security/crypto";
import { createSession, SESSION_COOKIE } from "@/server/security/sessions";
import type { NextRequest } from "next/server";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const ORIGIN = "http://localhost:3000";
const FEED = "https://canvas.example.edu/feeds/calendars/user_SECRETFEED.ics";

const users: string[] = [];
const signups: string[] = [];

function must<T>(r: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${label}: no data`);
  return r.data as NonNullable<T>;
}

function enc(s: string): string {
  return encryptSecret(s, parseKey(process.env.APP_ENCRYPTION_KEY ?? ""));
}

function randomPhone(): string {
  return `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
}

interface Seeded {
  userId: string;
  channelId: string;
  phone: string;
  signupIds: string[];
}

/** A user with a channel, two signups (matched + someone else's for the same phone), memory, timeline, Google + Canvas rows. */
async function seedUser(name: string, opts: { messages?: number } = {}): Promise<Seeded> {
  const userId = must(await sb.from("users").insert({ name, timezone: "America/New_York" }).select("id").single(), "user").id;
  users.push(userId);
  const phone = randomPhone();
  const channelId = must(
    await sb
      .from("channels")
      .insert({ user_id: userId, kind: "imessage", handle: phone, handle_kind: "phone", provider: "dev", is_primary: true, verified_at: new Date().toISOString() })
      .select("id")
      .single(),
    "channel",
  ).id;
  const su = must(
    await sb
      .from("signups")
      .insert([
        { name, phone_e164: phone, matched_user_id: userId, timezone: "America/New_York", ip: "203.0.113.7", user_agent: "SmokeOwnUA/1.0" },
        // Someone else's form submission for the same phone (never matched): not in the export.
        { name: `${name} Impostor`, phone_e164: phone, timezone: "America/Chicago", ip: "198.51.100.9", user_agent: "SmokeOtherUA/1.0" },
      ])
      .select("id"),
    "signups",
  ).map((r) => r.id);
  signups.push(...su);
  must(await sb.from("user_profile").insert({ user_id: userId, school: "Yale University", courses: ["CPSC 323"] }).select("user_id"), "profile");
  must(await sb.from("user_preferences").insert({ user_id: userId, key: "gym", statement: "No gym after 8pm", status: "active", source: "explicit" }).select("id"), "pref");
  must(
    await sb
      .from("memory_facts")
      .insert([
        { user_id: userId, content: "Has a Stripe interview Oct 23", source: "extraction" },
        { user_id: userId, content: "Deleted fact", source: "extraction", deleted_at: new Date().toISOString() },
      ])
      .select("id"),
    "facts",
  );
  must(
    await sb
      .from("timeline_items")
      .insert({ user_id: userId, source: "canvas", external_id: `smoke-${randomUUID()}`, kind: "assignment", title: "PSET 4", due_at: new Date(Date.now() + 86_400_000).toISOString() })
      .select("id"),
    "timeline",
  );
  must(await sb.from("reminders").insert({ user_id: userId, body: "drink water", due_at: new Date(Date.now() + 3_600_000).toISOString() }).select("id"), "reminder");
  must(
    await sb
      .from("integrations")
      .insert([
        {
          user_id: userId,
          provider: "google",
          account_email: `${name.toLowerCase()}@example.edu`,
          scopes: ["openid", "https://www.googleapis.com/auth/calendar.readonly"],
          enc_access_token: enc("ya29.ACCESS"),
          enc_refresh_token: enc("1//REFRESH"),
          gcal_channel_token_hash: "deadbeef",
          status: "active",
        },
        { user_id: userId, provider: "canvas_ical", enc_ical_url: enc(FEED), ical_host: "canvas.example.edu", status: "active" },
      ])
      .select("id"),
    "integrations",
  );
  const n = opts.messages ?? 3;
  const base = Date.now() - n * 1000;
  const rows = Array.from({ length: n }, (_, i) => ({
    user_id: userId,
    channel_id: channelId,
    direction: i % 2 ? "out" : "in",
    body: `msg ${i}`,
    created_at: new Date(base + i * 1000).toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 500) must(await sb.from("messages").insert(rows.slice(i, i + 500)).select("id"), "messages");
  return { userId, channelId, phone, signupIds: su };
}

function setRequest(origin: string | null, sessionRaw: string | null): void {
  mockRequest.headers = new Headers(origin ? { origin } : {});
  mockRequest.cookies = new Map(sessionRaw ? [[SESSION_COOKIE, sessionRaw]] : []);
}

function exportReq(): NextRequest {
  // The route reads Origin + cookie through next/headers (mocked); the request object is unused.
  return new Request(`${ORIGIN}/api/me/export`, { method: "POST" }) as unknown as NextRequest;
}

async function rowCount(table: "messages" | "integrations" | "web_sessions" | "timeline_items" | "memory_facts" | "channels", userId: string): Promise<number> {
  const { count, error } = await sb.from(table).select("*", { count: "exact", head: true }).eq("user_id", userId);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

let a: Seeded;

beforeAll(async () => {
  a = await seedUser("Avery", { messages: 1050 });
});

afterAll(async () => {
  if (users.length) {
    await sb.from("users").delete().in("id", users);
    await sb.from("jobs").delete().in("dedupe_key", users.map((u) => `purge:${u}`));
  }
  if (signups.length) await sb.from("signups").delete().in("id", signups);
});

describe("1. collectAccountExport", () => {
  it("pages past 1,000 rows and includes every table, never a secret", async () => {
    const out = await collectAccountExport(a.userId);
    expect(out.version).toBe(1);
    const t = out.tables;
    expect(t.messages).toHaveLength(1050);
    expect(t.messages[0]).toEqual(expect.objectContaining({ direction: "in", body: "msg 0" }));
    expect(t.messages[1049]).toEqual(expect.objectContaining({ body: "msg 1049" }));
    expect(t.users).toEqual([expect.objectContaining({ name: "Avery", timezone: "America/New_York" })]);
    expect(t.channels).toEqual([expect.objectContaining({ handle: a.phone, kind: "imessage" })]);
    // Only the signup matched to this user, without IP / user agent (5.5 #8).
    expect(t.signups).toEqual([
      { name: "Avery", phone_e164: a.phone, timezone: "America/New_York", consent_version: null, created_at: expect.any(String) },
    ]);
    expect(t.user_profile).toEqual([expect.objectContaining({ school: "Yale University", courses: ["CPSC 323"] })]);
    expect(t.user_preferences).toEqual([expect.objectContaining({ statement: "No gym after 8pm", status: "active" })]);
    expect(t.memory_facts.map((f) => f.content)).toEqual(["Has a Stripe interview Oct 23"]);
    expect(t.timeline_items).toEqual([expect.objectContaining({ title: "PSET 4", source: "canvas" })]);
    expect(t.reminders).toEqual([expect.objectContaining({ body: "drink water" })]);
    expect(t.integrations.map((i) => i.provider).sort()).toEqual(["canvas_ical", "google"]);
    for (const i of t.integrations) expect(Object.keys(i).sort()).toEqual(expect.arrayContaining(["provider", "status"]));

    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"enc_|token|hash/i);
    expect(json).not.toContain("SECRETFEED");
    expect(json).not.toContain("ya29");
    expect(json).not.toContain("deadbeef");
    expect(json).not.toContain(a.userId);
    for (const leak of ["Impostor", "198.51.100.9", "203.0.113.7", "SmokeOtherUA", "SmokeOwnUA", '"ip"', '"user_agent"']) {
      expect(json).not.toContain(leak);
    }
  });
});

describe("2. POST /api/me/export", () => {
  it("fresh setup session → JSON attachment with no-store", async () => {
    const raw = (await createSession(a.userId, "setup")).value;
    setRequest(ORIGIN, raw);
    const res = await exportPOST(exportReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="aria-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = (await res.json()) as { version: number; tables: Record<string, unknown[]> };
    expect(body.version).toBe(1);
    expect(body.tables.messages).toHaveLength(1050);
  });

  it("view session → 303 needs_fresh_link; no session → signed_out; foreign Origin → 403", async () => {
    const view = (await createSession(a.userId, "view")).value;
    setRequest(ORIGIN, view);
    const stale = await exportPOST(exportReq());
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe(`${ORIGIN}/settings?export=needs_fresh_link`);

    setRequest(ORIGIN, null);
    const out = await exportPOST(exportReq());
    expect(out.headers.get("location")).toBe(`${ORIGIN}/settings?export=signed_out`);

    const fresh = (await createSession(a.userId, "setup")).value;
    setRequest("https://evil.example", fresh);
    expect((await exportPOST(exportReq())).status).toBe(403);
    setRequest(null, fresh);
    expect((await exportPOST(exportReq())).status).toBe(403);
  });
});

describe("3. deleteAccount via web", () => {
  it("revokes Google (fails → googleRevoked false), deletes signups, user and cascade; second call is a no-op", async () => {
    mockGoogle.revokeFails = true;
    mockGoogle.revokes = 0;
    const r = await deleteAccount(a.userId, { via: "web" });
    expect(r).toEqual({ ok: true, googleRevoked: false });
    expect(mockGoogle.revokes).toBe(1);

    expect(must(await sb.from("users").select("id").eq("id", a.userId), "user")).toHaveLength(0);
    expect(must(await sb.from("signups").select("id").in("id", a.signupIds), "signups")).toHaveLength(0);
    for (const t of ["messages", "integrations", "web_sessions", "timeline_items", "memory_facts", "channels"] as const) {
      expect(await rowCount(t, a.userId)).toBe(0);
    }
    const nets = must(await sb.from("jobs").select("status, last_error").eq("dedupe_key", `purge:${a.userId}`), "safety net");
    expect(nets.every((j) => j.status !== "pending")).toBe(true);

    mockGoogle.revokeFails = false;
    await expect(deleteAccount(a.userId, { via: "web" })).resolves.toEqual({ ok: true, googleRevoked: true });
    expect(mockGoogle.revokes).toBe(1);
  });
});

describe("4. deleteAccount via job + retry after partial teardown", () => {
  it("purges a soft-deleted user (chat path) with a confirmed revoke", async () => {
    const b = await seedUser("Blake");
    must(await sb.from("users").update({ deleted_at: new Date().toISOString() }).eq("id", b.userId).select("id"), "mark");
    mockGoogle.revokeFails = false;
    mockGoogle.revokes = 0;
    await expect(deleteAccount(b.userId, { via: "job" })).resolves.toEqual({ ok: true, googleRevoked: true });
    expect(mockGoogle.revokes).toBe(1);
    expect(must(await sb.from("users").select("id").eq("id", b.userId), "user")).toHaveLength(0);
    expect(must(await sb.from("signups").select("id").in("id", b.signupIds), "signups")).toHaveLength(0);
    // The job path schedules no safety net of its own.
    expect(must(await sb.from("jobs").select("id").eq("dedupe_key", `purge:${b.userId}`), "jobs")).toHaveLength(0);
  });

  it("finishes after a partial teardown (Google already disconnected, user soft-deleted)", async () => {
    const c = await seedUser("Casey");
    must(await sb.from("users").update({ deleted_at: new Date().toISOString() }).eq("id", c.userId).select("id"), "mark");
    await disconnectGoogle(c.userId, { reason: "account_deleted" });
    await expect(deleteAccount(c.userId, { via: "web" })).resolves.toEqual({ ok: true, googleRevoked: true });
    expect(must(await sb.from("users").select("id").eq("id", c.userId), "user")).toHaveLength(0);
    expect(await rowCount("integrations", c.userId)).toBe(0);
  });
});
