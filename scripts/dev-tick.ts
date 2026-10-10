/**
 * Local jobs tick (`npm run dev:tick`). OWNER: 1.1
 *
 * pg_cron's `private.jobs_tick()` can't reach localhost, so in dev this loop plays its part:
 * every ~2s it signs a timestamp (same HMAC as `src/server/jobs/auth.ts` / pgcrypto) and POSTs
 * to `/api/jobs/dispatch` on the running `npm run dev` server, which claims and runs due jobs.
 *
 * Usage: npx tsx scripts/dev-tick.ts [--url http://localhost:3000/api/jobs/dispatch]
 *                                    [--interval 2000] [--once]
 * Env: JOBS_DISPATCH_SECRET (read from .env.local when not exported); DEV_TICK_URL overrides
 * the default URL. Refuses non-localhost URLs unless --allow-remote is passed.
 *
 * Not under src/server: it runs outside Next, where `import "server-only"` throws, so the
 * 3-line signer is inlined here.
 */
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";

interface Options {
  url: string;
  intervalMs: number;
  once: boolean;
  allowRemote: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    url: process.env.DEV_TICK_URL || "http://localhost:3000/api/jobs/dispatch",
    intervalMs: 2000,
    once: false,
    allowRemote: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i] ?? opts.url;
    else if (a === "--interval") opts.intervalMs = Math.max(250, Number(argv[++i]) || opts.intervalMs);
    else if (a === "--once") opts.once = true;
    else if (a === "--allow-remote") opts.allowRemote = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: tsx scripts/dev-tick.ts [--url URL] [--interval MS] [--once] [--allow-remote]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Same signature as `signDispatch` in src/server/jobs/auth.ts. */
function sign(tsSec: number, secret: string): string {
  return createHmac("sha256", secret).update(`v1.${tsSec}`).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tickOnce(url: string, secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-aria-ts": String(ts),
        "x-aria-sig": sign(ts, secret),
      },
      body: JSON.stringify({ source: "dev-tick" }),
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
    if (res.status === 401) return "401 unauthorized: JOBS_DISPATCH_SECRET differs from the dev server's";
    return String(res.status);
  } catch (e) {
    const msg = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    return `unreachable (${msg}); is \`npm run dev\` running?`;
  }
}

async function main(): Promise<void> {
  if (!process.env.JOBS_DISPATCH_SECRET && existsSync(".env.local")) process.loadEnvFile(".env.local");
  const secret = process.env.JOBS_DISPATCH_SECRET;
  if (!secret) {
    console.error("JOBS_DISPATCH_SECRET is not set (export it or add it to .env.local)");
    process.exit(1);
  }
  const opts = parseArgs(process.argv.slice(2));
  const host = new URL(opts.url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !opts.allowRemote) {
    console.error(`refusing to tick a non-local URL (${opts.url}); pass --allow-remote to override`);
    process.exit(2);
  }

  console.log(`[dev-tick] POST ${opts.url} every ${opts.intervalMs}ms (ctrl-c to stop)`);
  let last = "";
  let count = 0;
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });
  while (!stop) {
    const status = await tickOnce(opts.url, secret);
    count += 1;
    // Log only on change so a healthy loop stays quiet.
    if (status !== last) {
      console.log(`[dev-tick] ${new Date().toISOString()} tick #${count}: ${status}`);
      last = status;
    }
    if (opts.once) {
      if (status !== "202") process.exitCode = 1;
      break;
    }
    await sleep(opts.intervalMs);
  }
}

void main();
