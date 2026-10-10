/**
 * /email/[id] smoke (task 4.5, web plan §11 W9), against the LOCAL Supabase stack by default
 * (`SMOKE_TARGET=env` for the env project).
 *
 *  1. `getDraftView` is owner-scoped: another user's id, a bad id, and a non-email action → null
 *  2. Save bumps the version, ignores recipient fields, refuses a stale version (conflict)
 *  3. Freshness: a > 60 min session can't save or send, but can cancel
 *  4. Send: a double submit sends once (atomic confirm), the page reads "sent", and the chat gets
 *     "<summary> ✅"; a later Send is `not_pending`
 *  5. Executor `google_disconnected` maps to its code and the draft reads "failed"; expired → `expired`
 *
 * The request-bound guard (`requireActionViewer`: Origin + cookie) is replaced by one that applies
 * the real freshness rules to a test viewer; `refresh()` is a spy; the `send_email` executor (4.3)
 * is a counting fake with the real payload schema. Rows hang off throwaway users (cascade).
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";
import type { Viewer } from "@/server/viewer";

jest.mock("next/server", () => ({ after: () => undefined }));
jest.mock("next/cache", () => ({ refresh: jest.fn() }));

interface FakeState {
  calls: number;
  fail: string | null;
}

jest.mock("@/server/agent/pending/executors", () => {
  const actual = jest.requireActual<typeof import("@/server/agent/pending/executors")>("@/server/agent/pending/executors");
  const { SendEmailPayload } = jest.requireActual<typeof import("@/shared/email-draft")>("@/shared/email-draft");
  const state: FakeState = { calls: 0, fail: null };
  const fake = {
    kind: "send_email" as const,
    payload: SendEmailPayload,
    ttlMs: 24 * 3_600_000,
    describe: () => "send the email",
    execute: async () => {
      state.calls++;
      await new Promise((r) => setTimeout(r, 50));
      if (state.fail) return { ok: false as const, error: state.fail, retryable: false };
      return { ok: true as const, summary: "sent your email to Prof. Lee", result: { sent_at: new Date().toISOString() } };
    },
  };
  const delAcct = actual.EXECUTORS.find((e) => e.kind === "delete_account");
  const EXECUTORS = [delAcct, fake];
  return { EXECUTORS, getExecutor: (kind: string) => EXECUTORS.find((e) => e?.kind === kind), mockState: state };
});

const viewerRef: { current: Viewer | null } = { current: null };
jest.mock("@/server/web/guard", () => {
  const actual = jest.requireActual<typeof import("@/server/web/guard")>("@/server/web/guard");
  return {
    ...actual,
    requireActionViewer: async (need: "any" | "recent" | "fresh_setup") => {
      const v = viewerRef.current;
      if (!v) return { ok: false, code: "signed_out" };
      const failed = actual.sessionFailsNeed(v.session, need);
      return failed ? { ok: false, code: failed } : { ok: true, viewer: v };
    },
  };
});

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
const target =
  process.env.SMOKE_TARGET === "env"
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" }
    : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
process.env.CHANNEL_PROVIDER = "dev";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Server modules read env lazily (db() on first call), so importing after the assignment is safe.
import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { cancelDraftAction, saveDraftAction, sendDraftAction } from "@/app/(app)/email/[id]/actions";
import { getDraftView } from "@/server/web/email-data";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const mockState = jest.requireMock<{ mockState: FakeState }>("@/server/agent/pending/executors").mockState;
const refreshSpy = refresh as unknown as jest.Mock;

const users: string[] = [];
let userA = "";
let userB = "";

const PAYLOAD = {
  v: 1 as const,
  from: "dan@example.edu",
  to: ["lee@example.edu"],
  cc: [] as string[],
  subject: "Essay extension",
  body_text: "Hi Professor Lee,\n\nCould I have until Friday?\n\nDan",
};

function must<T>(r: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${label}: no data`);
  return r.data as NonNullable<T>;
}

async function newUser(name: string): Promise<string> {
  const u = must(await sb.from("users").insert({ name, timezone: "America/New_York" }).select("id").single(), "user");
  users.push(u.id);
  return u.id;
}

async function newChannel(userId: string): Promise<void> {
  const handle = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  must(
    await sb
      .from("channels")
      .insert({ user_id: userId, kind: "imessage", handle, handle_kind: "phone", provider: "dev", is_primary: true, verified_at: new Date().toISOString() })
      .select("id")
      .single(),
    "channel",
  );
}

async function newDraft(userId: string, over: { kind?: string; payload?: unknown; expiresAt?: Date } = {}): Promise<string> {
  return must(
    await sb
      .from("pending_actions")
      .insert({
        user_id: userId,
        kind: over.kind ?? "send_email",
        payload: (over.payload ?? PAYLOAD) as Database["public"]["Tables"]["pending_actions"]["Insert"]["payload"],
        summary: "email to Prof. Lee",
        status: "pending",
        version: 1,
        expires_at: (over.expiresAt ?? new Date(Date.now() + 3_600_000)).toISOString(),
      })
      .select("id")
      .single(),
    "draft",
  ).id;
}

function viewer(userId: string, ageMs = 60_000): Viewer {
  return {
    session: { userId, scope: "view", createdAt: new Date(Date.now() - ageMs) },
    userId,
    name: "Dan",
    timezone: "America/New_York",
    school: null,
  };
}

function form(entries: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, String(v));
  return f;
}

async function row(id: string) {
  return must(await sb.from("pending_actions").select("*").eq("id", id).single(), "pending row");
}

beforeAll(async () => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  userA = await newUser("smoke email A");
  userB = await newUser("smoke email B");
  await newChannel(userA);
});

beforeEach(() => {
  mockState.calls = 0;
  mockState.fail = null;
  refreshSpy.mockClear();
  viewerRef.current = viewer(userA);
});

afterAll(async () => {
  jest.restoreAllMocks();
  for (const u of users) await sb.from("jobs").delete().eq("user_id", u);
  if (users.length > 0) {
    const { error } = await sb.from("users").delete().in("id", users);
    expect(error).toBeNull();
  }
  const left = await Promise.all([
    sb.from("pending_actions").select("id", { count: "exact", head: true }).in("user_id", users),
    sb.from("messages").select("id", { count: "exact", head: true }).in("user_id", users),
    sb.from("users").select("id", { count: "exact", head: true }).in("id", users),
  ]);
  expect(left.map((l) => l.count ?? 0)).toEqual([0, 0, 0]);
});

describe("1. getDraftView is owner-scoped", () => {
  it("returns the viewer's draft and null for anything else", async () => {
    const id = await newDraft(userA);
    const v = await getDraftView(viewer(userA), id);
    expect(v).toMatchObject({ id, version: 1, status: "pending", to: ["lee@example.edu"], subject: "Essay extension", canSend: true });
    expect(await getDraftView(viewer(userB), id)).toBeNull();
    expect(await getDraftView(viewer(userA), "not-a-uuid")).toBeNull();
    expect(await getDraftView(viewer(userA), randomUUID())).toBeNull();
    const del = await newDraft(userA, { kind: "delete_account", payload: {} });
    expect(await getDraftView(viewer(userA), del)).toBeNull();
    expect((await getDraftView(viewer(userA, 2 * 3_600_000), id))?.canSend).toBe(false);
  });
});

describe("2. save", () => {
  it("bumps the version, never takes recipients from the form, and refuses a stale version", async () => {
    const id = await newDraft(userA);
    const ok = await saveDraftAction(null, form({ id, version: 1, subject: "Extension request", body: "New body\r\nline 2", to: "evil@example.com", cc: "x@example.com" }));
    expect(ok).toEqual({ ok: true, data: { version: 2 } });
    expect(refreshSpy).toHaveBeenCalled();
    const r = await row(id);
    expect(r.version).toBe(2);
    expect(r.payload).toMatchObject({ subject: "Extension request", body_text: "New body\nline 2", to: ["lee@example.edu"], cc: [] });

    expect(await saveDraftAction(null, form({ id, version: 1, subject: "stale", body: "x" }))).toEqual({ ok: false, code: "version_conflict" });
    expect(await saveDraftAction(null, form({ id, version: 2, subject: "a\nBcc: evil@example.com", body: "x" }))).toEqual({ ok: false, code: "invalid" });
    viewerRef.current = viewer(userB);
    expect(await saveDraftAction(null, form({ id, version: 2, subject: "x", body: "x" }))).toEqual({ ok: false, code: "not_found" });
    expect((await row(id)).version).toBe(2);
  });
});

describe("3. freshness", () => {
  it("an old session can't save or send, but can cancel", async () => {
    const id = await newDraft(userA);
    viewerRef.current = viewer(userA, 2 * 3_600_000);
    expect(await saveDraftAction(null, form({ id, version: 1, subject: "x", body: "y" }))).toEqual({ ok: false, code: "needs_recent_link" });
    expect(await sendDraftAction(null, form({ id, version: 1 }))).toEqual({ ok: false, code: "needs_recent_link" });
    expect(mockState.calls).toBe(0);
    expect(await cancelDraftAction(null, form({ id }))).toEqual({ ok: true, data: undefined });
    expect(await cancelDraftAction(null, form({ id }))).toEqual({ ok: false, code: "not_pending" });
    expect((await getDraftView(viewer(userA), id))?.status).toBe("cancelled");
  });
});

describe("4. send", () => {
  it("a double submit sends once; the page reads sent; the chat gets the confirmation", async () => {
    const id = await newDraft(userA);
    const results = await Promise.all([sendDraftAction(null, form({ id, version: 1 })), sendDraftAction(null, form({ id, version: 1 }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, code: "not_pending" });
    expect(mockState.calls).toBe(1);

    const v = await getDraftView(viewer(userA), id);
    expect(v?.status).toBe("sent");
    expect(v?.sentAtLabel).toMatch(/\d:\d\d [AP]M$/);
    expect(await row(id)).toMatchObject({ status: "done", decided_via: "web" });

    const posted = must(
      await sb.from("messages").select("body, direction").eq("user_id", userA).like("idempotency_key", `d:${userA}:act:${id}:%`),
      "posted",
    );
    expect(posted).toEqual([{ body: "sent your email to Prof. Lee ✅", direction: "out" }]);
    expect(await sendDraftAction(null, form({ id, version: 1 }))).toEqual({ ok: false, code: "not_pending" });
    expect(mockState.calls).toBe(1);
  });

  it("refuses to send a version the user didn't review", async () => {
    const id = await newDraft(userA);
    must(await sb.from("pending_actions").update({ version: 2 }).eq("id", id).select("id"), "bump");
    expect(await sendDraftAction(null, form({ id, version: 1 }))).toEqual({ ok: false, code: "version_conflict" });
    expect(mockState.calls).toBe(0);
    expect(refreshSpy).toHaveBeenCalled();
  });
});

describe("5. failures", () => {
  it("google_disconnected maps to its code and the draft reads failed", async () => {
    const id = await newDraft(userA);
    mockState.fail = "google_disconnected";
    expect(await sendDraftAction(null, form({ id, version: 1 }))).toEqual({ ok: false, code: "google_disconnected" });
    expect((await getDraftView(viewer(userA), id))?.status).toBe("failed");
  });

  it("other executor failures map to executor_failed", async () => {
    const id = await newDraft(userA);
    mockState.fail = "gmail_rejected";
    expect(await sendDraftAction(null, form({ id, version: 1 }))).toEqual({ ok: false, code: "executor_failed" });
  });

  it("an expired draft can't be saved or sent and reads expired", async () => {
    const id = await newDraft(userA, { expiresAt: new Date(Date.now() - 1000) });
    expect(await saveDraftAction(null, form({ id, version: 1, subject: "x", body: "y" }))).toEqual({ ok: false, code: "expired" });
    expect(await sendDraftAction(null, form({ id, version: 1 }))).toEqual({ ok: false, code: "expired" });
    expect(mockState.calls).toBe(0);
    expect((await getDraftView(viewer(userA), id))?.status).toBe("expired");
  });
});
