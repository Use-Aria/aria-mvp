/**
 * Landing-page signup smoke (5.5 #7), against the LOCAL Supabase stack by default
 * (`SMOKE_TARGET=env` for the env project). Calls the real `POST /api/signup` handler.
 *
 *  1. Foreign Origin → 403, nothing stored.
 *  2. A new phone → one row (E.164, name, timezone, consent version).
 *  3. Per-phone limit: at most 3 rows per phone per 24h; the 4th answers `{ok:true}` but stores nothing.
 *  4. A phone that already belongs to an Aria user (channel exists, name still unset) → `{ok:true}`,
 *     nothing stored, so a re-signup can't set that user's name or consent at their next text.
 *
 * Throwaway phones (`+1555…` random) and one throwaway user; afterAll deletes every signup for
 * those phones and the user (cascade). No LLM calls. Upstash is unset, so the per-IP limit is skipped.
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

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
process.env.APP_BASE_URL = "http://localhost:3000";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Server modules read env lazily (db() on first call), so importing after the assignment is safe.
import { POST as signupPOST } from "@/app/api/signup/route";
import type { NextRequest } from "next/server";

const ORIGIN = "http://localhost:3000";
const sb: SupabaseClient<Database> = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const phones: string[] = [];
const users: string[] = [];

function newPhone(): string {
  const p = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  phones.push(p);
  return p;
}

/** Display form the form might send ("(555) 123-4567"), so the route's E.164 normalization runs. */
function display(e164: string): string {
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function req(body: unknown, origin: string = ORIGIN): NextRequest {
  return new Request(`${ORIGIN}/api/signup`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "user-agent": "SignupSmoke/1.0", "x-real-ip": "203.0.113.50" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function rows(phone: string): Promise<Array<{ name: string | null; timezone: string | null; consent_version: string | null }>> {
  const { data, error } = await sb.from("signups").select("name, timezone, consent_version").eq("phone_e164", phone).order("created_at");
  if (error) throw new Error(`signups: ${error.message}`);
  return data ?? [];
}

afterAll(async () => {
  if (phones.length) await sb.from("signups").delete().in("phone_e164", phones);
  if (users.length) await sb.from("users").delete().in("id", users);
});

describe("POST /api/signup", () => {
  it("1. foreign Origin → 403, nothing stored", async () => {
    const phone = newPhone();
    const res = await signupPOST(req({ name: "Sam", phone: display(phone) }, "https://evil.example"));
    expect(res.status).toBe(403);
    expect(await rows(phone)).toEqual([]);
  });

  it("2. a new phone → one row with E.164, name, timezone, consent version", async () => {
    const phone = newPhone();
    const res = await signupPOST(req({ name: "Sam", phone: display(phone), timezone: "America/Chicago" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rows(phone)).toEqual([{ name: "Sam", timezone: "America/Chicago", consent_version: "private-test-2026-10" }]);
  });

  it("3. per-phone limit: 3 rows per 24h; the 4th says ok but stores nothing", async () => {
    const phone = newPhone();
    for (const name of ["A", "B", "C", "Mallory"]) {
      const res = await signupPOST(req({ name, phone: display(phone) }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect((await rows(phone)).map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  it("4. a phone that already texts Aria is never stored again (can't pre-set that user's name/consent)", async () => {
    const phone = newPhone();
    const { data: user, error } = await sb.from("users").insert({}).select("id").single();
    if (error || !user) throw new Error(`user: ${error?.message}`);
    users.push(user.id);
    const ch = await sb
      .from("channels")
      .insert({ user_id: user.id, kind: "imessage", handle: phone, handle_kind: "phone", provider: "dev", verified_at: new Date().toISOString() })
      .select("id")
      .single();
    if (ch.error) throw new Error(`channel: ${ch.error.message}`);

    const res = await signupPOST(req({ name: "Mallory", phone: display(phone) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rows(phone)).toEqual([]);
  });
});
