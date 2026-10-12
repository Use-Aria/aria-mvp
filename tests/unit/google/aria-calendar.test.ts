/**
 * Aria calendar writes (task 4.2; V2-07 §2.8, 07a-6) against a fake Google at the HTTP boundary:
 * lazy one-time calendar creation, `aria_key` retry idempotency, recreate-on-404 with a note,
 * live conflict re-check (busy only: transparent / all-day never conflict), `no_permission`,
 * `move_block` refusing non-Aria rows and excluding itself from the conflict check,
 * `delete_block` treating 404 as success. Ambiguous writes (review 5.5 #1): an `events.insert` /
 * `calendars.insert` whose outcome is unknown is never re-sent; the `aria_key` lookup / the
 * calendar-list lookup decides instead.
 */
import { randomBytes } from "node:crypto";
import {
  createBlock,
  deleteBlock,
  moveBlock,
  ensureAriaCalendar,
  resetAmbiguousCalendarMemo,
  type AriaCalendarDeps,
} from "@/server/integrations/google/calendar/aria-calendar";
import { GoogleWriteUnknownError } from "@/server/integrations/google/http";
import type { GoogleIntegration } from "@/server/integrations/google/store";
import type { TimelineItem, TimelineItemInput } from "@/server/timeline/types";
import { googleRow, json, MemoryStore } from "./fakes";

const key = randomBytes(32);
const PRIMARY = "student@example.edu";
const TZ = "America/New_York";
const NOW = new Date("2026-10-14T12:00:00Z");
const USER = "user-1";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
];

interface FakeEvent {
  id: string;
  summary?: string;
  status?: string;
  transparency?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  htmlLink?: string;
}

/** How a scripted write fails: the HTTP outcome, and whether Google applied it anyway. */
interface WriteFailure {
  kind: "timeout" | "network" | 500 | 503 | 429;
  applied: boolean;
}

/** Minimal Calendar API: calendars, events list/insert/patch/delete, privateExtendedProperty filter, calendarList. */
class FakeGoogle {
  calendars = new Map<string, FakeEvent[]>();
  /** summary/description of calendars created through `calendars.insert` (listed by calendarList) */
  calMeta = new Map<string, { summary?: string; description?: string }>();
  /** next `POST /calendars` / `POST …/events` fails this way (one-shot) */
  failCalendarInsert: WriteFailure | null = null;
  failEventInsert: WriteFailure | null = null;
  /** calendarList answers with this status instead (e.g. 403 without the calendar-list scope) */
  calendarListStatus: number | null = null;
  calls: { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null }[] = [];
  seq = 0;
  /** paths that 404 once */
  goneOnce = new Set<string>();

  constructor() {
    this.calendars.set(PRIMARY, []);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const path = url.pathname.replace("/calendar/v3", "");
    this.calls.push({ method, path, query: url.searchParams, body });
    const gone = `${method} ${path}`;
    if (this.goneOnce.has(gone)) {
      this.goneOnce.delete(gone);
      return json(404, { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } });
    }
    if (path === "/users/me/calendarList" && method === "GET") {
      if (this.calendarListStatus) return json(this.calendarListStatus, { error: { code: this.calendarListStatus, errors: [{ reason: "insufficientPermissions" }] } });
      const items = [{ id: PRIMARY, summary: PRIMARY, accessRole: "owner", primary: true }];
      for (const [id, m] of this.calMeta) if (this.calendars.has(id)) items.push({ id, ...m, accessRole: "owner", primary: false } as (typeof items)[number]);
      return json(200, { items });
    }
    if (path === "/calendars" && method === "POST") {
      const f = this.failCalendarInsert;
      this.failCalendarInsert = null;
      if (f && !f.applied) return failWith(f);
      const id = `aria${++this.seq}@group.calendar.google.com`;
      this.calendars.set(id, []);
      this.calMeta.set(id, { summary: body?.summary as string, description: body?.description as string });
      if (f) return failWith(f);
      return json(200, { id, summary: body?.summary });
    }
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return json(500, { error: { code: 500, message: "unscripted" } });
    const cal = decodeURIComponent(m[1] as string);
    const evId = m[2] ? decodeURIComponent(m[2]) : null;
    const list = this.calendars.get(cal);
    if (!list) return json(404, { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } });
    if (!evId && method === "GET") {
      const prop = url.searchParams.get("privateExtendedProperty");
      if (prop) {
        const [k, v] = prop.split("=");
        return json(200, { items: list.filter((e) => e.extendedProperties?.private?.[k as string] === v) });
      }
      const min = url.searchParams.get("timeMin") as string;
      const max = url.searchParams.get("timeMax") as string;
      return json(200, {
        items: list.filter((e) => {
          const s = e.start.dateTime ?? `${e.start.date}T00:00:00Z`;
          const en = e.end.dateTime ?? `${e.end.date}T00:00:00Z`;
          return new Date(en) > new Date(min) && new Date(s) < new Date(max);
        }),
      });
    }
    if (!evId && method === "POST") {
      const f = this.failEventInsert;
      this.failEventInsert = null;
      if (f && !f.applied) return failWith(f);
      const ev: FakeEvent = {
        id: `ev${String(++this.seq).padStart(24, "0")}`,
        summary: body?.summary as string,
        start: body?.start as FakeEvent["start"],
        end: body?.end as FakeEvent["end"],
        extendedProperties: body?.extendedProperties as FakeEvent["extendedProperties"],
        htmlLink: "https://www.google.com/calendar/event?eid=x",
      };
      list.push(ev);
      if (f) return failWith(f);
      return json(200, ev);
    }
    const ev = list.find((e) => e.id === evId);
    if (!ev) return json(404, { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } });
    if (method === "PATCH") {
      if (body?.start) ev.start = body.start as FakeEvent["start"];
      if (body?.end) ev.end = body.end as FakeEvent["end"];
      return json(200, ev);
    }
    if (method === "DELETE") {
      list.splice(list.indexOf(ev), 1);
      return new Response(null, { status: 204 });
    }
    return json(500, { error: { code: 500, message: "unscripted" } });
  };

  count(method: string, re: RegExp): number {
    return this.calls.filter((c) => c.method === method && re.test(c.path)).length;
  }
}

function failWith(f: WriteFailure): Response {
  if (f.kind === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  if (f.kind === "network") throw new TypeError("fetch failed");
  return json(f.kind, { error: { code: f.kind, errors: [{ reason: f.kind === 429 ? "rateLimitExceeded" : "backendError" }] } });
}

function setup(rowOver: Partial<GoogleIntegration> = {}) {
  const g = new FakeGoogle();
  const row = googleRow(key, { scopes: SCOPES, now: NOW, gcal_calendar_ids: [PRIMARY], ...rowOver });
  const store = new MemoryStore(row);
  const updates: Partial<GoogleIntegration>[] = [];
  const upserts: TimelineItemInput[] = [];
  const removed: string[] = [];
  const items = new Map<string, TimelineItem>();
  const deps: AriaCalendarDeps = {
    api: { fetch: g.fetch, tokens: { store, key, now: () => NOW }, sleep: async () => undefined },
    load: async () => row,
    update: async (_id, patch) => {
      updates.push(patch);
      Object.assign(row, patch);
    },
    timezone: async () => TZ,
    busy: { timeline: async () => [], meetings: async () => [] },
    getItem: async (_u, id) => items.get(id) ?? null,
    upsertItem: async (_u, _s, item) => {
      upserts.push(item);
      return { id: `item-${item.externalId}` };
    },
    removeItem: async (_u, ext) => {
      removed.push(ext);
    },
  };
  return { g, row, deps, updates, upserts, removed, items };
}

const at = (iso: string) => new Date(iso);
const input = (over: Partial<Parameters<typeof createBlock>[1]> = {}) => ({
  title: "Gym",
  start: at("2026-10-15T22:30:00Z"),
  end: at("2026-10-15T23:30:00Z"),
  ariaKey: "k1",
  allowOverlap: false,
  ...over,
});

function timelineItem(over: Partial<TimelineItem>): TimelineItem {
  return {
    id: "blk-1",
    userId: USER,
    source: "aria",
    externalId: "x|y",
    kind: "block",
    title: "Gym",
    course: null,
    startsAt: at("2026-10-15T22:30:00Z"),
    endsAt: at("2026-10-15T23:30:00Z"),
    dueAt: null,
    allDay: false,
    url: null,
    timingKey: null,
    matchKey: null,
    status: "upcoming",
    anchorAt: null,
    removedAt: null,
    updatedAt: NOW,
    raw: null,
    ...over,
  };
}

beforeEach(() => {
  resetAmbiguousCalendarMemo();
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("createBlock", () => {
  it("creates the Aria calendar once on the first write and reuses it after", async () => {
    const t = setup();
    const r1 = await createBlock(USER, input(), t.deps);
    expect(r1).toMatchObject({ ok: true, eventId: expect.stringMatching(/^ev/) });
    const ariaId = t.row.gcal_aria_calendar_id as string;
    expect(ariaId).toBe("aria1@group.calendar.google.com");
    expect(t.updates).toEqual([{ gcal_aria_calendar_id: ariaId }]);
    const createCal = t.g.calls.find((c) => c.method === "POST" && c.path === "/calendars");
    expect(createCal?.body).toEqual({ summary: "Aria", description: "Blocks Aria scheduled for you. Hide or delete anytime.", timeZone: TZ });

    const insert = t.g.calls.find((c) => c.method === "POST" && c.path.endsWith("/events"));
    expect(insert?.path).toBe(`/calendars/${encodeURIComponent(ariaId)}/events`);
    expect(insert?.body).toMatchObject({
      summary: "Gym",
      description: "Added by Aria",
      start: { dateTime: "2026-10-15T22:30:00.000Z", timeZone: TZ },
      end: { dateTime: "2026-10-15T23:30:00.000Z", timeZone: TZ },
      extendedProperties: { private: { aria: "1", aria_key: "k1" } },
    });
    // never a write to the primary calendar
    expect(t.g.calls.some((c) => c.method !== "GET" && c.path.includes(encodeURIComponent(PRIMARY)))).toBe(false);
    expect(t.upserts[0]).toMatchObject({ kind: "block", externalId: `${ariaId}|${(r1 as { eventId: string }).eventId}`, raw: { calendar_id: ariaId, aria_key: "k1" } });

    const r2 = await createBlock(USER, input({ ariaKey: "k2", start: at("2026-10-16T22:30:00Z"), end: at("2026-10-16T23:30:00Z") }), t.deps);
    expect(r2.ok).toBe(true);
    expect(t.g.count("POST", /^\/calendars$/)).toBe(1);
    expect(t.g.calendars.get(ariaId)).toHaveLength(2);
    expect(await ensureAriaCalendar(USER, t.deps)).toEqual({ calendarId: ariaId, recreated: false });
  });

  it("a retry with the same aria_key returns the existing event (no second insert)", async () => {
    const t = setup();
    const r1 = await createBlock(USER, input(), t.deps);
    const r2 = await createBlock(USER, input(), t.deps);
    expect(r2).toMatchObject({ ok: true, eventId: (r1 as { eventId: string }).eventId });
    expect(t.g.count("POST", /\/events$/)).toBe(1);
  });

  it("a 404 on insert (Aria calendar deleted) → recreate once + note", async () => {
    const t = setup({ gcal_aria_calendar_id: "old@group.calendar.google.com" });
    t.g.calendars.set("old@group.calendar.google.com", []);
    t.g.goneOnce.add(`POST /calendars/${encodeURIComponent("old@group.calendar.google.com")}/events`);
    const r = await createBlock(USER, input(), t.deps);
    expect(r).toMatchObject({ ok: true, note: "recreated the Aria calendar (the old one was deleted)" });
    expect(t.updates).toEqual([{ gcal_aria_calendar_id: null }, { gcal_aria_calendar_id: "aria1@group.calendar.google.com" }]);
    expect(t.g.calendars.get("aria1@group.calendar.google.com")).toHaveLength(1);
  });

  it("a 404 on the aria_key lookup (calendar gone) → recreate + note", async () => {
    const t = setup({ gcal_aria_calendar_id: "gone@group.calendar.google.com" });
    const r = await createBlock(USER, input(), t.deps);
    expect(r).toMatchObject({ ok: true, note: expect.stringContaining("recreated") });
    expect(t.row.gcal_aria_calendar_id).toBe("aria1@group.calendar.google.com");
  });

  it("re-checks conflicts live: busy overlaps refuse unless allowOverlap; transparent/all-day never conflict", async () => {
    const t = setup();
    t.g.calendars.set(PRIMARY, [
      { id: "free1", summary: "Office hours (free)", transparency: "transparent", start: { dateTime: "2026-10-15T22:00:00Z" }, end: { dateTime: "2026-10-15T23:00:00Z" } },
      { id: "allday", summary: "Fall break", start: { date: "2026-10-15" }, end: { date: "2026-10-16" } },
    ]);
    expect((await createBlock(USER, input({ ariaKey: "a" }), t.deps)).ok).toBe(true);

    t.g.calendars.get(PRIMARY)?.push({ id: "busy1", summary: "Dinner", start: { dateTime: "2026-10-16T23:00:00Z" }, end: { dateTime: "2026-10-17T00:00:00Z" } });
    const clash = await createBlock(USER, input({ ariaKey: "b", start: at("2026-10-16T22:30:00Z"), end: at("2026-10-16T23:30:00Z") }), t.deps);
    expect(clash).toEqual({ ok: false, reason: "conflict", conflicts: [{ start: at("2026-10-16T23:00:00Z"), end: at("2026-10-17T00:00:00Z") }] });

    const forced = await createBlock(USER, input({ ariaKey: "c", start: at("2026-10-16T22:30:00Z"), end: at("2026-10-16T23:30:00Z"), allowOverlap: true }), t.deps);
    expect(forced.ok).toBe(true);
  });

  it("class meetings and timed Canvas/syllabus items conflict too", async () => {
    const t = setup();
    t.deps.busy = {
      timeline: async () => [{ source: "canvas", kind: "exam", startsAt: at("2026-10-15T23:00:00Z"), endsAt: null, allDay: false }],
      meetings: async () => [],
    };
    const r = await createBlock(USER, input(), t.deps);
    expect(r).toMatchObject({ ok: false, reason: "conflict" });
    t.deps.busy = { timeline: async () => [], meetings: async () => [{ days: ["TH"], start: "18:00", end: "19:15" }] };
    expect(await createBlock(USER, input({ ariaKey: "z" }), t.deps)).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("no calendar_write scope / inactive → no_permission without touching Google", async () => {
    const t = setup({ scopes: SCOPES.filter((s) => !s.endsWith("app.created")) });
    expect(await createBlock(USER, input(), t.deps)).toEqual({ ok: false, reason: "no_permission" });
    const t2 = setup({ status: "revoked" });
    expect(await createBlock(USER, input(), t2.deps)).toEqual({ ok: false, reason: "no_permission" });
    expect(t.g.calls.length + t2.g.calls.length).toBe(0);
    await expect(ensureAriaCalendar(USER, t.deps)).rejects.toThrow(/calendar_write/);
  });
});

describe("moveBlock / deleteBlock", () => {
  async function withBlock() {
    const t = setup();
    const r = await createBlock(USER, input(), t.deps);
    if (!r.ok) throw new Error("setup");
    const ariaId = t.row.gcal_aria_calendar_id as string;
    t.items.set("blk-1", timelineItem({ externalId: `${ariaId}|${r.eventId}`, raw: { calendar_id: ariaId } }));
    return { ...t, ariaId, eventId: r.eventId };
  }

  it("moves an Aria block (its own old time doesn't count as a conflict)", async () => {
    const t = await withBlock();
    const r = await moveBlock(USER, "blk-1", at("2026-10-15T23:00:00Z"), at("2026-10-16T00:00:00Z"), t.deps);
    expect(r).toEqual({ ok: true });
    const patch = t.g.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`/calendars/${encodeURIComponent(t.ariaId)}/events/${t.eventId}`);
    expect(patch?.body).toEqual({ start: { dateTime: "2026-10-15T23:00:00.000Z", timeZone: TZ }, end: { dateTime: "2026-10-16T00:00:00.000Z", timeZone: TZ } });
    expect(t.upserts.at(-1)).toMatchObject({ startsAt: at("2026-10-15T23:00:00Z"), endsAt: at("2026-10-16T00:00:00Z") });
  });

  it("refuses a conflicting move", async () => {
    const t = await withBlock();
    t.g.calendars.get(PRIMARY)?.push({ id: "b", start: { dateTime: "2026-10-16T14:00:00Z" }, end: { dateTime: "2026-10-16T15:00:00Z" } });
    expect(await moveBlock(USER, "blk-1", at("2026-10-16T14:30:00Z"), at("2026-10-16T15:30:00Z"), t.deps)).toEqual({ ok: false, reason: "conflict" });
    expect(t.g.count("PATCH", /./)).toBe(0);
  });

  it("refuses non-Aria items and blocks on another calendar; unknown → not_found", async () => {
    const t = await withBlock();
    t.items.set("gcal-1", timelineItem({ id: "gcal-1", source: "gcal", kind: "event", externalId: `${PRIMARY}|e1`, raw: { calendar_id: PRIMARY } }));
    t.items.set("old-1", timelineItem({ id: "old-1", externalId: "old@group.calendar.google.com|e2", raw: { calendar_id: "old@group.calendar.google.com" } }));
    const s = at("2026-10-17T14:00:00Z");
    const e = at("2026-10-17T15:00:00Z");
    expect(await moveBlock(USER, "gcal-1", s, e, t.deps)).toEqual({ ok: false, reason: "not_aria_block" });
    expect(await moveBlock(USER, "old-1", s, e, t.deps)).toEqual({ ok: false, reason: "not_aria_block" });
    expect(await deleteBlock(USER, "gcal-1", t.deps)).toEqual({ ok: false, reason: "not_aria_block" });
    expect(await moveBlock(USER, "nope", s, e, t.deps)).toEqual({ ok: false, reason: "not_found" });
    expect(t.g.count("PATCH", /./) + t.g.count("DELETE", /./)).toBe(0);
  });

  it("deletes an Aria block; a 404 from Google still counts as deleted", async () => {
    const t = await withBlock();
    expect(await deleteBlock(USER, "blk-1", t.deps)).toEqual({ ok: true });
    expect(t.g.calendars.get(t.ariaId)).toHaveLength(0);
    expect(t.removed).toEqual([`${t.ariaId}|${t.eventId}`]);
    // already gone in Google
    expect(await deleteBlock(USER, "blk-1", t.deps)).toEqual({ ok: true });
    expect(t.removed).toHaveLength(2);
  });
});

describe("ambiguous writes are never re-sent (review 5.5 #1)", () => {
  const ARIA = "aria1@group.calendar.google.com";
  const KINDS: WriteFailure["kind"][] = ["timeout", "network", 500, 503, 429];

  it.each(KINDS)("events.insert %s but the event was created → found by aria_key, one insert", async (kind) => {
    const t = setup({ gcal_aria_calendar_id: ARIA });
    t.g.calendars.set(ARIA, []);
    t.g.failEventInsert = { kind, applied: true };
    const r = await createBlock(USER, input(), t.deps);
    expect(r).toMatchObject({ ok: true, eventId: expect.stringMatching(/^ev/) });
    expect(t.g.count("POST", /\/events$/)).toBe(1);
    expect(t.g.calendars.get(ARIA)).toHaveLength(1);
    expect(t.upserts).toHaveLength(1);
    // the lookup after the failure used the same aria_key
    const lookups = t.g.calls.filter((c) => c.method === "GET" && c.query.get("privateExtendedProperty") === "aria_key=k1");
    expect(lookups.length).toBeGreaterThanOrEqual(2); // step-1 lookup + the post-failure lookup
  });

  it.each(KINDS)("events.insert %s and nothing was created → GoogleWriteUnknownError, no second insert", async (kind) => {
    const t = setup({ gcal_aria_calendar_id: ARIA });
    t.g.calendars.set(ARIA, []);
    t.g.failEventInsert = { kind, applied: false };
    await expect(createBlock(USER, input(), t.deps)).rejects.toBeInstanceOf(GoogleWriteUnknownError);
    expect(t.g.count("POST", /\/events$/)).toBe(1);
    expect(t.g.calendars.get(ARIA)).toHaveLength(0);
    expect(t.upserts).toHaveLength(0);
  });

  it("a same-run retry after an unknown insert that landed late reuses the event (step-1 lookup)", async () => {
    const t = setup({ gcal_aria_calendar_id: ARIA });
    t.g.calendars.set(ARIA, []);
    t.g.failEventInsert = { kind: "timeout", applied: false };
    await expect(createBlock(USER, input(), t.deps)).rejects.toBeInstanceOf(GoogleWriteUnknownError);
    // Google finishes the write after we gave up
    t.g.calendars.get(ARIA)?.push({
      id: "evlate000000000000000000",
      summary: "Gym",
      start: { dateTime: "2026-10-15T22:30:00.000Z" },
      end: { dateTime: "2026-10-15T23:30:00.000Z" },
      extendedProperties: { private: { aria: "1", aria_key: "k1" } },
    });
    const r = await createBlock(USER, input(), t.deps);
    expect(r).toMatchObject({ ok: true, eventId: "evlate000000000000000000" });
    expect(t.g.count("POST", /\/events$/)).toBe(1);
  });

  it.each(KINDS)("calendars.insert %s but the calendar was created → adopted from the calendar list, one create", async (kind) => {
    const t = setup();
    t.g.failCalendarInsert = { kind, applied: true };
    const r = await createBlock(USER, input(), t.deps);
    expect(r).toMatchObject({ ok: true });
    expect(t.g.count("POST", /^\/calendars$/)).toBe(1);
    expect(t.row.gcal_aria_calendar_id).toBe(ARIA);
    expect(t.updates).toEqual([{ gcal_aria_calendar_id: ARIA }]);
    expect(t.g.calendars.get(ARIA)).toHaveLength(1);
    const list = t.g.calls.find((c) => c.path === "/users/me/calendarList");
    expect(list?.query.get("minAccessRole")).toBe("owner");
  });

  it("calendars.insert unknown, nothing created, list empty → error; the next try looks first, then creates once", async () => {
    const t = setup();
    t.g.failCalendarInsert = { kind: 503, applied: false };
    await expect(createBlock(USER, input(), t.deps)).rejects.toBeInstanceOf(GoogleWriteUnknownError);
    expect(t.g.count("POST", /^\/calendars$/)).toBe(1);
    expect(t.row.gcal_aria_calendar_id).toBeNull();
    const listsBefore = t.g.count("GET", /calendarList$/);
    const r = await createBlock(USER, input(), t.deps);
    expect(r.ok).toBe(true);
    expect(t.g.count("GET", /calendarList$/)).toBe(listsBefore + 1); // looked before creating
    expect(t.g.count("POST", /^\/calendars$/)).toBe(2);
    expect(t.g.calMeta.size).toBe(1);
  });

  it("calendars.insert unknown and the list can't be read → refuses to create another until it can look", async () => {
    const t = setup();
    t.g.calendarListStatus = 403;
    t.g.failCalendarInsert = { kind: "timeout", applied: true };
    await expect(createBlock(USER, input(), t.deps)).rejects.toBeInstanceOf(GoogleWriteUnknownError);
    await expect(createBlock(USER, input(), t.deps)).rejects.toMatchObject({ reason: "aria_calendar_unverified", retryable: true });
    expect(t.g.count("POST", /^\/calendars$/)).toBe(1);
    // once the list is readable again, the calendar the first try made is adopted
    t.g.calendarListStatus = null;
    const r = await createBlock(USER, input(), t.deps);
    expect(r.ok).toBe(true);
    expect(t.g.count("POST", /^\/calendars$/)).toBe(1);
    expect(t.row.gcal_aria_calendar_id).toBe(ARIA);
  });

  it("a user calendar named Aria with another description is never adopted", async () => {
    const t = setup();
    t.g.calendars.set("mine@group.calendar.google.com", []);
    t.g.calMeta.set("mine@group.calendar.google.com", { summary: "Aria", description: "my own stuff" });
    t.g.failCalendarInsert = { kind: 500, applied: false };
    await expect(createBlock(USER, input(), t.deps)).rejects.toBeInstanceOf(GoogleWriteUnknownError);
    expect(t.row.gcal_aria_calendar_id).toBeNull();
  });

  it("the normal path never reads the calendar list", async () => {
    const t = setup();
    expect((await createBlock(USER, input(), t.deps)).ok).toBe(true);
    expect(t.g.count("GET", /calendarList$/)).toBe(0);
  });
});
