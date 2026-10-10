/**
 * Scheduling + Aria calendar tools smoke (task 4.2; V2-07 07a-5 / 07a-6), against the LOCAL
 * Supabase stack by default (`SMOKE_TARGET=env` for the env project).
 *
 * Real DB (integrations row with encrypted tokens, user_preferences.constraint_json, user_profile
 * class times, timeline), real tool bodies and alias table; fake Google: a global `fetch` wrapper
 * answers every Google host and passes Supabase through. Nothing reaches Google.
 *
 * 1. find_free_slots: live Google busy + class time + Canvas event + saved "no gym after 8pm"
 *    preference all respected; slots come back as s_ aliases.
 * 2. create_block with the s_ alias: the Aria calendar is created lazily (once), the event lands
 *    there (never on primary) with the aria_key property, and a source-aria block row appears.
 *    A retry of the same call inserts nothing new.
 * 3. move_block (t_ alias) patches the event and the row; a gcal row is refused.
 * 4. delete_block removes the event and soft-removes the row.
 * 5. A user without Google: create_block → connect_google is_error; find_free_slots still answers.
 *
 * Every throwaway row is deleted in afterAll (scoped to this file's users). No LLM calls.
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
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = "smoke-cal-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "smoke-cal-client-secret";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.CHANNEL_PROVIDER = "dev";

import { AliasTable } from "@/server/agent/context/aliases";
import type { ToolCtx } from "@/server/agent/types";
import { CONNECT_GOOGLE_ERROR, runCreateBlock } from "@/server/agent/tools/create-block";
import { runDeleteBlock } from "@/server/agent/tools/delete-block";
import { runFindFreeSlots } from "@/server/agent/tools/find-free-slots";
import { runMoveBlock } from "@/server/agent/tools/move-block";
import { parseSlotId, type Interval } from "@/server/integrations/google/calendar/slots";
import { readBusy } from "@/server/integrations/google";
import { encryptSecret, parseKey } from "@/server/security/crypto";
import { upsertTimelineItem } from "@/server/timeline";
import { addLocalDays, formatLocalDate, localDateOf, weekdayOf, zonedToUtc, type LocalDate } from "@/shared/time/tz";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const EMAIL = `smoke-cal-${RUN}@example.edu`;
const TZ = "America/New_York";
const MIN = 60_000;
const userIds: string[] = [];
const logged: string[] = [];

// ── Fake Google (global fetch wrapper) ──────────────────────────────────────
interface FakeEvent {
  id: string;
  summary?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
  organizer?: { self: boolean };
}
interface GCall {
  method: string;
  path: string;
  body: string;
}
const gcalls: GCall[] = [];
const unexpected: string[] = [];
const calendars = new Map<string, FakeEvent[]>();
let calSeq = 0;
let evSeq = 0;
const realFetch = globalThis.fetch;
const notFound = () => Response.json({ error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } }, { status: 404 });

function fakeGoogle(method: string, url: URL, body: string): Response {
  const path = url.pathname.replace("/calendar/v3", "");
  if (url.host !== "www.googleapis.com") {
    unexpected.push(`${method} ${url.host}${url.pathname}`);
    return Response.json({ error: { code: 500, message: "unscripted" } }, { status: 500 });
  }
  if (path === "/calendars" && method === "POST") {
    const id = `aria-${RUN}-${++calSeq}@group.calendar.google.com`;
    calendars.set(id, []);
    return Response.json({ id });
  }
  const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
  if (!m) {
    unexpected.push(`${method} ${path}`);
    return Response.json({ error: { code: 500, message: "unscripted" } }, { status: 500 });
  }
  const list = calendars.get(decodeURIComponent(m[1] as string));
  if (!list) return notFound();
  const evId = m[2] ? decodeURIComponent(m[2]) : null;
  if (!evId && method === "GET") {
    const prop = url.searchParams.get("privateExtendedProperty");
    if (prop) {
      const [k, v] = prop.split("=");
      return Response.json({ items: list.filter((e) => e.extendedProperties?.private?.[k as string] === v) });
    }
    const min = new Date(url.searchParams.get("timeMin") as string);
    const max = new Date(url.searchParams.get("timeMax") as string);
    return Response.json({ items: list.filter((e) => new Date(e.end.dateTime) > min && new Date(e.start.dateTime) < max) });
  }
  if (!evId && method === "POST") {
    const b = JSON.parse(body) as Omit<FakeEvent, "id">;
    const ev: FakeEvent = { ...b, id: `ev${RUN}${String(++evSeq).padStart(16, "0")}`, organizer: { self: true } };
    list.push(ev);
    return Response.json(ev);
  }
  const ev = list.find((e) => e.id === evId);
  if (!ev) return notFound();
  if (method === "PATCH") {
    const b = JSON.parse(body) as Partial<FakeEvent>;
    if (b.start) ev.start = b.start;
    if (b.end) ev.end = b.end;
    return Response.json(ev);
  }
  if (method === "DELETE") {
    list.splice(list.indexOf(ev), 1);
    return new Response(null, { status: 204 });
  }
  unexpected.push(`${method} ${path}`);
  return Response.json({ error: { code: 500, message: "unscripted" } }, { status: 500 });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  const google = url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com") || url.hostname.endsWith("google.com");
  if (!google) return realFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  gcalls.push({ method, path: url.pathname, body });
  return fakeGoogle(method, url, body);
}) as typeof fetch;

// ── Helpers ──────────────────────────────────────────────────────────────────
const MSG = randomUUID();

function ctx(userId: string, aliases = new AliasTable()): ToolCtx & { aliases: AliasTable } {
  const ev = aliases.mint("m", MSG);
  return {
    userId,
    runId: randomUUID(),
    now: new Date(),
    timezone: TZ,
    channel: {
      channelId: "c1",
      provider: "dev",
      kind: "imessage",
      service: "imessage",
      handleKind: "phone",
      capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
      windowOpen: true,
    },
    trigger: { kind: "inbound" },
    aliases,
    evidence: new Set([ev]),
    userText: "",
    taint: { tainted: false, mark: () => undefined },
    links: { add: () => "L1", resolve: () => null },
    interim: { sent: false, send: async () => true },
    signal: new AbortController().signal,
    log: () => undefined,
  } as ToolCtx & { aliases: AliasTable };
}

async function makeUser(name: string): Promise<string> {
  const { data, error } = await sb.from("users").insert({ name, timezone: TZ }).select("id").single();
  if (error) throw new Error(error.message);
  userIds.push(data.id);
  return data.id;
}

const L = (d: LocalDate, h: number, m = 0) => zonedToUtc({ ...d, hour: h, minute: m }, TZ).instant;
const overlaps = (a: Interval, b: Interval) => a.start < b.end && a.end > b.start;

let userA = "";
let userB = "";
let tomorrow: LocalDate;
let busyGoogle: Interval;
let busyClass: Interval;
let busyCanvas: Interval;

beforeAll(async () => {
  for (const m of ["log", "info", "warn", "error"] as const) {
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    });
  }
  userA = await makeUser(`smoke-cal-${RUN}`);
  userB = await makeUser(`smoke-cal-b-${RUN}`);
  tomorrow = addLocalDays(localDateOf(new Date(), TZ), 1);

  const key = parseKey(process.env.APP_ENCRYPTION_KEY as string);
  const { error: ie } = await sb.from("integrations").insert({
    user_id: userA,
    provider: "google",
    status: "active",
    account_email: EMAIL,
    scopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.app.created",
    ],
    enc_access_token: encryptSecret(`at-cal-${RUN}`, key),
    enc_refresh_token: encryptSecret(`rt-cal-${RUN}`, key),
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    gcal_calendar_ids: [EMAIL],
    connected_at: new Date().toISOString(),
  });
  if (ie) throw new Error(ie.message);

  busyGoogle = { start: L(tomorrow, 13), end: L(tomorrow, 14) };
  calendars.set(EMAIL, [
    { id: `g1${RUN}`, summary: "Lunch with Sam", start: { dateTime: busyGoogle.start.toISOString() }, end: { dateTime: busyGoogle.end.toISOString() }, organizer: { self: true } },
  ]);

  busyClass = { start: L(tomorrow, 10), end: L(tomorrow, 11, 15) };
  const { error: pe } = await sb.from("user_profile").insert({
    user_id: userA,
    class_times: [{ course: "CPSC 323", days: [weekdayOf(tomorrow)], start: "10:00", end: "11:15" }],
  });
  if (pe) throw new Error(pe.message);

  const { error: fe } = await sb.from("user_preferences").insert({
    user_id: userA,
    key: "gym.latest_time",
    category: "schedule",
    statement: "no gym after 8pm",
    status: "active",
    source: "explicit",
    constraint_json: { applies_to: ["gym"], constraint: { type: "not_after", time: "20:00" }, waking: null, signoff: null },
  });
  if (fe) throw new Error(fe.message);

  busyCanvas = { start: L(tomorrow, 16), end: L(tomorrow, 17) };
  await upsertTimelineItem(userA, "canvas", {
    externalId: `smoke-cal-${RUN}`,
    kind: "event",
    title: "Review session",
    startsAt: busyCanvas.start,
    endsAt: busyCanvas.end,
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  jest.restoreAllMocks();
  const errors: string[] = [];
  if (userIds.length) {
    for (const table of ["jobs", "integrations", "timeline_items", "user_preferences", "user_profile"] as const) {
      const r = await sb.from(table).delete().in("user_id", userIds);
      if (r.error) errors.push(`${table}: ${r.error.message}`);
    }
    const u = await sb.from("users").delete().in("id", userIds);
    if (u.error) errors.push(u.error.message);
  }
  const leaks = logged.filter((l) => /at-cal-|rt-cal-|smoke-cal-client-secret/.test(l));
  if (leaks.length) errors.push(`secret-like value logged: ${leaks.length} line(s)`);
  if (errors.length) throw new Error(`calendar-tools smoke cleanup/log check: ${errors.join("; ")}`);
});

async function ariaRows(userId: string) {
  const { data, error } = await sb
    .from("timeline_items")
    .select("id, external_id, kind, starts_at, ends_at, removed_at, raw, title")
    .eq("user_id", userId)
    .eq("source", "aria");
  if (error) throw new Error(error.message);
  return data;
}

describe("calendar tools (local DB, fake Google)", () => {
  const run = ctx("");
  let slotAlias = "";
  let blockAlias = "";

  it("readBusy (barrel) unions live Google, class times and Canvas events", async () => {
    const r = await readBusy(userA, L(tomorrow, 0), L(addLocalDays(tomorrow, 1), 0));
    expect(r.calendarsChecked).toBe(1);
    for (const b of [busyGoogle, busyClass, busyCanvas]) expect(r.busy.some((x) => x.start <= b.start && x.end >= b.end)).toBe(true);
  });

  it("find_free_slots respects busy time + the saved preference and returns s_ aliases", async () => {
    run.userId = userA;
    const day = formatLocalDate(tomorrow);
    const r = await runFindFreeSlots(run, {
      duration_minutes: 60,
      activity: "gym",
      window_start: day,
      window_end: day,
      constraints: [],
      max_results: 5,
    });
    expect(r.ok).toBe(true);
    const text = (r as { data: string }).data;
    expect(text).toContain("calendars checked: 1");
    expect(text).toContain("applied their saved scheduling preferences");
    const aliases = [...text.matchAll(/^\[(s_[0-9a-f]{8,10})\]/gm)].map((m) => m[1] as string);
    expect(aliases.length).toBeGreaterThanOrEqual(3);
    for (const a of aliases) {
      const slot = parseSlotId(run.aliases.resolve(a, "s") ?? "");
      expect(slot).not.toBeNull();
      const s = slot as Interval;
      for (const b of [busyGoogle, busyClass, busyCanvas]) {
        // 10-min buffer on both sides
        expect(overlaps(s, { start: new Date(b.start.getTime() - 10 * MIN), end: new Date(b.end.getTime() + 10 * MIN) })).toBe(false);
      }
      expect(s.end <= L(tomorrow, 20)).toBe(true);
      expect(s.start >= L(tomorrow, 8)).toBe(true);
    }
    slotAlias = aliases[0] as string;
  });

  it("create_block with the s_ alias creates the Aria calendar lazily and writes only there", async () => {
    const r = await runCreateBlock(run, { title: "Gym", slot: slotAlias, allow_overlap: false, evidence: [...run.evidence][0] as string });
    expect(r).toEqual({ ok: true, data: expect.stringMatching(/^ok: on your Aria calendar, .+ \[(t_[0-9a-f]{8,10})\]$/) });
    blockAlias = /\[(t_[0-9a-f]{8,10})\]$/.exec((r as { data: string }).data)?.[1] as string;

    const { data: row } = await sb.from("integrations").select("gcal_aria_calendar_id").eq("user_id", userA).single();
    const ariaId = row?.gcal_aria_calendar_id as string;
    expect(ariaId).toBe(`aria-${RUN}-1@group.calendar.google.com`);
    const events = calendars.get(ariaId) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.extendedProperties?.private).toMatchObject({ aria: "1", aria_key: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const slot = parseSlotId(run.aliases.resolve(slotAlias, "s") as string) as Interval;
    expect(new Date(events[0]?.start.dateTime as string)).toEqual(slot.start);
    expect(calendars.get(EMAIL)).toHaveLength(1); // primary untouched
    expect(gcalls.some((c) => c.method !== "GET" && c.path.includes(encodeURIComponent(EMAIL)))).toBe(false);

    const rows = (await ariaRows(userA)).filter((x) => x.removed_at === null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "block", title: "Gym", external_id: `${ariaId}|${events[0]?.id}`, raw: { calendar_id: ariaId } });
    expect(run.aliases.resolve(blockAlias, "t")).toBe(rows[0]?.id);

    // Retry of the same call in the same run: no second insert, no second calendar.
    const again = await runCreateBlock(run, { title: "Gym", slot: slotAlias, allow_overlap: false, evidence: [...run.evidence][0] as string });
    expect((again as { data: string }).data).toContain(`[${blockAlias}]`);
    expect(calendars.get(ariaId)).toHaveLength(1);
    expect(gcalls.filter((c) => c.method === "POST" && c.path === "/calendar/v3/calendars")).toHaveLength(1);
  });

  it("create_block refuses a busy time unless allow_overlap; move_block refuses a gcal row", async () => {
    const ev = [...run.evidence][0] as string;
    const clash = await runCreateBlock(run, {
      title: "Gym",
      start: busyGoogle.start.toISOString(),
      end: busyGoogle.end.toISOString(),
      allow_overlap: false,
      evidence: ev,
    });
    expect((clash as { data: string }).data).toMatch(/^not booked: it overlaps busy time/);

    const { id: gcalId } = await upsertTimelineItem(userA, "gcal", {
      externalId: `${EMAIL}|g1${RUN}`,
      kind: "event",
      title: "Lunch with Sam",
      startsAt: busyGoogle.start,
      endsAt: busyGoogle.end,
      raw: { calendar_id: EMAIL },
    });
    const gAlias = run.aliases.mint("t", gcalId);
    const refused = await runMoveBlock(run, { block: gAlias, start: L(tomorrow, 21).toISOString(), end: L(tomorrow, 22).toISOString(), evidence: ev });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/only blocks on the Aria calendar/) });
    expect(gcalls.some((c) => c.method === "PATCH" && c.path.includes(encodeURIComponent(EMAIL)))).toBe(false);
  });

  it("move_block patches the Aria event and the timeline row", async () => {
    const ev = [...run.evidence][0] as string;
    const start = L(tomorrow, 21);
    const end = L(tomorrow, 22);
    const r = await runMoveBlock(run, { block: blockAlias, start: start.toISOString(), end: end.toISOString(), evidence: ev });
    expect(r).toEqual({ ok: true, data: expect.stringMatching(/^ok: moved to /) });
    const rows = (await ariaRows(userA)).filter((x) => x.removed_at === null);
    expect(new Date(rows[0]?.starts_at as string)).toEqual(start);
    expect(new Date(rows[0]?.ends_at as string)).toEqual(end);
    const ariaId = [...calendars.keys()].find((k) => k.startsWith("aria-")) as string;
    expect(new Date(calendars.get(ariaId)?.[0]?.start.dateTime as string)).toEqual(start);
  });

  it("delete_block removes the event and soft-removes the row", async () => {
    const ev = [...run.evidence][0] as string;
    const r = await runDeleteBlock(run, { block: blockAlias, evidence: ev });
    expect(r).toEqual({ ok: true, data: "ok: removed from your Aria calendar" });
    const ariaId = [...calendars.keys()].find((k) => k.startsWith("aria-")) as string;
    expect(calendars.get(ariaId)).toHaveLength(0);
    expect((await ariaRows(userA)).every((x) => x.removed_at !== null)).toBe(true);
    expect(unexpected).toEqual([]);
  });

  it("without Google: create_block → connect_google is_error; find_free_slots still answers", async () => {
    const c = ctx(userB);
    const ev = [...c.evidence][0] as string;
    const r = await runCreateBlock(c, { title: "Gym", start: L(tomorrow, 18).toISOString(), end: L(tomorrow, 19).toISOString(), allow_overlap: false, evidence: ev });
    expect(r).toEqual({ ok: false, error: CONNECT_GOOGLE_ERROR });
    const day = formatLocalDate(tomorrow);
    const f = await runFindFreeSlots(c, { duration_minutes: 45, activity: "study", window_start: day, window_end: day, constraints: [], max_results: 3 });
    expect(f.ok).toBe(true);
    expect((f as { data: string }).data).toContain("Google Calendar isn't connected");
    expect((f as { data: string }).data).toContain("calendars checked: 0");
  });
});
