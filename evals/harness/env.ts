/**
 * Eval environment (import FIRST in every `*.eval.ts`, before any `@/server` module).
 *
 * - Target: the LOCAL Supabase stack (keys from `supabase status -o json`, like the smoke tests).
 *   `EVAL_TARGET=env` uses NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY instead, and a
 *   non-local URL is refused unless `EVAL_ALLOW_REMOTE=1` is also set.
 * - Model: the real Anthropic API. The key is read from the environment only (Jest does not load
 *   `.env.local`); without it every eval file skips with a message.
 * - Deterministic local wiring: dev channel provider, no Upstash (DB lease, in-memory rate
 *   limits), a throwaway encryption key and fake Google OAuth client (Google itself is faked at
 *   the HTTP boundary by `fake-google.ts`).
 *
 * Server modules read env lazily (`db()` on first call), so setting it here is enough.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Supabase target the evals write to. */
export interface EvalTarget {
  url: string;
  serviceKey: string;
  local: boolean;
}

function localStatus(): EvalTarget {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("evals: local Supabase stack not running (`supabase start`), or set EVAL_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL ?? "", serviceKey: s.SERVICE_ROLE_KEY ?? "", local: true };
}

/**
 * Is this Supabase URL the local stack?
 * @param url API URL
 * @returns true for loopback hosts
 */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Resolve (and guard) the eval target.
 * @returns url + service key
 * @throws when the target is remote without the explicit opt-in, or keys are missing
 */
export function resolveTarget(): EvalTarget {
  const t =
    process.env.EVAL_TARGET === "env"
      ? {
          url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
          serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          local: false,
        }
      : localStatus();
  if (!t.url || !t.serviceKey) throw new Error("evals: Supabase URL / service key missing");
  t.local = isLocalUrl(t.url);
  if (!t.local && process.env.EVAL_ALLOW_REMOTE !== "1") {
    throw new Error("evals: refusing a non-local Supabase URL (set EVAL_ALLOW_REMOTE=1 to opt in explicitly)");
  }
  return t;
}

/** The resolved target (resolved once, at import). */
export const TARGET: EvalTarget = resolveTarget();

/** True when a real Anthropic key is present; eval files skip otherwise. */
export const HAS_MODEL_KEY = Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());

process.env.NEXT_PUBLIC_SUPABASE_URL = TARGET.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = TARGET.serviceKey;
process.env.CHANNEL_PROVIDER = "dev";
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = "eval-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "eval-client-secret";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
// Never let a stray OpenAI fallback key change which model answers.
delete process.env.OPENAI_API_KEY;
