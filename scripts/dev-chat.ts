/**
 * Dev-channel chat REPL (V2-03 §10.3; task 3.1). OWNER: 3.1
 *
 * Talk to Aria as a fictional handle without Sendblue. Two modes:
 * - **in-process** (default): `ingestEvents(devProvider, …)` then `afterIngest` — the same path as
 *   the webhook: debounce sleep, claim that job, run the turn. Needs only Supabase plus
 *   `ARIA_AGENT=stub` (default) or `ARIA_AGENT=real` + `ANTHROPIC_API_KEY`.
 * - **--http**: POSTs to `/api/channels/dev` on `npm run dev` (needs `DEV_CHANNEL_SECRET` set for
 *   both; run `npm run dev:tick` too so retries/reschedules get picked up).
 * Either way it prints Aria's bubbles and tapbacks by polling `messages` / `reactions`.
 *
 * Run (in-process needs the react-server condition so `import "server-only"` resolves):
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/dev-chat.ts [--as +15550100001]
 *        [--local] [--http [--url http://localhost:3000/api/channels/dev]] [--quiet]
 *   --local  target the local Supabase stack (`supabase status`) instead of .env.local's project
 *   --quiet  hide the server's console logs (in-process mode)
 *
 * REPL commands:
 *   <text>               send a message
 *   /burst a | b | c     three messages 300ms apart (one debounced turn)
 *   /react <n> <type>    tapback on Aria's nth-to-last message (n = 1 is the latest), e.g. /react 1 love
 *   /proactive test      deliver(proactive) a test item; prints sent/queued/deferred (pause check)
 *   /reset               delete the dev user (cascades every row)
 *   /quit                exit
 * Lines are processed in order; a message waits for its turn to finish (so piped scripts are
 * deterministic). Handles default to the fictional 555-01xx range.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as readline from "node:readline";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";
import type { InboundEvent } from "@/server/channels/types";

type Sb = SupabaseClient<Database>;

interface Options {
  as: string;
  http: boolean;
  url: string;
  local: boolean;
  quiet: boolean;
}

/** Server modules, loaded lazily (in-process mode only; they need the react-server condition). */
interface Server {
  ingestEvents: typeof import("@/server/pipeline/ingest").ingestEvents;
  afterIngest: typeof import("@/server/pipeline/ingest").afterIngest;
  getProvider: typeof import("@/server/channels").getProvider;
  deliver: typeof import("@/server/channels/deliver").deliver;
  textPlan: typeof import("@/server/channels/plan").textPlan;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    as: "+15550100001",
    http: false,
    url: process.env.DEV_CHAT_URL || "http://localhost:3000/api/channels/dev",
    local: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--as") o.as = argv[++i] ?? o.as;
    else if (a === "--http") o.http = true;
    else if (a === "--url") o.url = argv[++i] ?? o.url;
    else if (a === "--local") o.local = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: tsx --conditions=react-server --env-file=.env.local scripts/dev-chat.ts [--as +1555…] [--local] [--http] [--url URL] [--quiet]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return o;
}

function localTarget(): { url: string; serviceKey: string } {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`)");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mask(handle: string): string {
  return handle.length > 4 ? `***${handle.slice(-4)}` : "***";
}

class Chat {
  private seen = new Set<string>();
  private seenReactions = new Set<string>();
  private seq = 0;
  private server: Server | null = null;

  constructor(
    private readonly sb: Sb,
    private readonly opts: Options,
    private readonly handle: string,
  ) {}

  async init(): Promise<void> {
    if (!this.opts.http) {
      try {
        const [ingest, channels, deliverMod, planMod] = await Promise.all([
          import("@/server/pipeline/ingest"),
          import("@/server/channels"),
          import("@/server/channels/deliver"),
          import("@/server/channels/plan"),
        ]);
        this.server = {
          ingestEvents: ingest.ingestEvents,
          afterIngest: ingest.afterIngest,
          getProvider: channels.getProvider,
          deliver: deliverMod.deliver,
          textPlan: planMod.textPlan,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`could not load the server modules (${msg}).`);
        console.error("in-process mode needs: npx tsx --conditions=react-server --env-file=.env.local scripts/dev-chat.ts");
        process.exit(1);
      }
    }
    // Don't replay history from an earlier session.
    const ch = await this.channel();
    if (ch) {
      const { data } = await this.sb.from("messages").select("id").eq("channel_id", ch.id).eq("direction", "out");
      for (const r of data ?? []) this.seen.add(r.id);
      const { data: rx } = await this.sb
        .from("reactions")
        .select("id, messages!inner(channel_id)")
        .eq("actor", "aria")
        .eq("messages.channel_id", ch.id);
      for (const r of rx ?? []) this.seenReactions.add(r.id);
    }
  }

  private async channel(): Promise<{ id: string; user_id: string } | null> {
    const { data, error } = await this.sb
      .from("channels")
      .select("id, user_id")
      .eq("kind", "imessage")
      .eq("handle", this.handle)
      .maybeSingle();
    if (error) throw new Error(`channel lookup: ${error.message}`);
    return data;
  }

  /** Prints Aria's new outbound bubbles / media / tapbacks for this channel. */
  async poll(): Promise<void> {
    const ch = await this.channel();
    if (!ch) return;
    const { data: out } = await this.sb
      .from("messages")
      .select("id, body, media, trigger, status, created_at")
      .eq("channel_id", ch.id)
      .eq("direction", "out")
      .order("created_at", { ascending: true });
    for (const m of out ?? []) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      const tag = m.trigger && m.trigger !== "reply" ? ` (${m.trigger})` : "";
      const media = Array.isArray(m.media) && m.media.length > 0 ? ` [media] ${JSON.stringify(m.media)}` : "";
      const status = m.status && m.status !== "sent" ? ` <${m.status}>` : "";
      console.log(`  aria › ${[m.body ?? "", media.trim()].filter(Boolean).join(" ")}${tag}${status}`);
    }
    const { data: rx } = await this.sb
      .from("reactions")
      .select("id, type, removed_at, messages!inner(channel_id, body)")
      .eq("actor", "aria")
      .eq("messages.channel_id", ch.id)
      .order("created_at", { ascending: true });
    for (const r of rx ?? []) {
      if (this.seenReactions.has(r.id)) continue;
      this.seenReactions.add(r.id);
      const target = (r.messages as { body: string | null } | null)?.body ?? "";
      console.log(`  aria ⟡ ${r.type} on "${target.slice(0, 40)}"`);
    }
  }

  private messageEvent(text: string): Extract<InboundEvent, { type: "message" }> {
    this.seq += 1;
    return {
      type: "message",
      providerMessageId: `dev-chat-${Date.now()}-${this.seq}-${randomUUID().slice(0, 6)}`,
      handle: this.handle,
      handleKind: this.handle.includes("@") ? "email" : "phone",
      line: "dev",
      service: "imessage",
      text,
      media: [],
      sentAt: new Date(),
      providerOptedOut: false,
    };
  }

  /** Sends one inbound event; resolves when its turn (if any) has finished. */
  private async deliverEvent(ev: InboundEvent, httpBody: Record<string, unknown>): Promise<void> {
    if (this.opts.http) {
      const secret = process.env.DEV_CHANNEL_SECRET ?? "";
      const res = await fetch(this.opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-secret": secret },
        body: JSON.stringify(httpBody),
      });
      const text = await res.text();
      if (!res.ok) console.log(`  [http ${res.status}] ${text.slice(0, 200)}`);
      // The server debounces (2.5s) and runs the turn in after(); give it time.
      await sleep(PIPELINE_WAIT_MS);
      return;
    }
    const s = this.server!;
    const dev = s.getProvider("dev");
    const outcomes = await s.ingestEvents(dev, [ev]);
    const kinds = outcomes.map((o) => (o.kind === "stored_only" ? `stored_only:${o.reason}` : o.kind));
    if (kinds.some((k) => k !== "turn")) console.log(`  [${kinds.join(", ")}]`);
    await s.afterIngest(outcomes, dev);
  }

  async say(text: string): Promise<void> {
    await this.deliverEvent(this.messageEvent(text), { handle: this.handle, text });
  }

  async burst(texts: string[]): Promise<void> {
    const work: Promise<void>[] = [];
    for (const [i, t] of texts.entries()) {
      if (i > 0) await sleep(300);
      work.push(this.say(t));
    }
    await Promise.all(work);
  }

  async react(n: number, reaction: string): Promise<void> {
    const ch = await this.channel();
    if (!ch) return console.log("  (no conversation yet)");
    const { data } = await this.sb
      .from("messages")
      .select("id, body, provider_message_id")
      .eq("channel_id", ch.id)
      .eq("direction", "out")
      .not("provider_message_id", "is", null)
      .not("body", "is", null)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, n));
    const target = data?.[Math.max(1, n) - 1];
    if (!target?.provider_message_id) return console.log(`  (no Aria message #${n} to react to)`);
    console.log(`  you ⟡ ${reaction} on "${(target.body ?? "").slice(0, 40)}"`);
    await this.deliverEvent(
      {
        type: "reaction",
        handle: this.handle,
        targetProviderId: target.provider_message_id,
        reaction,
        removed: false,
        sentAt: new Date(),
      },
      { type: "reaction", handle: this.handle, reaction, targetMessageId: target.id },
    );
  }

  async proactiveTest(): Promise<void> {
    if (!this.server) return console.log("  /proactive test runs in-process only");
    const ch = await this.channel();
    if (!ch) return console.log("  (no conversation yet)");
    const { data: c } = await this.sb.from("channels").select("paused_until").eq("id", ch.id).single();
    const r = await this.server.deliver(ch.user_id, this.server.textPlan(["(dev) proactive test"]), {
      proactive: true,
      reason: "dev_test",
      dedupeKey: `devtest:${randomUUID()}`,
      priority: "routine",
    });
    const paused = c?.paused_until ? new Date(c.paused_until) : null;
    if (r.status === "queued") {
      const ok = !paused || paused.getTime() <= Date.now() || r.runAt.getTime() >= paused.getTime();
      console.log(
        `  deliver(proactive) → queued for ${r.runAt.toISOString()}${paused ? ` (paused until ${paused.toISOString()})` : ""} ${ok ? "✓" : "✗ runs before the pause ends"}`,
      );
    } else {
      console.log(`  deliver(proactive) → ${JSON.stringify(r)}`);
    }
  }

  async reset(): Promise<void> {
    const ch = await this.channel();
    if (!ch) return console.log("  (nothing to reset)");
    const { error } = await this.sb.from("users").delete().eq("id", ch.user_id);
    if (error) return console.log(`  reset failed: ${error.message}`);
    this.seen.clear();
    this.seenReactions.clear();
    console.log("  (dev user deleted)");
  }
}

const PIPELINE_WAIT_MS = 6_000;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (opts.local) {
    const t = localTarget();
    process.env.NEXT_PUBLIC_SUPABASE_URL = t.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = t.serviceKey;
    // Local wiring: DB lease (no Upstash), dev provider.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  if (!opts.http) process.env.CHANNEL_PROVIDER ??= "dev";
  process.env.ARIA_AGENT ??= "stub";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (use --env-file=.env.local or --local)");
    process.exit(1);
  }
  if (opts.http && !process.env.DEV_CHANNEL_SECRET) {
    console.error("--http needs DEV_CHANNEL_SECRET (the same value the dev server uses)");
    process.exit(1);
  }
  if (opts.quiet && !opts.http) {
    for (const level of ["info", "warn"] as const) console[level] = () => undefined;
  }

  const sb: Sb = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const handle = opts.as.trim();
  const chat = new Chat(sb, opts, handle);
  await chat.init();

  const target = opts.local ? "local stack" : new URL(url).host;
  console.log(
    `dev-chat as ${mask(handle)} · ${opts.http ? `http ${opts.url}` : "in-process"} · agent=${process.env.ARIA_AGENT} · ${target}`,
  );
  console.log("commands: /burst a | b | c · /react <n> <type> · /proactive test · /reset · /quit");

  const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
  const lines: string[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;
  rl.on("line", (l) => {
    lines.push(l);
    waiting?.();
  });
  rl.on("close", () => {
    closed = true;
    waiting?.();
  });

  const ticker = process.stdin.isTTY ? setInterval(() => void chat.poll().catch(() => undefined), 1_500) : null;
  if (process.stdin.isTTY) process.stdout.write("you › ");

  while (true) {
    if (lines.length === 0) {
      if (closed) break;
      await new Promise<void>((r) => (waiting = r));
      waiting = null;
      continue;
    }
    const line = (lines.shift() ?? "").trim();
    if (!line) continue;
    if (!process.stdin.isTTY) console.log(`you › ${line}`);
    try {
      if (line === "/quit" || line === "/exit") break;
      else if (line === "/reset") await chat.reset();
      else if (line.startsWith("/burst ")) await chat.burst(line.slice(7).split("|").map((s) => s.trim()).filter(Boolean));
      else if (line.startsWith("/react")) {
        const [, n, type] = line.split(/\s+/);
        await chat.react(Number(n) || 1, type || "love");
      } else if (line === "/proactive test" || line === "/proactive") await chat.proactiveTest();
      else if (line.startsWith("/")) console.log("  unknown command");
      else await chat.say(line);
      await chat.poll();
    } catch (e) {
      console.log(`  error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (process.stdin.isTTY) process.stdout.write("you › ");
  }
  if (ticker) clearInterval(ticker);
  rl.close();
  process.exit(0);
}

void main();
