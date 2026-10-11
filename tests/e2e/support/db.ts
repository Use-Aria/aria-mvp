/**
 * Seeding + cleanup for the Playwright e2e suite (web plan §10 "Global setup"), against the LOCAL
 * Supabase stack the dev server uses. Rows are written with the service-role key straight through
 * PostgREST (the `src/server/**` helpers import `server-only`, which throws outside Next), using the
 * same storage rules: session and link tokens are random base64url, only their SHA-256 is stored.
 *
 * Every user is marked `persona_prefs.e2e = true` so a crashed run's leftovers can be swept.
 * Deleting a user cascades to every user-owned table except `llm_calls` (nulled) and `signups`
 * (matched id nulled); `deleteUsers` removes those explicitly.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/server/db/types";
import { addLocalDays, localDateOf, zonedToUtc, type LocalDate } from "@/shared/time/tz";

export type Sb = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];

/** Session cookie name outside production (`sessions.ts`: `__Host-aria` only in prod). */
export const SESSION_COOKIE = "aria";
/** Marker key in `users.persona_prefs` for e2e users. */
export const E2E_MARK = "e2e";
/** Prefix of e2e signup names (the landing form test). */
export const E2E_SIGNUP_PREFIX = "E2E ";

let client: Sb | null = null;

function localTarget(): { url: string; serviceKey: string } {
  const url = process.env.E2E_SUPABASE_URL;
  const key = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return { url, serviceKey: key };
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set E2E_SUPABASE_URL + key");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}

/**
 * Service-role client for the local stack (memoized per worker).
 * @returns the client
 */
export function sb(): Sb {
  if (!client) {
    const t = localTarget();
    client = createClient<Database>(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

/**
 * Unwraps a PostgREST result.
 * @param r result
 * @param label context for the error
 * @returns the data
 */
export function must<T>(r: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${label}: no data`);
  return r.data as NonNullable<T>;
}

/** Random URL-safe token (same shape as `crypto.ts#randomToken`). */
export function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Hex SHA-256 (same as `crypto.ts#sha256Hex`). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface NewUser {
  name?: string | null;
  timezone?: string;
  briefingTime?: string;
  quietStart?: string;
  quietEnd?: string;
  tone?: "mirror" | "casual" | "polished";
  /** Adds a verified dev-provider iMessage channel (needed for chat confirmations). */
  channel?: boolean;
  school?: string | null;
}

/**
 * Inserts a throwaway user (marked for the sweep), optionally with a dev channel and profile.
 * @param u fields
 * @returns the user id
 */
export async function createUser(u: NewUser = {}): Promise<string> {
  const prefs: Record<string, Json> = { [E2E_MARK]: true };
  if (u.tone) prefs.tone = u.tone;
  const row = must(
    await sb()
      .from("users")
      .insert({
        name: u.name === undefined ? "Dana" : u.name,
        timezone: u.timezone ?? "America/New_York",
        timezone_source: "signup",
        briefing_time: u.briefingTime ?? "08:00",
        quiet_start: u.quietStart ?? "22:00",
        quiet_end: u.quietEnd ?? "08:00",
        persona_prefs: prefs as Json,
      })
      .select("id")
      .single(),
    "user",
  );
  if (u.channel !== false) {
    const handle = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    must(
      await sb()
        .from("channels")
        .insert({
          user_id: row.id,
          kind: "imessage",
          handle,
          handle_kind: "phone",
          provider: "dev",
          is_primary: true,
          verified_at: new Date().toISOString(),
        })
        .select("id")
        .single(),
      "channel",
    );
  }
  if (u.school) {
    must(await sb().from("user_profile").insert({ user_id: row.id, school: u.school }).select("user_id").single(), "profile");
  }
  return row.id;
}

/**
 * Inserts a web session and returns the raw cookie value.
 * @param userId owner
 * @param opts scope and age (a backdated `created_at` makes it stale)
 * @returns raw session id (the `aria` cookie value)
 */
export async function createSessionRow(
  userId: string,
  opts: { scope?: "view" | "setup"; ageMinutes?: number } = {},
): Promise<string> {
  const raw = token(32);
  const created = new Date(Date.now() - (opts.ageMinutes ?? 0) * 60_000);
  must(
    await sb()
      .from("web_sessions")
      .insert({
        session_hash: sha256Hex(raw),
        user_id: userId,
        scope: opts.scope ?? "view",
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + 14 * 24 * 3_600_000).toISOString(),
      })
      .select("session_hash")
      .single(),
    "session",
  );
  return raw;
}

/**
 * Inserts a magic link and returns its `/m` path (token in the fragment, like `mintMagicLink`).
 * @param userId owner
 * @param opts purpose, target, ttl, and whether it is already used
 * @returns `{ path, token }`
 */
export async function createMagicLink(
  userId: string,
  opts: { purpose?: "view" | "setup" | "email_draft" | "digest"; target?: string; ttlMinutes?: number; used?: boolean } = {},
): Promise<{ path: string; token: string }> {
  const t = token(24);
  const purpose = opts.purpose ?? "view";
  must(
    await sb()
      .from("magic_links")
      .insert({
        token_hash: sha256Hex(t),
        user_id: userId,
        purpose,
        target: opts.target ?? (purpose === "setup" ? "/setup" : "/week"),
        expires_at: new Date(Date.now() + (opts.ttlMinutes ?? 15) * 60_000).toISOString(),
        used_at: opts.used ? new Date().toISOString() : null,
      })
      .select("token_hash")
      .single(),
    "magic link",
  );
  return { path: `/m?k=week#t=${t}`, token: t };
}

/**
 * A UTC instant for a local wall time `days` days from today in `tz`.
 * @param tz IANA zone
 * @param days local days from today (negative = past)
 * @param hour local hour
 * @param minute local minute
 * @param now clock
 * @returns the instant
 */
export function localAt(tz: string, days: number, hour: number, minute = 0, now: Date = new Date()): Date {
  const d = addLocalDays(localDateOf(now, tz), days);
  return zonedToUtc({ ...d, hour, minute }, tz).instant;
}

/**
 * Local date `days` from today in `tz`.
 * @param tz IANA zone
 * @param days offset
 * @param now clock
 * @returns the local date
 */
export function localDay(tz: string, days: number, now: Date = new Date()): LocalDate {
  return addLocalDays(localDateOf(now, tz), days);
}

/** `YYYY-MM-DD` of a local date. */
export function ymd(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export interface SeedItem {
  title: string;
  kind?: "assignment" | "exam" | "event" | "class" | "block";
  source?: "canvas" | "gcal" | "syllabus" | "aria";
  course?: string | null;
  dueAt?: Date | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /**
   * All-day: the floating local date, stored as timing key `D:YYYYMMDD`. The anchor defaults to
   * 23:59 local (Canvas parse); pass `dueAt` to store a misleading anchor (it must not move the day).
   */
  allDayDate?: LocalDate;
  url?: string | null;
  status?: "upcoming" | "done";
}

/**
 * Inserts timeline items directly (fixtures for /week).
 * @param userId owner
 * @param items items
 * @param tz zone used to place all-day items' anchor (23:59 local, like Canvas parse)
 * @returns ids in input order
 */
export async function seedTimeline(userId: string, items: SeedItem[], tz: string): Promise<string[]> {
  const rows: Tables["timeline_items"]["Insert"][] = items.map((it, i) => {
    const kind = it.kind ?? "assignment";
    const deadline = kind === "assignment" || kind === "exam";
    let dueAt = it.dueAt ?? null;
    let startsAt = it.startsAt ?? null;
    let timingKey: string | null = null;
    if (it.allDayDate) {
      const d = it.allDayDate;
      timingKey = `D:${d.year}${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
      if (deadline) dueAt = it.dueAt ?? zonedToUtc({ ...d, hour: 23, minute: 59 }, tz).instant;
      else startsAt = it.startsAt ?? zonedToUtc({ ...d, hour: 0, minute: 0 }, tz).instant;
    }
    return {
      user_id: userId,
      source: it.source ?? "canvas",
      external_id: `e2e-${i}-${token(6)}`,
      kind,
      title: it.title,
      course: it.course ?? null,
      due_at: deadline ? (dueAt?.toISOString() ?? null) : null,
      starts_at: deadline ? null : (startsAt?.toISOString() ?? null),
      ends_at: it.endsAt?.toISOString() ?? null,
      all_day: Boolean(it.allDayDate),
      timing_key: timingKey,
      url: it.url ?? null,
      status: it.status ?? "upcoming",
    };
  });
  const out = must(await sb().from("timeline_items").insert(rows).select("id, external_id"), "timeline");
  return rows.map((r) => out.find((o) => o.external_id === r.external_id)?.id ?? "");
}

/**
 * A Canvas integration row (no URL stored; no sync job, `next_sync_at` a day out).
 * @param userId owner
 * @param opts host and health
 */
export async function seedCanvas(
  userId: string,
  opts: { host?: string; failing?: boolean; syncedAt?: Date } = {},
): Promise<void> {
  const synced = opts.syncedAt ?? new Date(Date.now() - 30 * 60_000);
  must(
    await sb()
      .from("integrations")
      .insert({
        user_id: userId,
        provider: "canvas_ical",
        status: opts.failing ? "error" : "active",
        ical_host: opts.host ?? "yale.instructure.com",
        synced_at: synced.toISOString(),
        next_sync_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        consecutive_failures: opts.failing ? 3 : 0,
        last_error: opts.failing ? "feed_not_found" : null,
        last_error_at: opts.failing ? new Date().toISOString() : null,
        connected_at: synced.toISOString(),
      })
      .select("id")
      .single(),
    "canvas integration",
  );
}

/** Every Google scope Aria asks for (canonical short names, as `normalizeScopes` stores them). */
export const ALL_GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

/**
 * A Google integration row with NO tokens (so nothing can reach Google: sends return
 * `google_disconnected`, revoke is skipped).
 * @param userId owner
 * @param opts account email and granted scopes
 */
export async function seedGoogle(userId: string, opts: { email?: string; scopes?: string[] } = {}): Promise<void> {
  must(
    await sb()
      .from("integrations")
      .insert({
        user_id: userId,
        provider: "google",
        status: "active",
        account_email: opts.email ?? `e2e.${token(4).toLowerCase()}@example.com`,
        scopes: opts.scopes ?? ALL_GOOGLE_SCOPES,
        connected_at: new Date().toISOString(),
      })
      .select("id")
      .single(),
    "google integration",
  );
}

/** Default draft payload (`SendEmailPayload` v1). */
export const DRAFT_PAYLOAD = {
  v: 1 as const,
  from: "dana@example.edu",
  to: ["lee@example.edu"],
  cc: ["ta@example.edu"],
  subject: "Essay extension",
  body_text: "Hi Professor Lee,\n\nCould I have until Friday for the essay?\n\nThanks,\nDana",
};

/**
 * A `send_email` pending action.
 * @param userId owner
 * @param over status / payload / expiry / result overrides
 * @returns the action id
 */
export async function seedDraft(
  userId: string,
  over: { status?: "pending" | "executing" | "done" | "failed" | "cancelled" | "expired"; payload?: Record<string, Json>; result?: Json; expiresAt?: Date } = {},
): Promise<string> {
  return must(
    await sb()
      .from("pending_actions")
      .insert({
        user_id: userId,
        kind: "send_email",
        payload: (over.payload ?? DRAFT_PAYLOAD) as Json,
        summary: "sent your email to Prof. Lee",
        status: over.status ?? "pending",
        version: 1,
        result: over.result ?? null,
        decided_at: over.status && over.status !== "pending" ? new Date().toISOString() : null,
        expires_at: (over.expiresAt ?? new Date(Date.now() + 3_600_000)).toISOString(),
      })
      .select("id")
      .single(),
    "draft",
  ).id;
}

/**
 * Memory fixtures for /settings: profile, one active preference, one proposal, two facts.
 * @param userId owner
 * @returns the inserted ids
 */
export async function seedMemory(userId: string): Promise<{ prefId: string; proposalId: string; factIds: string[] }> {
  await sb().from("user_profile").upsert({ user_id: userId, school: "Yale University", courses: ["CPSC 323", "ECON 115"] as Json });
  const pref = must(
    await sb()
      .from("user_preferences")
      .insert({ user_id: userId, key: "schedule.no_gym_late", statement: "No gym after 8pm", status: "active", source: "explicit" })
      .select("id")
      .single(),
    "preference",
  );
  const prop = must(
    await sb()
      .from("user_preferences")
      .insert({ user_id: userId, key: "study.mornings", statement: "Prefers studying in the morning", status: "proposed", source: "inferred" })
      .select("id")
      .single(),
    "proposal",
  );
  const facts = must(
    await sb()
      .from("memory_facts")
      .insert([
        { user_id: userId, content: "Has a younger sister named Mia", source: "explicit", category: "people" },
        { user_id: userId, content: "Works at the library on Tuesdays", source: "explicit", category: "schedule" },
      ])
      .select("id"),
    "facts",
  );
  return { prefId: pref.id, proposalId: prop.id, factIds: facts.map((f) => f.id) };
}

/**
 * Deletes users and everything that survives the cascade (`llm_calls`, `agent_runs` via cascade,
 * matched `signups`). Jobs are deleted first so the dev tick can't claim one mid-delete.
 * @param ids user ids
 */
export async function deleteUsers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sb().from("jobs").delete().in("user_id", ids);
  await sb().from("llm_calls").delete().in("user_id", ids);
  await sb().from("signups").delete().in("matched_user_id", ids);
  const { error } = await sb().from("users").delete().in("id", ids);
  if (error) throw new Error(`deleteUsers: ${error.message}`);
}

/**
 * Removes e2e leftovers older than `olderThanMin` (crashed runs). Never touches a live test's rows.
 * @param olderThanMin minimum age
 */
export async function sweepStale(olderThanMin = 30): Promise<void> {
  const before = new Date(Date.now() - olderThanMin * 60_000).toISOString();
  const { data } = await sb().from("users").select("id").eq(`persona_prefs->>${E2E_MARK}`, "true").lt("created_at", before);
  await deleteUsers((data ?? []).map((u) => u.id));
  await sb().from("signups").delete().like("name", `${E2E_SIGNUP_PREFIX}%`).lt("created_at", before);
}

/**
 * Counts rows still owned by the given users (cleanup assertion).
 * @param ids user ids
 * @returns total across the main user-owned tables
 */
export async function leftoverCount(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const tables = ["users", "web_sessions", "timeline_items", "pending_actions", "integrations", "jobs", "messages"] as const;
  let total = 0;
  for (const t of tables) {
    const col = t === "users" ? "id" : "user_id";
    const { count } = await sb().from(t).select("*", { count: "exact", head: true }).in(col, ids);
    total += count ?? 0;
  }
  return total;
}
