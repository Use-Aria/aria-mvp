/**
 * Throwaway eval users and fixtures (V2-04 §7.5 `seed.ts`), plus cleanup.
 *
 * Every user gets a dev-provider iMessage channel with a fictional handle
 * (`eval+<uuid>@example.invalid`), quiet hours off (so proactive paths are time-of-day
 * independent), and optional fake Google / Canvas integrations. Timeline fixtures are inserted
 * directly (no `timeline_changes` job is enqueued, so the dev tick has nothing to claim).
 *
 * Cleanup deletes, in order: this file's `llm_calls` (they survive user deletion: `user_id` is
 * nulled, so they are deleted by user AND run id), its jobs, then the users (everything else
 * cascades). `leftovers()` re-counts every user-scoped table afterwards.
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/server/db/types";
import { SCOPES } from "@/server/integrations/google/config";
import { encryptSecret, parseKey } from "@/server/security/crypto";
import { TARGET } from "./env";
import { dropAccount, fakeAccount, type FakeAccount } from "./fake-google";

/** Service-role client for fixtures and assertions (never used by the code under test). */
export const sb: SupabaseClient<Database> = createClient<Database>(TARGET.url, TARGET.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A throwaway eval user. */
export interface EvalUser {
  id: string;
  channelId: string;
  timezone: string;
  /** case label (cost attribution) */
  label: string;
  google: FakeAccount | null;
}

/** Options for `createEvalUser`. */
export interface UserOptions {
  name?: string | null;
  timezone?: string;
  /** connect a fake Google account (calendar + Gmail read/send scopes) */
  google?: boolean;
  /** mark Canvas as connected (no feed URL; nothing syncs) */
  canvas?: boolean;
}

const userIds = new Set<string>();
/** run id → user id */
const runIds = new Map<string, string>();
const labels = new Map<string, string>();
const tokens = new Set<string>();

/**
 * Throw on a Supabase error, return the data.
 * @param r Supabase result
 * @param what label for the error
 * @returns the non-null data
 */
export function must<T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${what}: no data`);
  return r.data as NonNullable<T>;
}

/**
 * Remember a run id for cleanup and cost attribution.
 * @param runId agent_runs id
 * @param userId its owner
 */
export function trackRun(runId: string, userId: string): void {
  runIds.set(runId, userId);
}

/**
 * Users, runs and labels created by this file.
 * @returns copies of the registries
 */
export function tracked(): { userIds: string[]; runIds: string[]; runOwner: Map<string, string>; labels: Map<string, string> } {
  return { userIds: [...userIds], runIds: [...runIds.keys()], runOwner: new Map(runIds), labels: new Map(labels) };
}

/**
 * Create a throwaway user + channel (+ integrations).
 * @param label case name (for the cost report)
 * @param o options
 * @returns the user
 */
export async function createEvalUser(label: string, o: UserOptions = {}): Promise<EvalUser> {
  const timezone = o.timezone ?? "America/New_York";
  const user = must(
    await sb
      .from("users")
      .insert({
        name: o.name === undefined ? "Dan" : o.name,
        timezone,
        timezone_source: "signup",
        quiet_start: "00:00",
        quiet_end: "00:00",
      })
      .select("id")
      .single(),
    "eval user",
  );
  userIds.add(user.id);
  labels.set(user.id, label);
  const channel = must(
    await sb
      .from("channels")
      .insert({
        user_id: user.id,
        kind: "imessage",
        handle: `eval+${randomUUID()}@example.invalid`,
        handle_kind: "email",
        provider: "dev",
        is_primary: true,
        verified_at: new Date().toISOString(),
        last_inbound_at: new Date().toISOString(),
        last_service: "imessage",
      })
      .select("id")
      .single(),
    "eval channel",
  );
  // A welcome row exists for every real user past first contact; the agent's context expects history.
  must(
    await sb
      .from("messages")
      .insert({
        user_id: user.id,
        channel_id: channel.id,
        direction: "out",
        provider: "dev",
        body: "hey! i'm Aria, an AI assistant for school stuff. text me anytime",
        trigger: "welcome",
        status: "sent",
        service: "imessage",
        created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      })
      .select("id"),
    "welcome row",
  );

  let google: FakeAccount | null = null;
  if (o.google) {
    const token = `at-eval-${randomUUID()}`;
    const email = `eval-${user.id.slice(0, 8)}@gmail.com`;
    const key = parseKey(process.env.APP_ENCRYPTION_KEY ?? "");
    must(
      await sb
        .from("integrations")
        .insert({
          user_id: user.id,
          provider: "google",
          status: "active",
          account_email: email,
          scopes: Object.values(SCOPES),
          enc_access_token: encryptSecret(token, key),
          enc_refresh_token: encryptSecret(`rt-eval-${randomUUID()}`, key),
          token_expires_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          gcal_calendar_ids: [email],
          connected_at: new Date().toISOString(),
        })
        .select("id"),
      "google integration",
    );
    google = fakeAccount(token, email);
    tokens.add(token);
  }
  if (o.canvas) {
    must(await sb.from("integrations").insert({ user_id: user.id, provider: "canvas_ical", status: "active" }).select("id"), "canvas integration");
  }
  return { id: user.id, channelId: channel.id, timezone, label, google };
}

/** A timeline fixture. */
export interface ItemFixture {
  source?: "canvas" | "gcal" | "syllabus" | "aria";
  kind?: "assignment" | "exam" | "event" | "class" | "block";
  title: string;
  course?: string | null;
  dueAt?: Date;
  startsAt?: Date;
  endsAt?: Date;
  raw?: Json;
  status?: "upcoming" | "done";
}

/**
 * Insert a timeline item directly (no change batch / job).
 * @param u owner
 * @param f fixture
 * @returns timeline_items.id
 */
export async function addItem(u: EvalUser, f: ItemFixture): Promise<string> {
  return must(
    await sb
      .from("timeline_items")
      .insert({
        user_id: u.id,
        source: f.source ?? "canvas",
        external_id: `eval-${randomUUID()}`,
        kind: f.kind ?? "assignment",
        title: f.title,
        course: f.course ?? null,
        due_at: f.dueAt?.toISOString() ?? null,
        starts_at: f.startsAt?.toISOString() ?? null,
        ends_at: f.endsAt?.toISOString() ?? null,
        raw: f.raw ?? null,
        status: f.status ?? "upcoming",
      })
      .select("id")
      .single(),
    "timeline item",
  ).id;
}

/**
 * Insert an Aria-authored message into the history (e.g. the question an "ok" answers).
 * @param u owner
 * @param body text
 * @param agoMs how long ago
 * @returns messages.id
 */
export async function addAriaMessage(u: EvalUser, body: string, agoMs = 60_000): Promise<string> {
  return must(
    await sb
      .from("messages")
      .insert({
        user_id: u.id,
        channel_id: u.channelId,
        direction: "out",
        provider: "dev",
        body,
        trigger: "reply",
        status: "sent",
        service: "imessage",
        created_at: new Date(Date.now() - agoMs).toISOString(),
      })
      .select("id")
      .single(),
    "aria message",
  ).id;
}

/**
 * Wait for best-effort `llm_calls` inserts (they race a 1.5s timeout and may land later).
 * @param ms delay
 */
export async function settle(ms = 2500): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** `llm_calls` rows of this file's users and runs (deduped). */
export async function llmRowsForTracked(): Promise<Database["public"]["Tables"]["llm_calls"]["Row"][]> {
  const { userIds: us, runIds: rs } = tracked();
  const out = new Map<string, Database["public"]["Tables"]["llm_calls"]["Row"]>();
  for (let i = 0; i < us.length; i += 100) {
    for (const r of must(await sb.from("llm_calls").select("*").in("user_id", us.slice(i, i + 100)), "llm_calls by user")) out.set(r.id, r);
  }
  for (let i = 0; i < rs.length; i += 100) {
    for (const r of must(await sb.from("llm_calls").select("*").in("run_id", rs.slice(i, i + 100)), "llm_calls by run")) out.set(r.id, r);
  }
  return [...out.values()];
}

/** Every table with a `user_id` column (cascade targets + llm_calls). */
const USER_TABLES = [
  "agent_runs",
  "briefing_notes",
  "briefings",
  "channels",
  "consents",
  "conversation_summaries",
  "email_items",
  "integrations",
  "jobs",
  "llm_calls",
  "magic_links",
  "memory_facts",
  "messages",
  "pending_actions",
  "proactive_dedupe",
  "reminders",
  "syllabi",
  "timeline_items",
  "user_preferences",
  "user_profile",
  "user_runtime",
  "web_sessions",
] as const;

/**
 * Delete everything this file created: llm_calls (by user and run), jobs, users (cascade).
 */
export async function cleanup(): Promise<void> {
  const { userIds: us, runIds: rs } = tracked();
  for (let i = 0; i < rs.length; i += 100) await sb.from("llm_calls").delete().in("run_id", rs.slice(i, i + 100));
  for (let i = 0; i < us.length; i += 100) {
    const chunk = us.slice(i, i + 100);
    await sb.from("llm_calls").delete().in("user_id", chunk);
    await sb.from("jobs").delete().in("user_id", chunk);
    await sb.from("users").delete().in("id", chunk);
  }
  for (const t of tokens) dropAccount(t);
}

/**
 * Count rows still referencing this file's users or runs (must all be zero after cleanup).
 * @returns table → count (only non-zero entries)
 */
export async function leftovers(): Promise<Record<string, number>> {
  const { userIds: us, runIds: rs } = tracked();
  const out: Record<string, number> = {};
  const add = (k: string, n: number | null) => {
    if (n) out[k] = (out[k] ?? 0) + n;
  };
  for (let i = 0; i < us.length; i += 100) {
    const chunk = us.slice(i, i + 100);
    for (const t of USER_TABLES) {
      const r = await sb.from(t).select("user_id", { count: "exact", head: true }).in("user_id", chunk);
      add(t, r.count);
    }
    const u = await sb.from("users").select("id", { count: "exact", head: true }).in("id", chunk);
    add("users", u.count);
  }
  for (let i = 0; i < rs.length; i += 100) {
    const r = await sb.from("llm_calls").select("id", { count: "exact", head: true }).in("run_id", rs.slice(i, i + 100));
    add("llm_calls(run_id)", r.count);
  }
  return out;
}
