/**
 * End-to-end dev-channel conversation (master plan §5 Wave 5 row 5.3; V2-03 §10.3).
 *
 * Drives the RUNNING dev server over HTTP — `POST /api/channels/dev` with `x-dev-secret` — exactly
 * like the dev-chat REPL's `--http` mode, and reads the results from the LOCAL Supabase stack.
 * The dev server runs the real agent (real Haiku), `npm run dev:tick` runs every due job (reminders,
 * syllabus parse, retries), and the parser container (`PARSER_FAKE_LLM=1`) answers syllabus parses.
 *
 * Needs (all owned by whoever started them; this file never starts/stops anything):
 *   npm run dev            (CHANNEL_PROVIDER=dev, ARIA_AGENT=real, local stack, PARSER_SERVICE_URL)
 *   npm run dev:tick
 *   parser on :8000        (PARSER_FAKE_LLM=1)
 *   DEV_CHANNEL_SECRET     exported for this process too (same value as the dev server)
 * Optional: E2E_CHAT_URL (default http://localhost:3000), E2E_PARSER_URL (default http://localhost:8000).
 * Run: `npm run e2e:chat`. Skips (with a message) when the dev server, the dev route, the parser
 * or the secret is missing. Refuses any Supabase URL that isn't the local stack.
 *
 * The 12 steps (model-dependent turns retry a bounded number of times; assertions are on DB
 * state — `agent_runs.tool_calls`, rows — not on wording, except step 4's clock times):
 *   1. greeting → welcome bubbles + vCard (no LLM)
 *   2. name → `update_profile` → users.name
 *   3. 3-message burst → exactly one run holding all three
 *   4. "what's due tmr" against a seeded timeline → local (not UTC) times in the reply
 *   5. "remind me in 1 min to drink water" → reminder row, fires within 75s
 *   6. "finished the econ pset" → `mark_done` (item done) + an Aria tapback
 *   7. a lasting rule → `propose_preference` (proposed) → "sure" → `confirm_preference` → active
 *   8. syllabus PDF (dev http URL) → `read_syllabus` → parse job → confirmation bubbles
 *   9. `draft_email` with a seeded Google row (gmail.send; new-mode drafts need no Google HTTP) →
 *      pending `send_email` not confirmable in the creating run (`same_run`); run cost includes the
 *      tool's Sonnet call
 *  10. STOP → confirmation, then no reply while opted out; START → replies again
 *  11. "pause till tomorrow" → `deliver(proactive)` queues past the pause
 *  12. no duplicate `messages.idempotency_key`
 * afterAll reports the real LLM spend and deletes every row (llm_calls explicitly; the rest cascade
 * from the throwaway user), then asserts nothing is left.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";
import { makePdf, SYNTHETIC_SYLLABUS } from "../unit/syllabus/fixtures";

jest.mock("next/server", () => ({ after: () => undefined }));

// ── Target: the LOCAL stack only (before any server module calls db()) ─────────
function localTarget(): { url: string; serviceKey: string } | null {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) return null;
  const s = JSON.parse(json) as Record<string, string>;
  const host = new URL(s.API_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`refusing non-local Supabase target ${host}`);
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}
const target = localTarget();
if (target) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
} else {
  // Make sure nothing in this process can reach a remote project.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "none";
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.CHANNEL_PROVIDER = "dev";
process.env.APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";
// This process never calls a model (the dev server does).
delete process.env.ANTHROPIC_API_KEY;

import { confirmPendingAction, cancelPendingAction } from "@/server/agent/pending/actions";
import { deliver } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { SCOPES } from "@/server/integrations/google/config";
import { addLocalDays, localDateOf, zonedToUtc } from "@/shared/time/tz";

type Sb = SupabaseClient<Database>;
type RunRow = Database["public"]["Tables"]["agent_runs"]["Row"];
type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

const BASE = (process.env.E2E_CHAT_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const PARSER = (process.env.E2E_PARSER_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const SECRET = process.env.DEV_CHANNEL_SECRET ?? "";
const TZ = "America/New_York";
const RUN = randomUUID().slice(0, 8);
const HANDLE_PREFIX = "+1555014";
const TURN_TIMEOUT_MS = 120_000;
/** `E2E_CHAT_VERBOSE=1` prints each turn (fictional test content only). */
const VERBOSE = process.env.E2E_CHAT_VERBOSE === "1";

const sb: Sb | null = target
  ? createClient<Database>(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
function db(): Sb {
  if (!sb) throw new Error("no local stack");
  return sb;
}

let ready = false;
let skipReason = "";
let handle = "";
let userId = "";
let channelId = "";
let seq = 0;
let pdfServer: http.Server | null = null;
let pdfUrl = "";
const seeded: { hist: string; econ: string } = { hist: "", econ: "" };

// ── helpers ─────────────────────────────────────────────────────────────────
function must<T>(res: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${label}: no data`);
  return res.data;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>, everyMs = 750): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(everyMs);
  }
}

/** Skips the calling step when the environment isn't there (logged once in beforeAll). */
function skip(): boolean {
  if (!ready) console.warn(`[e2e-chat] skipped: ${skipReason}`);
  return !ready;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/api/channels/dev`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dev-secret": SECRET },
    body: JSON.stringify(body),
  });
}

interface Sent {
  id: string;
  at: Date;
}

/** One inbound message over HTTP; resolves once its `messages` row exists. */
async function say(text: string, extra: Record<string, unknown> = {}): Promise<Sent> {
  seq += 1;
  const providerMessageId = `e2e-chat-${RUN}-${seq}`;
  const at = new Date();
  const res = await post({ handle, text, providerMessageId, ...extra });
  if (res.status !== 200) throw new Error(`dev route answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const row = await until("inbound row", 15_000, async () => {
    const r = must(await db().from("messages").select("id, user_id, channel_id").eq("provider_message_id", providerMessageId), "inbound");
    return r[0] ?? null;
  }, 250);
  if (!userId) {
    userId = row.user_id;
    channelId = row.channel_id;
  }
  return { id: row.id, at };
}

interface Turn {
  inbound: Sent;
  run: RunRow;
  bubbles: string[];
  outbound: MessageRow[];
  reactions: string[];
  tools: { name: string; ok: boolean }[];
}

function toolList(run: RunRow): { name: string; ok: boolean }[] {
  return Array.isArray(run.tool_calls) ? (run.tool_calls as { name: string; ok: boolean }[]) : [];
}

/** Waits for the finished run that consumed `inbound`, then collects what it sent. */
async function turnFor(inbound: Sent, timeoutMs = TURN_TIMEOUT_MS): Promise<Turn> {
  const run = await until(`run for ${inbound.id.slice(0, 8)}`, timeoutMs, async () => {
    const rows = must(
      await db().from("agent_runs").select("*").contains("input_message_ids", [inbound.id]).order("started_at", { ascending: false }),
      "runs",
    );
    return rows.find((r) => r.status === "done") ?? null;
  });
  const outbound = must(
    await db().from("messages").select("*").eq("run_id", run.id).eq("direction", "out").order("created_at"),
    "outbound",
  );
  const rx = must(
    await db().from("reactions").select("type, message_id").eq("actor", "aria").in("message_id", run.input_message_ids),
    "reactions",
  );
  if (VERBOSE) {
    const tools = toolList(run).map((c) => `${c.name}@${(c as { iteration?: number }).iteration ?? "?"}${c.ok ? "" : "!"}`);
    console.info(
      `[e2e-chat] run ${run.id.slice(0, 8)} ${run.trigger} model=${run.model ?? "-"} calls=${run.llm_call_count} ${run.latency_ms ?? "?"}ms $${Number(run.cost_usd).toFixed(4)} tools=[${tools.join(", ")}]\n` +
        outbound.map((m) => `   aria › ${m.body ?? JSON.stringify(m.media)} (${m.trigger})`).join("\n") +
        (rx.length ? `\n   aria ⟡ ${rx.map((r) => r.type).join(",")}` : ""),
    );
  }
  return {
    inbound,
    run,
    outbound,
    bubbles: outbound.map((m) => m.body ?? "").filter(Boolean),
    reactions: rx.map((r) => r.type),
    tools: toolList(run),
  };
}

const okTool = (t: Turn, name: string) => t.tools.some((c) => c.name === name && c.ok);

/**
 * Model-dependent turn with bounded retries: send `texts[0]`, and if `check` fails send the next
 * phrasing (up to `texts.length` attempts).
 */
async function turnUntil(label: string, texts: string[], check: (t: Turn) => Promise<boolean> | boolean): Promise<Turn> {
  let last: Turn | null = null;
  for (const [i, text] of texts.entries()) {
    last = await turnFor(await say(text));
    if (await check(last)) return last;
    console.warn(
      `[e2e-chat] ${label}: attempt ${i + 1}/${texts.length} didn't pass (tools: ${last.tools.map((c) => `${c.name}${c.ok ? "" : "!"}`).join(",") || "none"})`,
    );
  }
  if (!last) throw new Error(`${label}: no attempts`);
  return last;
}

async function freshHandle(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const h = `${HANDLE_PREFIX}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
    if (must(await db().from("channels").select("id").eq("handle", h), "handle probe").length === 0) return h;
  }
  throw new Error("no free fictional handle");
}

/** Local wall time on the user's "tomorrow". */
function tomorrowAt(hour: number, minute: number): Date {
  const d = addLocalDays(localDateOf(new Date(), TZ), 1);
  return zonedToUtc({ ...d, hour, minute }, TZ).instant;
}

/** Seeds two Canvas assignments due tomorrow, straight into the table (no change batch → no alerts/nudges). */
async function seedTimeline(): Promise<void> {
  const hist = tomorrowAt(14, 30);
  const econ = tomorrowAt(23, 59);
  const rows = must(
    await db()
      .from("timeline_items")
      .insert([
        {
          user_id: userId,
          source: "canvas",
          external_id: `e2e-${RUN}-hist`,
          kind: "assignment",
          title: "Response Paper 2",
          course: "HIST 101",
          due_at: hist.toISOString(),
          timing_key: hist.toISOString(),
        },
        {
          user_id: userId,
          source: "canvas",
          external_id: `e2e-${RUN}-econ`,
          kind: "assignment",
          title: "Problem Set 4",
          course: "ECON 115",
          due_at: econ.toISOString(),
          timing_key: econ.toISOString(),
        },
      ])
      .select("id, external_id"),
    "seed timeline",
  );
  seeded.hist = rows.find((r) => r.external_id.endsWith("-hist"))?.id ?? "";
  seeded.econ = rows.find((r) => r.external_id.endsWith("-econ"))?.id ?? "";
}

/** null when unreachable (the first hit may wait for `next dev` to compile the route). */
async function reachable(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    console.warn(`[e2e-chat] ${new URL(url).host} unreachable: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`);
    return null;
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────
beforeAll(async () => {
  if (!target || !sb) {
    skipReason = "local Supabase stack not running (`supabase status`)";
    return;
  }
  if (!SECRET) {
    skipReason = "DEV_CHANNEL_SECRET not exported (use the dev server's value)";
    return;
  }
  const route = await reachable(`${BASE}/api/channels/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!route) {
    skipReason = `dev server not reachable at ${BASE} (npm run dev)`;
    return;
  }
  if (route.status === 404) {
    skipReason = "dev channel route disabled (CHANNEL_PROVIDER=dev or DEV_CHANNEL_SECRET on the dev server)";
    return;
  }
  const parser = await reachable(`${PARSER}/healthz`);
  if (!parser?.ok) {
    skipReason = `parser not reachable at ${PARSER}/healthz`;
    return;
  }
  // Leftovers from an interrupted earlier run of this file (its own fictional range only).
  const stale = must(await sb.from("channels").select("user_id").like("handle", `${HANDLE_PREFIX}%`), "stale probe");
  if (stale.length > 0) await cleanup(stale.map((r) => r.user_id));

  pdfServer = http.createServer((req, res) => {
    if (req.url === `/e2e-${RUN}/hist101.pdf`) {
      const pdf = makePdf(SYNTHETIC_SYLLABUS);
      res.writeHead(200, { "content-type": "application/pdf", "content-length": String(pdf.length) });
      res.end(pdf);
      return;
    }
    res.writeHead(404).end();
  });
  const port = await new Promise<number>((r) => pdfServer!.listen(0, "127.0.0.1", () => r((pdfServer!.address() as AddressInfo).port)));
  pdfUrl = `http://127.0.0.1:${port}/e2e-${RUN}/hist101.pdf`;
  handle = await freshHandle();
  ready = true;
}, 150_000);

/** Deletes every row of these users (llm_calls first: they survive user deletion by design). */
async function cleanup(userIds: string[]): Promise<void> {
  if (!sb || userIds.length === 0) return;
  const runs = must(await sb.from("agent_runs").select("id").in("user_id", userIds), "cleanup runs").map((r) => r.id);
  const jobs = must(await sb.from("jobs").select("id").in("user_id", userIds), "cleanup jobs").map((r) => r.id);
  if (runs.length > 0) must(await sb.from("llm_calls").delete().in("run_id", runs).select("id"), "cleanup llm by run");
  if (jobs.length > 0) must(await sb.from("llm_calls").delete().in("job_id", jobs).select("id"), "cleanup llm by job");
  must(await sb.from("llm_calls").delete().in("user_id", userIds).select("id"), "cleanup llm by user");
  must(await sb.from("users").delete().in("id", userIds).select("id"), "cleanup users");
}

async function spend(): Promise<number> {
  if (!sb || !userId) return 0;
  const runs = must(await sb.from("agent_runs").select("id").eq("user_id", userId), "spend runs").map((r) => r.id);
  const byUser = must(await sb.from("llm_calls").select("id, cost_usd").eq("user_id", userId), "spend user");
  const byRun = runs.length > 0 ? must(await sb.from("llm_calls").select("id, cost_usd").in("run_id", runs), "spend run") : [];
  const all = new Map<string, number>();
  for (const r of [...byUser, ...byRun]) all.set(r.id, Number(r.cost_usd));
  return [...all.values()].reduce((a, b) => a + b, 0);
}

afterAll(async () => {
  pdfServer?.close();
  if (!sb || !userId) return;
  // Let in-flight work (a tick-claimed job, a late llm_calls insert) settle before deleting.
  await sleep(3_000);
  const cost = await spend();
  console.info(`[e2e-chat] real LLM spend for this run: $${cost.toFixed(4)}`);
  const runs = must(await sb.from("agent_runs").select("id").eq("user_id", userId), "final runs").map((r) => r.id);
  await cleanup([userId]);
  // Zero rows left.
  const tables = [
    "channels",
    "consents",
    "messages",
    "agent_runs",
    "jobs",
    "pending_actions",
    "reminders",
    "integrations",
    "timeline_items",
    "syllabi",
    "user_profile",
    "user_preferences",
    "memory_facts",
    "proactive_dedupe",
    "briefings",
    "briefing_notes",
    "conversation_summaries",
    "user_runtime",
    "magic_links",
    "web_sessions",
    "email_items",
  ] as const;
  const left: string[] = [];
  for (const t of tables) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true }).eq("user_id", userId);
    if (error) throw new Error(`leftover check ${t}: ${error.message}`);
    if (count) left.push(`${t}=${count}`);
  }
  const { count: users } = await sb.from("users").select("*", { count: "exact", head: true }).eq("id", userId);
  if (users) left.push(`users=${users}`);
  const { count: llmUser } = await sb.from("llm_calls").select("*", { count: "exact", head: true }).eq("user_id", userId);
  if (llmUser) left.push(`llm_calls(user)=${llmUser}`);
  if (runs.length > 0) {
    const { count: llmRun } = await sb.from("llm_calls").select("*", { count: "exact", head: true }).in("run_id", runs);
    if (llmRun) left.push(`llm_calls(run)=${llmRun}`);
  }
  console.info(`[e2e-chat] rows left after cleanup: ${left.length === 0 ? "none" : left.join(", ")}`);
  expect(left).toEqual([]);
}, 60_000);

// ── the conversation ────────────────────────────────────────────────────────
describe("e2e dev-channel conversation (real agent)", () => {
  it("1. greeting → welcome bubbles + vCard, no LLM call", async () => {
    if (skip()) return;
    const t = await turnFor(await say("hey"));
    expect(t.run.trigger).toBe("welcome");
    expect(t.run.llm_call_count).toBe(0);
    const out = must(await db().from("messages").select("*").eq("user_id", userId).eq("direction", "out").order("created_at"), "welcome out");
    const welcome = out.filter((m) => m.trigger === "welcome" && m.body);
    expect(welcome.length).toBeGreaterThan(0);
    expect(welcome.map((m) => m.body).join(" ").toLowerCase()).toContain("aria");
    const card = out.filter((m) => m.trigger === "contact_card");
    expect(card).toHaveLength(1);
    expect(JSON.stringify(card[0].media)).toMatch(/vcf|vcard/i);
    for (const m of [...welcome, ...card]) expect(m.idempotency_key).toMatch(new RegExp(`^welcome:${channelId}:`));
    await seedTimeline();
  });

  it("2. name → update_profile", async () => {
    if (skip()) return;
    const t = await turnUntil("name", ["I'm Dan", "you can call me Dan", "my name is Dan"], async (x) => {
      const u = must(await db().from("users").select("name").eq("id", userId).single(), "user");
      return okTool(x, "update_profile") && (u.name ?? "").toLowerCase() === "dan";
    });
    expect(okTool(t, "update_profile")).toBe(true);
    expect(must(await db().from("users").select("name").eq("id", userId).single(), "user").name).toBe("Dan");
  });

  it("3. a 3-message burst → exactly one run with all three", async () => {
    if (skip()) return;
    const texts = ["ok wait", "random q", "is it gonna be a busy week for me"];
    // Fire them 300ms apart without waiting for each webhook to answer (a slow dev server would
    // otherwise stretch the gaps past the 2.5s debounce and split the burst).
    const pending: Promise<Sent>[] = [];
    for (const [i, text] of texts.entries()) {
      if (i > 0) await sleep(300);
      pending.push(say(text));
    }
    const sent = await Promise.all(pending);
    const t = await turnFor(sent[2]);
    if (t.run.input_message_ids.length !== 3) {
      const all = must(await db().from("agent_runs").select("id, started_at, input_message_ids").eq("user_id", userId), "burst debug");
      console.warn(`[e2e-chat] burst split: ${JSON.stringify(all.map((r) => r.input_message_ids.length))}`);
    }
    expect([...t.run.input_message_ids].sort()).toEqual(sent.map((s) => s.id).sort());
    await sleep(4_000); // nothing else may pick any of them up
    const runs = must(
      await db().from("agent_runs").select("id, input_message_ids").eq("user_id", userId).overlaps("input_message_ids", sent.map((s) => s.id)),
      "burst runs",
    );
    expect(runs).toHaveLength(1);
    expect(t.bubbles.length + t.reactions.length).toBeGreaterThan(0);
  });

  it("4. what's due tmr → local times from the seeded timeline", async () => {
    if (skip()) return;
    // Seeded: HIST 101 2:30pm and ECON 115 11:59pm tomorrow (New York). In UTC: 18:30 / 03:59.
    const local = /\b(2:30|11:59)/;
    const utc = /\b(18:30|6:30|03:59|3:59|22:59|10:59)/;
    const t = await turnUntil("due tmr", ["what's due tmr", "what do i have due tomorrow?"], (x) => {
      const text = x.bubbles.join(" ");
      return local.test(text) && !utc.test(text);
    });
    const text = t.bubbles.join(" ");
    expect(text).toMatch(local);
    expect(text).not.toMatch(utc);
  });

  it("5. remind me in 1 min to drink water → fires within 75s", async () => {
    if (skip()) return;
    const asked = Date.now();
    const t = await turnUntil("reminder", ["remind me in 1 min to drink water", "can you set a reminder for 1 min from now to drink water?"], (x) =>
      okTool(x, "create_reminder"),
    );
    expect(okTool(t, "create_reminder")).toBe(true);
    const rem = must(await db().from("reminders").select("*").eq("user_id", userId), "reminders");
    expect(rem).toHaveLength(1);
    expect(rem[0].body?.toLowerCase()).toContain("water");
    const fired = await until("reminder delivery", 75_000 - (Date.now() - asked), async () => {
      const rows = must(
        await db()
          .from("messages")
          .select("id, body, trigger, proactive_class, created_at")
          .eq("user_id", userId)
          .eq("direction", "out")
          .eq("trigger", "reminder"),
        "reminder out",
      );
      return rows[0] ?? null;
    }, 1_000);
    expect(fired.proactive_class).toBe("requested");
    expect(new Date(fired.created_at).getTime() - asked).toBeLessThanOrEqual(75_000);
    expect(must(await db().from("reminders").select("status").eq("id", rem[0].id).single(), "reminder").status).not.toBe("scheduled");
  }, 200_000);

  it("6. finished the econ pset → mark_done + tapback", async () => {
    if (skip()) return;
    // Haiku sometimes just cheers ("nice, one down") without the tool; the retry asks outright.
    const t = await turnUntil("mark_done", ["finished the econ pset", "can you mark the econ pset as done?"], (x) => okTool(x, "mark_done"));
    expect(okTool(t, "mark_done")).toBe(true);
    const item = must(await db().from("timeline_items").select("status").eq("id", seeded.econ).single(), "econ");
    expect(item.status).toBe("done");
    expect(must(await db().from("timeline_items").select("status").eq("id", seeded.hist).single(), "hist").status).toBe("upcoming");
    expect(t.reactions.length).toBeGreaterThan(0);
  });

  it("7. a lasting rule → propose_preference → 'sure' → active", async () => {
    if (skip()) return;
    const proposed = await turnUntil(
      "propose",
      // Both implicit (an explicit "remember…/always…" would skip the question and go straight to active).
      ["i'm useless after 11pm, don't ever plan studying past then", "ugh i'm so done studying late, nothing after 11pm for me anymore"],
      async (x) => {
        if (!okTool(x, "propose_preference")) return false;
        const p = must(await db().from("user_preferences").select("status").eq("user_id", userId), "prefs");
        return p.some((r) => r.status === "proposed");
      },
    );
    expect(okTool(proposed, "propose_preference")).toBe(true);
    const confirmed = await turnUntil("confirm", ["sure", "yes please save that"], async (x) => {
      const p = must(await db().from("user_preferences").select("status").eq("user_id", userId), "prefs");
      return okTool(x, "confirm_preference") && p.some((r) => r.status === "active");
    });
    expect(okTool(confirmed, "confirm_preference")).toBe(true);
    const prefs = must(await db().from("user_preferences").select("status, statement").eq("user_id", userId).eq("status", "active"), "active");
    expect(prefs).toHaveLength(1);
  });

  it("8. syllabus PDF over the dev channel → confirmation bubbles", async () => {
    if (skip()) return;
    const t = await turnFor(
      await say("here's my history syllabus", { media: [{ url: pdfUrl, kind: "pdf", contentType: "application/pdf", filename: "HIST 101 Syllabus.pdf" }] }),
    );
    expect(okTool(t, "read_syllabus")).toBe(true);
    const confirmation = await until("syllabus confirmation", 120_000, async () => {
      const rows = must(
        await db().from("messages").select("body").eq("user_id", userId).eq("direction", "out").eq("trigger", "syllabus_parsed"),
        "syllabus out",
      );
      return rows.length > 0 ? rows : null;
    }, 1_500);
    if (VERBOSE) console.info(`[e2e-chat] syllabus confirmation:\n${confirmation.map((r) => `   aria › ${r.body}`).join("\n")}`);
    expect(confirmation.map((r) => r.body ?? "").join(" ").toLowerCase()).toContain("syllabus");
    const syl = must(await db().from("syllabi").select("status, course_key").eq("user_id", userId), "syllabi");
    expect(syl).toHaveLength(1);
    expect(["ok", "needs_review", "parsed"]).toContain(syl[0].status);
  }, 260_000);

  it("9. draft_email (seeded Google) → pending action, not confirmable in the same run", async () => {
    if (skip()) return;
    must(
      await db()
        .from("integrations")
        .insert({
          user_id: userId,
          provider: "google",
          account_email: `e2e-${RUN}@example.edu`,
          scopes: [SCOPES.gmailSend],
          status: "active",
          connected_at: new Date().toISOString(),
        })
        .select("id"),
      "seed google",
    );
    const prof = `kim.e2e.${RUN}@example.edu`;
    const t = await turnUntil(
      "draft",
      [
        `can you draft an email to ${prof} asking for an extension on the hist response paper until monday`,
        `please write a draft email to ${prof}: asking for an extension on my response paper until monday`,
      ],
      (x) => okTool(x, "draft_email"),
    );
    expect(okTool(t, "draft_email")).toBe(true);
    const actions = must(await db().from("pending_actions").select("*").eq("user_id", userId).eq("kind", "send_email"), "actions");
    // The model may revise its own draft in the same run (the first is then superseded/cancelled).
    const action = actions.find((a) => a.run_id === t.run.id && a.status === "pending");
    expect(action).toBeDefined();
    expect(action!.status).toBe("pending");
    expect(JSON.stringify(action!.payload)).toContain(prof);
    // Never sent, and the creating run can't confirm it.
    expect(await confirmPendingAction(userId, action!.id, { via: "chat", runId: t.run.id })).toEqual({ ok: false, code: "same_run" });
    expect(must(await db().from("pending_actions").select("status").eq("id", action!.id).single(), "action").status).toBe("pending");
    // Follow-up (a): the run's cost includes draft_email's own Sonnet `draft` call.
    const calls = must(await db().from("llm_calls").select("route, cost_usd").eq("run_id", t.run.id), "run llm calls");
    const draftCalls = calls.filter((c) => c.route === "draft");
    expect(draftCalls.length).toBeGreaterThan(0);
    const sum = calls.reduce((a, c) => a + Number(c.cost_usd), 0);
    expect(Number(t.run.cost_usd)).toBeCloseTo(sum, 5);
    expect(await cancelPendingAction(userId, action!.id, "chat")).toEqual({ ok: true });
  }, 260_000);

  it("10. STOP → confirmation, then silence; START → replies again", async () => {
    if (skip()) return;
    const stop = await turnFor(await say("STOP"));
    expect(stop.run.trigger).toBe("command");
    expect(stop.run.llm_call_count).toBe(0);
    await until("stop confirmation", 20_000, async () => {
      const rows = must(await db().from("messages").select("id").eq("run_id", stop.run.id).eq("trigger", "command"), "stop out");
      return rows.length > 0;
    });
    expect(must(await db().from("channels").select("opted_out_at").eq("id", channelId).single(), "channel").opted_out_at).not.toBeNull();

    const quiet = await say("hello?");
    await sleep(10_000);
    const after = must(
      await db().from("messages").select("id").eq("user_id", userId).eq("direction", "out").gt("created_at", quiet.at.toISOString()),
      "outbound while opted out",
    );
    expect(after).toHaveLength(0);
    const quietRuns = must(
      await db().from("agent_runs").select("id").contains("input_message_ids", [quiet.id]).neq("trigger", "command"),
      "runs while opted out",
    );
    expect(quietRuns).toHaveLength(0);

    const start = await turnFor(await say("START"));
    expect(start.run.trigger).toBe("command");
    await until("start confirmation", 20_000, async () => {
      const rows = must(await db().from("messages").select("id").eq("run_id", start.run.id).eq("trigger", "command"), "start out");
      return rows.length > 0;
    });
    expect(must(await db().from("channels").select("opted_out_at").eq("id", channelId).single(), "channel").opted_out_at).toBeNull();
    const back = await turnFor(await say("you there?"));
    expect(back.run.trigger).toBe("inbound");
    expect(back.bubbles.length + back.reactions.length).toBeGreaterThan(0);
  }, 200_000);

  it("11. pause till tomorrow → deliver(proactive) queues past the pause", async () => {
    if (skip()) return;
    const p = await turnFor(await say("pause till tomorrow"));
    expect(p.run.trigger).toBe("command");
    const ch = must(await db().from("channels").select("paused_until").eq("id", channelId).single(), "channel");
    expect(ch.paused_until).not.toBeNull();
    const pausedUntil = new Date(ch.paused_until!);
    expect(pausedUntil.getTime()).toBeGreaterThan(Date.now());
    expect(pausedUntil.getTime()).toBeLessThanOrEqual(Date.now() + 25 * 3_600_000);
    const r = await deliver(userId, textPlan(["(e2e) proactive check"]), {
      proactive: true,
      reason: "e2e_test",
      dedupeKey: `e2e:${RUN}:pause`,
      priority: "routine",
    });
    expect(r.status).toBe("queued");
    if (r.status !== "queued") return;
    expect(r.runAt.getTime()).toBeGreaterThanOrEqual(pausedUntil.getTime());
    const job = must(await db().from("jobs").select("run_at, status").eq("id", r.jobId).single(), "outbox job");
    expect(new Date(job.run_at).getTime()).toBeGreaterThanOrEqual(pausedUntil.getTime());
    expect(job.status).toBe("pending");
  });

  it("12. no duplicate idempotency keys", async () => {
    if (skip()) return;
    const rows = must(
      await db().from("messages").select("idempotency_key").eq("user_id", userId).not("idempotency_key", "is", null),
      "keys",
    );
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.idempotency_key!, (counts.get(r.idempotency_key!) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1);
    expect(dupes).toEqual([]);
    expect(rows.length).toBeGreaterThan(10);
  });
});
