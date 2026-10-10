/**
 * Syllabus smoke (V2-08 T5/T6; master plan row 3.5), against the LOCAL Supabase stack by default
 * (`SMOKE_TARGET=env` for the env project, as in pipeline.smoke).
 *
 *  1. Dev-channel inbound with a PDF attachment → `read_syllabus` (tool) enqueues `syllabus_parse`.
 *  2. The job handler (run directly, never the global runner): SSRF-checked download from a local
 *     media server → signed parser call → `syllabi` + `timeline_items` + `llm_calls` rows →
 *     confirmation bubbles in the dev transcript.
 *  3. Re-run (job retry) → hash hit on the same message: no parser call, no double send.
 *     Same file via another path → "already have that one".
 *  4. `syllabus_info` (wrapped untrusted output), `getSyllabusSignals`, and `listTimeline`'s
 *     collapse of a Canvas twin.
 *  5. `POST /api/syllabus/upload`: cross-origin 403, oversize 413, hint guard → exists (+canReplace),
 *     replace=1 → parsed again and posted to the chat via `after()`.
 *
 * The parser is an in-test HTTP server that verifies the HMAC and serves the Python golden
 * (`response_ok.json`, sha patched). Set `SYLLABUS_SMOKE_PARSER_URL` (+ `SYLLABUS_SMOKE_PARSER_SECRET`)
 * to forward to a real parser instead, e.g. `PARSER_FAKE_LLM=1 python -m app` from services/parser.
 * Every row hangs off one throwaway user (cascade) plus its `llm_calls` (deleted explicitly).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";
import { loadContractFixture, makePdf, SYNTHETIC_SYLLABUS } from "../unit/syllabus/fixtures";

// `after()` outside a request scope throws; capture callbacks instead of running them.
const mockAfterTasks: Array<() => unknown> = [];
jest.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    mockAfterTasks.push(cb);
  },
}));
// Request-scoped headers/cookies for the upload route's guard.
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
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.CHANNEL_PROVIDER = "dev";
process.env.APP_BASE_URL = "http://localhost:3000";
const REAL_PARSER = process.env.SYLLABUS_SMOKE_PARSER_URL?.replace(/\/+$/, "") ?? "";
const SECRET = REAL_PARSER ? (process.env.SYLLABUS_SMOKE_PARSER_SECRET ?? "") : `smoke-parser-${randomUUID()}`;
process.env.PARSER_SHARED_SECRET = SECRET;
process.env.SYLLABUS_MEDIA_ALLOWED_HOSTS = "127.0.0.1";
process.env.SYLLABUS_UPLOAD_MAX_BYTES = "4000000";

import { getProvider } from "@/server/channels";
import type { DevProvider } from "@/server/channels/providers/dev";
import type { ChannelContext, ChannelProvider, InboundEvent } from "@/server/channels/types";
import { AliasTable } from "@/server/agent/context/aliases";
import { runReadSyllabus } from "@/server/agent/tools/read-syllabus";
import { runSyllabusInfo } from "@/server/agent/tools/syllabus-info";
import type { ToolCtx } from "@/server/agent/types";
import { getSyllabusSignals, runSyllabusIntake } from "@/server/integrations/syllabus";
import { signParserRequest } from "@/server/integrations/syllabus/signing";
import { cancelJobs } from "@/server/jobs/enqueue";
import { runSyllabusParseJob, syllabusJobKey } from "@/server/jobs/kinds/syllabus-parse";
import type { JobContext } from "@/server/jobs/types";
import { ingestEvents } from "@/server/pipeline/ingest";
import { createSession } from "@/server/security/sessions";
import { listTimeline, upsertTimelineItems } from "@/server/timeline";
import { POST as uploadRoute } from "@/app/api/syllabus/upload/route";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

function isDev(p: ChannelProvider): p is DevProvider {
  return "transcript" in p;
}
function devProvider(): DevProvider {
  const p = getProvider("dev");
  if (!isDev(p)) throw new Error("expected the dev provider");
  return p;
}
const dev = devProvider();

function must<T>(res: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${label}: no data`);
  return res.data;
}

// ── Local servers: media CDN stand-in + parser (fake or forwarding) ──────────
const PDF = makePdf(SYNTHETIC_SYLLABUS);
const PDF2 = makePdf([...SYNTHETIC_SYLLABUS, ["Revised Oct 1."]]);
const GOLDEN = loadContractFixture("response_ok.json") as Record<string, unknown>;
let parserCalls = 0;
let badSignatures = 0;
let mediaServer: http.Server;
let parserServer: http.Server;
let mediaUrl = "";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleParse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  parserCalls += 1;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
  if (REAL_PARSER) {
    const r = await fetch(`${REAL_PARSER}/v1/parse-syllabus`, { method: "POST", headers, body });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
    return;
  }
  const ts = Number(headers["x-aria-timestamp"]);
  const want = signParserRequest({ secret: SECRET, method: "POST", path: "/v1/parse-syllabus", body, timestamp: ts });
  if (headers["x-aria-signature"] !== want) {
    badSignatures += 1;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "bad_signature", message: "unauthorized", retryable: false } }));
    return;
  }
  const { pdf_base64 } = JSON.parse(body) as { pdf_base64: string };
  const sha = createHash("sha256").update(Buffer.from(pdf_base64, "base64")).digest("hex");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ...GOLDEN, pdf_sha256: sha }));
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const RUN = randomUUID().slice(0, 8);
let userId = "";
let messageId = "";
let handle = "";

const CHANNEL: ChannelContext = {
  channelId: "c",
  provider: "dev",
  kind: "imessage",
  service: "imessage",
  handleKind: "phone",
  capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
  windowOpen: true,
};

function toolCtx(): { ctx: ToolCtx; msgAlias: string; tainted: () => boolean } {
  const aliases = new AliasTable();
  const msgAlias = aliases.mint("m", messageId);
  let tainted = false;
  const ctx: ToolCtx = {
    userId,
    runId: randomUUID(),
    now: new Date(),
    timezone: "America/New_York",
    channel: CHANNEL,
    trigger: { kind: "inbound" },
    aliases,
    evidence: new Set([msgAlias]),
    userText: "here's my history syllabus",
    taint: {
      get tainted() {
        return tainted;
      },
      mark: () => {
        tainted = true;
      },
    },
    links: { add: () => "L1", resolve: () => null },
    interim: { sent: false, send: async () => true },
    signal: new AbortController().signal,
    log: () => undefined,
  };
  return { ctx, msgAlias, tainted: () => tainted };
}

function jobCtx(jobId: string, attempt = 1): JobContext {
  return {
    jobId,
    kind: "syllabus_parse",
    userId,
    attempt,
    maxAttempts: 2,
    token: randomUUID(),
    now: new Date(),
    deadline: Date.now() + 290_000,
    signal: new AbortController().signal,
  };
}

function sends(): string[] {
  return dev
    .transcript()
    .filter((e): e is Extract<ReturnType<DevProvider["transcript"]>[number], { op: "send" }> => e.op === "send" && e.handle === handle)
    .map((e) => e.text ?? "");
}

beforeAll(async () => {
  mediaServer = http.createServer((req, res) => {
    if (req.url === "/s.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": String(PDF.length) });
      res.end(PDF);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  parserServer = http.createServer((req, res) => {
    handleParse(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  const [mp, pp] = await Promise.all([listen(mediaServer), listen(parserServer)]);
  mediaUrl = `http://127.0.0.1:${mp}/s.pdf`;
  process.env.PARSER_SERVICE_URL = `http://127.0.0.1:${pp}`;
});

afterAll(async () => {
  if (userId) {
    await sb.from("llm_calls").delete().eq("user_id", userId);
    await sb.from("users").delete().eq("id", userId);
    const left = must(await sb.from("users").select("id").eq("id", userId), "cleanup check");
    expect(left).toHaveLength(0);
    const calls = must(await sb.from("llm_calls").select("id").eq("user_id", userId), "llm cleanup check");
    expect(calls).toHaveLength(0);
  }
  await new Promise<void>((r) => mediaServer.close(() => r()));
  await new Promise<void>((r) => parserServer.close(() => r()));
});

describe("syllabus intake (dev channel → tool → job → bubbles)", () => {
  let jobId = "";

  it("1: an inbound PDF from a fresh dev handle; read_syllabus enqueues syllabus_parse", async () => {
    for (let i = 0; i < 20 && !handle; i += 1) {
      const h = `+1555011${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
      if (must(await sb.from("channels").select("id").eq("handle", h), "probe").length === 0) handle = h;
    }
    const ev: InboundEvent = {
      type: "message",
      providerMessageId: `smoke-syl-${RUN}`,
      handle,
      handleKind: "phone",
      line: "dev",
      service: "imessage",
      text: "here's my history syllabus",
      media: [{ url: mediaUrl, kind: "pdf", filename: "hist101.pdf" }],
      sentAt: new Date(),
      providerOptedOut: false,
    };
    const [o] = await ingestEvents(dev, [ev]);
    if (o.kind !== "turn" || !o.messageId) throw new Error(`unexpected ingest outcome ${o.kind}`);
    userId = o.userId;
    messageId = o.messageId;
    await cancelJobs({ userId, kinds: ["conversation_turn"] });

    const { ctx, msgAlias } = toolCtx();
    const bad = await runReadSyllabus(ctx, { attachment: `${msgAlias}:3`, replace: false, evidence: msgAlias });
    expect(bad.ok).toBe(false);
    const noEvidence = await runReadSyllabus(ctx, { attachment: `${msgAlias}:0`, replace: false, evidence: "m_00000000" });
    expect(noEvidence.ok).toBe(false);

    const r = await runReadSyllabus(ctx, { attachment: `${msgAlias}:0`, replace: false, evidence: msgAlias });
    expect(r).toMatchObject({ ok: true, data: { status: "queued" } });
    const jobs = must(
      await sb.from("jobs").select("id, kind, status, dedupe_key, payload").eq("user_id", userId).eq("kind", "syllabus_parse"),
      "jobs",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "pending", dedupe_key: syllabusJobKey(messageId, 0) });
    expect(jobs[0].payload).toMatchObject({ messageId, mediaIndex: 0, replace: false });
    jobId = jobs[0].id;
    // Never let the shared runner pick it up; the handler is run directly below.
    expect(await cancelJobs({ ids: [jobId] })).toBe(1);
  });

  it("2: the job downloads, parses, stores, and confirms in the dev channel", async () => {
    const before = sends().length;
    const out = await runSyllabusParseJob(jobCtx(jobId), { messageId, mediaIndex: 0, replace: false });
    expect(out).toEqual({ type: "done" });
    expect(parserCalls).toBe(1);
    expect(badSignatures).toBe(0);

    const rows = must(await sb.from("syllabi").select("*").eq("user_id", userId), "syllabi");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      course_key: "HIST101",
      course_name: "HIST 101 The Ancient World",
      source: "dev",
      source_message_id: messageId,
      pdf_sha256: createHash("sha256").update(PDF).digest("hex"),
      status: "parsed",
    });

    const items = must(
      await sb.from("timeline_items").select("external_id, kind, title, all_day, raw").eq("user_id", userId).eq("source", "syllabus"),
      "timeline",
    );
    expect(items.map((i) => i.title).sort()).toEqual(["Final Exam", "Midterm"]); // the Sep 18 paper is past
    for (const i of items) expect(i.external_id.startsWith("syl:HIST101:")).toBe(true);

    const calls = must(await sb.from("llm_calls").select("route, model, job_id, cost_usd, meta").eq("user_id", userId), "llm_calls");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toMatchObject({ route: "syllabus", job_id: jobId });
    if (!REAL_PARSER) expect(Number(calls[0].cost_usd)).toBeGreaterThan(0);

    const bubbles = sends().slice(before);
    expect(bubbles.length).toBeGreaterThanOrEqual(1);
    expect(bubbles[0]).toContain("got your HIST 101 The Ancient World syllabus");
  });

  it("3: a retry is a hash hit (no parser call, no double send); same file elsewhere → already have it", async () => {
    const before = sends().length;
    const out = await runSyllabusParseJob(jobCtx(jobId, 2), { messageId, mediaIndex: 0, replace: false });
    expect(out).toEqual({ type: "done" });
    expect(parserCalls).toBe(1);
    expect(sends().length).toBe(before); // same `syl:<msg>:0` idempotency keys

    const again = await runSyllabusIntake({ userId, bytes: PDF, source: "upload" });
    expect(again).toMatchObject({ status: "exists", reason: "same_file", courseKey: "HIST101" });
    expect(parserCalls).toBe(1);
  });

  it("4: syllabus_info returns wrapped grading; signals and the Canvas collapse work", async () => {
    const { ctx, tainted } = toolCtx();
    const info = await runSyllabusInfo(ctx, { course: "HIST 101", aspect: "grading" });
    if (!info.ok || typeof info.data === "string") throw new Error("syllabus_info failed");
    expect(info.data.status).toBe("ok");
    expect(String(info.data.content)).toMatch(/^<untrusted source="syllabus"/);
    expect(String(info.data.content)).toContain("Midterm exam (25%)");
    expect(tainted()).toBe(true);
    const list = await runSyllabusInfo(ctx, { aspect: "overview" });
    expect(list).toMatchObject({ ok: true, data: { status: "ok", syllabi: [{ course: "HIST 101" }] } });
    const missing = await runSyllabusInfo(ctx, { course: "orgo", aspect: "overview" });
    expect(missing).toMatchObject({ ok: true, data: { status: "not_found", available: ["HIST 101"] } });

    const signals = await getSyllabusSignals(userId);
    expect(signals).toHaveLength(1);
    expect(signals[0].exams.find((e) => e.title === "Final Exam")?.topics).toEqual(["Classical Greece", "Rome"]);

    const from = new Date("2026-10-01T00:00:00Z");
    const to = new Date("2027-01-01T00:00:00Z");
    const beforeTwin = await listTimeline(userId, { from, to }, { timezone: "America/New_York" });
    expect(beforeTwin.filter((v) => v.source === "syllabus")).toHaveLength(2);
    await upsertTimelineItems(userId, [
      {
        source: "canvas",
        externalId: `event-assignment-smoke-${RUN}`,
        kind: "assignment",
        title: "Midterm Exam",
        course: "HIST 101 01 (FA26)",
        dueAt: new Date("2026-10-15T17:00:00Z"),
      },
    ]);
    const after = await listTimeline(userId, { from, to }, { timezone: "America/New_York" });
    expect(after.filter((v) => v.source === "syllabus").map((v) => v.title)).toEqual(["Final Exam"]);
    expect(after.some((v) => v.source === "canvas" && v.title === "Midterm Exam")).toBe(true);
  });

  it("5: /api/syllabus/upload guards, hint guard + replace, and chat post", async () => {
    const cookie = await createSession(userId, "view");
    mockRequest.cookies = new Map([[cookie.name, cookie.value]]);
    const post = async (origin: string, form: FormData): Promise<{ status: number; body: Record<string, unknown> }> => {
      mockRequest.headers = new Headers({ origin });
      const req = new Request("http://localhost:3000/api/syllabus/upload", { method: "POST", headers: { origin }, body: form });
      const res = await uploadRoute(req);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const form = (bytes: Buffer, extra: Record<string, string> = {}) => {
      const f = new FormData();
      f.set("file", new File([new Uint8Array(bytes)], "hist.pdf", { type: "application/pdf" }));
      for (const [k, v] of Object.entries(extra)) f.set(k, v);
      return f;
    };

    expect((await post("https://evil.example", form(PDF2))).status).toBe(403);
    const big = await post("http://localhost:3000", form(Buffer.concat([PDF2, Buffer.alloc(5_000_000, 0x20)])));
    expect(big).toMatchObject({ status: 413, body: { ok: false, code: "too_large" } });
    const notPdf = await post("http://localhost:3000", form(Buffer.from("hello there, not a pdf")));
    expect(notPdf).toMatchObject({ status: 400, body: { code: "not_pdf" } });
    expect(parserCalls).toBe(1);

    const exists = await post("http://localhost:3000", form(PDF2, { courseHint: "HIST 101" }));
    expect(exists).toMatchObject({ status: 200, body: { ok: true, status: "exists", canReplace: true } });
    expect(parserCalls).toBe(1);

    mockAfterTasks.length = 0;
    const before = sends().length;
    const replaced = await post("http://localhost:3000", form(PDF2, { courseHint: "HIST 101", replace: "1" }));
    expect(replaced).toMatchObject({ status: 200, body: { ok: true } });
    expect(["ok", "needs_review"]).toContain(replaced.body.status); // the real parser may flag the hint
    expect(String((replaced.body.bubbles as string[])[0])).toContain("updated your HIST 101");
    expect(parserCalls).toBe(2);
    for (const t of mockAfterTasks.splice(0)) await t();
    expect(sends().length).toBeGreaterThan(before);

    const rows = must(await sb.from("syllabi").select("source, pdf_sha256").eq("user_id", userId), "syllabi after replace");
    expect(rows).toEqual([{ source: "upload", pdf_sha256: createHash("sha256").update(PDF2).digest("hex") }]);
  });
});
