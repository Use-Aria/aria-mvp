/**
 * Canvas sync + connect + tools smoke (task 3.4; V2-05 §10.3 items 7, 8, 10, plus the T6/T7
 * end-to-end path) against the LOCAL Supabase stack by default (keys + DB URL from
 * `supabase status -o json`; `SMOKE_TARGET=env` uses NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY and skips item 10, which needs psql).
 *
 * Never touches a real Canvas server: fixture ICS from tests/fixtures/canvas is served through an
 * injected resolver + transport (`connectCanvasWith` / `runCanvasSyncWith` seams). Throwaway users
 * (cascade: integrations, timeline items, channels, messages) and their jobs are deleted in
 * afterAll. A throwaway APP_ENCRYPTION_KEY is used (Jest does not load .env.local).
 *
 *  7. saveCanvasIntegration → `enc_ical_url` is `v1:`; readFeedUrl round-trips; the same feed on a
 *     second user → already_connected_elsewhere.
 *  8. claimSyncLease twice → second false; release → claimable again.
 * 10. The `canvas-sync-enqueue` cron body (read from cron.job, scoped to the test user) run twice →
 *     exactly one pending canvas_sync.
 *  +  web connect (initial batch, confirmation via deliver, profile refresh) → unchanged skip →
 *     override rekey (due_changed batch) → revoke after 3 definitive failures over ≥ 2h (one notice)
 *     → chat reconnect through `connect_canvas` (user-authored URL, inbound body redacted) →
 *     requestCanvasSync + job handler kill-switch → disconnect (removed batch, row deleted).
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

interface Target {
  url: string;
  serviceKey: string;
  dbUrl: string | null;
}

function localTarget(): Target {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY, dbUrl: s.DB_URL ?? null };
}
function envTarget(): Target {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SMOKE_TARGET=env needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  return { url, serviceKey, dbUrl: null };
}
const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CANVAS_SYNC_DISABLED;
process.env.CHANNEL_PROVIDER = "dev";

import { AliasTable } from "@/server/agent/context/aliases";
import { dbInboundReader, runConnectCanvas, REDACTED_FEED_PLACEHOLDER } from "@/server/agent/tools/connect-canvas";
import type { ToolCtx } from "@/server/agent/types";
import { getProvider } from "@/server/channels";
import type { DevProvider } from "@/server/channels/providers/dev";
import { redactInboundBodies } from "@/server/channels/repo";
import type { ChannelProvider } from "@/server/channels/types";
import { connectCanvasWith, disconnectCanvas, getCanvasStatus, requestCanvasSync } from "@/server/integrations/canvas/connect";
import type { FeedTransport, PinnedRequest, PinnedResponse } from "@/server/integrations/canvas/fetch-feed";
import type { Resolver } from "@/server/integrations/canvas/ssrf";
import {
  claimSyncLease,
  feedUrlFingerprint,
  readFeedUrl,
  releaseSyncLease,
  saveCanvasIntegration,
} from "@/server/integrations/canvas/store";
import { runCanvasSyncWith, type CanvasSyncDeps } from "@/server/integrations/canvas/sync";
import { canvasSync } from "@/server/jobs/kinds/canvas-sync";
import type { TimelineChangeBatch } from "@/server/timeline/types";
import { normalizeCanvasFeedUrl, type CanvasFeedUrl } from "@/shared/canvas-url";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN = randomUUID().slice(0, 8);
const HOST = `smoke-${RUN}.instructure.com`;
const NOW = new Date("2026-10-10T15:00:00Z");
const HOUR = 3_600_000;
const userIds: string[] = [];

function isDev(p: ChannelProvider): p is DevProvider {
  return "transcript" in p;
}
const dev = getProvider("dev");
if (!isDev(dev)) throw new Error("expected the dev provider");

// ── fixture feeds ───────────────────────────────────────────────────────────

const FIXTURES = join(__dirname, "..", "fixtures", "canvas");
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
/** basic.ics with the VEVENTs of another fixture appended (stays real-shaped: CRLF, folded). */
function combined(extra: string): Uint8Array {
  const base = fixture("basic.ics");
  const x = fixture(extra);
  const events = x.slice(x.indexOf("BEGIN:VEVENT"), x.lastIndexOf("END:VCALENDAR"));
  const at = base.lastIndexOf("END:VCALENDAR");
  return new TextEncoder().encode(base.slice(0, at) + events + base.slice(at));
}
const BEFORE = combined("override-before.ics");
const AFTER = combined("override-after.ics");

function feedId(): string {
  let s = "";
  while (s.length < 40) s += randomBytes(48).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return s.slice(0, 40);
}
function feedUrl(id: string): CanvasFeedUrl {
  const r = normalizeCanvasFeedUrl(`https://${HOST}/feeds/calendars/user_${id}.ics`);
  if (!r.ok) throw new Error(r.error);
  return r.url;
}

/** Fake Canvas: serves `state.body` (or a 400 public_feed) for any request; records hosts. */
const state: { body: Uint8Array; revoked: boolean; requests: PinnedRequest[] } = { body: BEFORE, revoked: false, requests: [] };
const transport: FeedTransport = {
  async request(args: PinnedRequest): Promise<PinnedResponse> {
    state.requests.push(args);
    const chunks = state.revoked ? [new TextEncoder().encode("<html>unauthorized</html>")] : [state.body];
    const headers: Record<string, string> = state.revoked
      ? { "content-type": "text/html; charset=utf-8", "x-canvas-meta": "o=calendar_events_api;n=public_feed;" }
      : { "content-type": "text/calendar; charset=utf-8", "x-canvas-meta": "o=calendar_events_api;n=public_feed;" };
    return {
      status: state.revoked ? 400 : 200,
      headers,
      body: (async function* () {
        for (const c of chunks) yield c;
      })(),
      abort: () => undefined,
    };
  },
};
const resolver: Resolver = async () => [{ address: "13.32.241.71", family: 4 }];
const deps: CanvasSyncDeps = { fetchOptions: { resolver, transport }, rand: () => 0.5 };

// ── helpers ─────────────────────────────────────────────────────────────────

async function newUser(tz = "America/New_York"): Promise<string> {
  const { data, error } = await sb
    .from("users")
    .insert({ name: `smoke-canvas-${RUN}`, timezone: tz })
    .select("id")
    .single();
  if (error) throw error;
  userIds.push(data.id);
  return data.id;
}

async function integration(userId: string) {
  const { data, error } = await sb.from("integrations").select("*").eq("user_id", userId).eq("provider", "canvas_ical").maybeSingle();
  if (error) throw error;
  return data;
}

async function batches(userId: string): Promise<TimelineChangeBatch[]> {
  const { data, error } = await sb
    .from("jobs")
    .select("payload, created_at")
    .eq("user_id", userId)
    .eq("kind", "timeline_changes")
    .order("created_at");
  if (error) throw error;
  return data.map((r) => r.payload as unknown as TimelineChangeBatch);
}

async function canvasRows(userId: string) {
  const { data, error } = await sb
    .from("timeline_items")
    .select("id, external_id, match_key, removed_at, due_at, all_day, timing_key, title")
    .eq("user_id", userId)
    .eq("source", "canvas");
  if (error) throw error;
  return data;
}

function toolCtx(userId: string, runId: string, messageId: string): { ctx: ToolCtx; evidence: string } {
  const aliases = new AliasTable();
  const evidence = aliases.mint("m", messageId);
  return {
    evidence,
    ctx: {
      userId,
      runId,
      now: NOW,
      timezone: "America/New_York",
      channel: {
        channelId: "c",
        provider: "dev",
        kind: "imessage",
        service: "imessage",
        handleKind: "phone",
        capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
        windowOpen: true,
      },
      trigger: { kind: "inbound" },
      aliases,
      evidence: new Set([evidence]),
      userText: "",
      taint: { tainted: false, mark: () => undefined },
      links: { add: () => "L1", resolve: () => null },
      interim: { sent: false, send: async () => false },
      signal: new AbortController().signal,
      log: () => undefined,
    },
  };
}

afterAll(async () => {
  if (userIds.length === 0) return;
  await sb.from("jobs").delete().in("user_id", userIds);
  for (const u of userIds) await sb.from("jobs").delete().like("dedupe_key", `%${u}%`);
  await sb.from("users").delete().in("id", userIds);
});

// ── 7 / 8 / 10: store + cron ────────────────────────────────────────────────

describe("canvas store + cron (V2-05 §10.3 items 7, 8, 10)", () => {
  let b = "";
  const url = feedUrl(feedId());

  it("7. save encrypts (v1:), readFeedUrl round-trips, a second account with the same feed is refused", async () => {
    b = await newUser();
    const c = await newUser();
    expect(await saveCanvasIntegration(b, url, NOW)).toEqual({ ok: true, urlChanged: true });
    const row = await integration(b);
    expect(row?.enc_ical_url?.startsWith("v1:")).toBe(true);
    expect(row?.enc_ical_url).not.toContain(url.href.slice(-20));
    expect(row).toMatchObject({ ical_host: HOST, ical_url_fp: feedUrlFingerprint(url.href), status: "active", synced_at: null });
    expect((await readFeedUrl(b))?.href).toBe(url.href);
    expect(await saveCanvasIntegration(b, url, NOW)).toEqual({ ok: true, urlChanged: false });
    expect(await saveCanvasIntegration(c, url, NOW)).toEqual({ ok: false, code: "already_connected_elsewhere" });
    expect(await integration(c)).toBeNull();
  });

  it("8. claimSyncLease is exclusive until released", async () => {
    expect(await claimSyncLease(b)).toBe(true);
    expect(await claimSyncLease(b)).toBe(false);
    await releaseSyncLease(b);
    expect(await claimSyncLease(b)).toBe(true);
    await releaseSyncLease(b);
  });

  const psqlIt = target.dbUrl ? it : it.skip;
  psqlIt("10. the canvas-sync-enqueue cron body run twice → exactly one pending canvas_sync", async () => {
    const dbUrl = target.dbUrl ?? "";
    await sb
      .from("integrations")
      .update({ next_sync_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("user_id", b)
      .eq("provider", "canvas_ical");
    const command = execFileSync("psql", [dbUrl, "-At", "-c", "select command from cron.job where jobname = 'canvas-sync-enqueue'"], {
      encoding: "utf8",
    });
    const anchor = "where i.provider = 'canvas_ical'";
    expect(command).toContain(anchor);
    // Scope the real cron body to this test user so other agents' rows are never touched.
    const scoped = command.replace(anchor, `${anchor} and i.user_id = '${b}'`);
    for (let i = 0; i < 2; i++) execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-q", "-c", scoped], { encoding: "utf8" });
    const { data, error } = await sb
      .from("jobs")
      .select("id, kind, status, payload")
      .eq("dedupe_key", `canvas_sync:${b}`)
      .eq("status", "pending");
    if (error) throw error;
    expect(data).toHaveLength(1);
    expect(data[0].kind).toBe("canvas_sync");
  });
});

// ── end-to-end ──────────────────────────────────────────────────────────────

describe("canvas connect → sync → revoke → chat reconnect → disconnect", () => {
  let a = "";
  let channelId = "";
  const handle = `+1555010${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
  const first = feedUrl(feedId());
  const second = feedUrl(feedId());
  let pset5Id = "";

  beforeAll(async () => {
    a = await newUser();
    const { data, error } = await sb
      .from("channels")
      .insert({ user_id: a, kind: "imessage", handle, handle_kind: "phone", provider: "dev", is_primary: true })
      .select("id")
      .single();
    if (error) throw error;
    channelId = data.id;
    dev.reset();
  });

  it("web connect: initial apply + batch, encrypted URL, chat confirmation, profile refresh", async () => {
    state.body = BEFORE;
    const raw = ` <webcal://${HOST}/feeds/calendars/user_${first.href.split("user_")[1]}> `;
    const r = await connectCanvasWith({ userId: a, rawUrl: raw, via: "web", schoolName: "Yale University", now: NOW }, deps);
    if (!r.ok) throw new Error(r.code);
    expect(r).toMatchObject({ host: HOST, itemCount: 8, upcomingCount: 5 });
    expect(r.text).toMatch(/^found 5 deadlines across 3 courses — next up: Essay 2 Draft \(ENGL 120\), due /);
    expect(state.requests.at(-1)?.url.hostname).toBe(HOST);
    expect(state.requests.at(-1)?.pinned.address).toBe("13.32.241.71");

    const row = await integration(a);
    expect(row).toMatchObject({ status: "active", ical_host: HOST, consecutive_failures: 0, last_error: null });
    expect(row?.enc_ical_url?.startsWith("v1:")).toBe(true);
    expect(row?.synced_at).not.toBeNull();
    expect(row?.sync_lease_until).toBeNull();
    const next = new Date(row?.next_sync_at ?? 0).getTime();
    expect(next).toBeGreaterThan(NOW.getTime() + 30 * 60_000);
    expect(next).toBeLessThanOrEqual(NOW.getTime() + 90 * 60_000 + 60_000);

    const rows = await canvasRows(a);
    expect(rows).toHaveLength(8);
    const essay = rows.find((x) => x.external_id === "event-assignment-412400");
    expect(essay).toMatchObject({ all_day: true, timing_key: "D:20261015" });
    expect(new Date(essay?.due_at ?? 0).toISOString()).toBe("2026-10-16T03:59:00.000Z");
    pset5Id = rows.find((x) => x.external_id === "event-assignment-500")?.id ?? "";
    expect(pset5Id).not.toBe("");

    const bs = await batches(a);
    expect(bs).toHaveLength(1);
    expect(bs[0].initial).toBe(true);
    expect(bs[0].changes).toHaveLength(8);

    const sent = dev.transcript().filter((e) => e.op === "send" && e.handle === handle);
    expect(sent).toHaveLength(1);
    expect(sent[0].op === "send" && sent[0].text).toMatch(/^canvas connected: found 5 deadlines/);

    const { data: profile } = await sb.from("user_profile").select("school, courses").eq("user_id", a).maybeSingle();
    expect(profile?.school).toBe("Yale University");
    expect(JSON.stringify(profile?.courses)).toContain("ENGL 120");
  });

  it("unchanged feed → skipped; override UID swap → one rekey + due_changed batch (same row)", async () => {
    const skip = await runCanvasSyncWith(a, { reason: "scheduled", now: new Date(NOW.getTime() + HOUR) }, deps);
    expect(skip).toMatchObject({ ok: true, skipped: "unchanged" });
    expect(await batches(a)).toHaveLength(1);

    state.body = AFTER;
    const r = await runCanvasSyncWith(a, { reason: "manual", now: new Date(NOW.getTime() + HOUR) }, deps);
    if (!r.ok) throw new Error(r.code);
    expect(r).toMatchObject({ skipped: null, initial: false, result: { rekeyed: 1, dueChanged: 1, removed: 0 } });
    const rows = await canvasRows(a);
    const pset5 = rows.find((x) => x.external_id === "event-assignment-override-77");
    expect(pset5?.id).toBe(pset5Id);
    expect(pset5?.title).toBe("Pset 5 (Extension)");
    const bs = await batches(a);
    expect(bs).toHaveLength(2);
    expect(bs[1]).toMatchObject({ initial: false });
    expect(bs[1].changes).toEqual([
      expect.objectContaining({ itemId: pset5Id, kind: "due_changed", rekeyed: true, deliveryHint: "immediate" }),
    ]);
  });

  it("3 definitive failures over ≥ 2h → revoked, one notice queued, status view says revoked", async () => {
    state.revoked = true;
    const t = (h: number) => new Date(NOW.getTime() + h * HOUR);
    const r1 = await runCanvasSyncWith(a, { reason: "scheduled", now: t(2) }, deps);
    expect(r1).toEqual({ ok: false, code: "feed_not_found", cls: "definitive" });
    expect(await integration(a)).toMatchObject({ status: "active", consecutive_failures: 1, last_error: "feed_not_found" });
    await runCanvasSyncWith(a, { reason: "scheduled", now: t(3) }, deps);
    await runCanvasSyncWith(a, { reason: "scheduled", now: t(4) }, deps);
    const row = await integration(a);
    expect(row).toMatchObject({ status: "revoked", next_sync_at: null, status_reason: "feed_not_found", consecutive_failures: 3 });
    expect(row?.status_notified_at).not.toBeNull();
    expect(await runCanvasSyncWith(a, { reason: "scheduled", now: t(5) }, deps)).toMatchObject({ ok: false, code: "no_integration" });

    const { data: flush } = await sb.from("jobs").select("payload").eq("user_id", a).eq("kind", "proactive_flush");
    const reasons = (flush ?? []).flatMap((j) => ((j.payload as { items?: { reason: string }[] }).items ?? []).map((i) => i.reason));
    expect(reasons.filter((x) => x === "canvas_feed_revoked")).toHaveLength(1);

    const status = await getCanvasStatus(a, t(5));
    expect(status).toMatchObject({ connected: true, host: HOST, health: "revoked", lastError: "feed_not_found", upcomingCount: 5 });
    if (status.connected) expect(status.urlHint).toBe(`${HOST}/feeds/…${first.href.slice(-8, -4)}`);
  });

  it("chat reconnect via connect_canvas: URL from the student's own message, body redacted, status reset", async () => {
    state.revoked = false;
    state.body = AFTER;
    const runId = randomUUID();
    const { data: msg, error } = await sb
      .from("messages")
      .insert({ user_id: a, channel_id: channelId, direction: "in", body: `new link: ${second.href} thanks!`, consumed_by_run: runId })
      .select("id")
      .single();
    if (error) throw error;
    dev.reset();
    const batchesBefore = (await batches(a)).length;
    const { ctx, evidence } = toolCtx(a, runId, msg.id);
    const res = await runConnectCanvas(ctx, { evidence }, {
      reader: dbInboundReader,
      connect: (input) => connectCanvasWith(input, deps),
      redact: redactInboundBodies,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toMatchObject({ connected: true, host: HOST, upcoming_deadlines: 5 });

    const { data: stored } = await sb.from("messages").select("body").eq("id", msg.id).single();
    expect(stored?.body).toBe(`new link: ${REDACTED_FEED_PLACEHOLDER} thanks!`);
    const row = await integration(a);
    expect(row).toMatchObject({ status: "active", consecutive_failures: 0, status_notified_at: null, ical_url_fp: feedUrlFingerprint(second.href) });
    expect(dev.transcript().filter((e) => e.op === "send")).toHaveLength(0); // chat path: the agent replies itself
    // New feed URL → an initial sync, but the items are the same rows (same UIDs), so the diff is
    // empty and no batch is enqueued (an initial batch only ever carries hint "none" anyway).
    expect(await batches(a)).toHaveLength(batchesBefore);
  });

  it("requestCanvasSync enqueues one deduped job; the job handler honours the kill-switch", async () => {
    await requestCanvasSync(a, "manual");
    await requestCanvasSync(a, "email_hint");
    const { data: pending } = await sb.from("jobs").select("payload").eq("dedupe_key", `canvas_sync:${a}`).eq("status", "pending");
    expect(pending).toHaveLength(1);
    expect(pending?.[0].payload).toEqual({ reason: "email_hint" });

    process.env.CANVAS_SYNC_DISABLED = "1";
    try {
      const before = (await integration(a))?.synced_at;
      const out = await canvasSync.run(
        {
          jobId: randomUUID(),
          kind: "canvas_sync",
          userId: a,
          attempt: 1,
          maxAttempts: 5,
          token: "t",
          now: NOW,
          deadline: Date.now() + 60_000,
          signal: new AbortController().signal,
        },
        { reason: "scheduled" },
      );
      expect(out).toEqual({ type: "done" });
      expect((await integration(a))?.synced_at).toBe(before);
    } finally {
      delete process.env.CANVAS_SYNC_DISABLED;
    }
  });

  it("disconnect: row deleted, items soft-removed with a removed batch, pending sync cancelled", async () => {
    const before = (await batches(a)).length;
    await disconnectCanvas(a);
    expect(await integration(a)).toBeNull();
    const rows = await canvasRows(a);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.removed_at !== null)).toBe(true);
    const bs = await batches(a);
    expect(bs.length).toBe(before + 1);
    expect(bs.at(-1)?.changes.every((c) => c.kind === "removed")).toBe(true);
    const { data: pending } = await sb.from("jobs").select("id").eq("dedupe_key", `canvas_sync:${a}`).eq("status", "pending");
    expect(pending).toHaveLength(0);
    expect(await getCanvasStatus(a)).toEqual({ connected: false });
    await disconnectCanvas(a); // idempotent
  });
});
