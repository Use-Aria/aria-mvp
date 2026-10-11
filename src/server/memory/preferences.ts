import "server-only";
// OWNER: 2.2

/**
 * Preference rows (`user_preferences`, V2-04 §2.7). Bitemporal lifecycle:
 * proposed → active → superseded, or rejected / queued / expired.
 * Partial unique indexes: one `active` row per (user, key); one open `proposed` row per user.
 * Confirm/reject goes through the atomic SQL `decide_preference`.
 */
import { db, type Tables } from "@/server/db";
import type { Json } from "@/server/db/types";
import { findReplacedPreference } from "@/server/memory/preference-policy";

/** Preference as the rest of the app sees it (master plan §1.7). */
export interface PreferenceRow {
  id: string;
  key: string;
  category: string | null;
  statement: string;
  status: string;
  source: string | null;
  constraintJson: unknown | null;
  validFrom: Date;
}

/** Preference row plus when its question was asked (null if never). */
export interface OpenQuestionRow extends PreferenceRow {
  askedAt: Date | null;
}

/** `decide_preference` refused: the row isn't `proposed`/`queued` (or isn't this user's). */
export class PreferenceNotOpenError extends Error {
  constructor() {
    super("preference is not open");
    this.name = "PreferenceNotOpenError";
  }
}

const OPEN_QUESTION_INDEX = "user_preferences_one_open_question";
const QUESTION_TTL_H = 24;
const QUEUED_TTL_DAYS = 7;

/**
 * Map a DB row.
 * @param r user_preferences row
 * @returns the app-facing row
 */
export function toPreferenceRow(r: Tables<"user_preferences">): PreferenceRow {
  return {
    id: r.id,
    key: r.key,
    category: r.category,
    statement: r.statement,
    status: r.status,
    source: r.source,
    constraintJson: r.constraint_json ?? null,
    validFrom: new Date(r.valid_from),
  };
}

function fail(where: string, message: string): never {
  throw new Error(`memory.${where}: ${message}`);
}

/**
 * Active preferences, sorted by category then key (deterministic).
 * @param userId owner
 * @returns active rows
 */
export async function listActivePreferences(userId: string): Promise<PreferenceRow[]> {
  const { data, error } = await db()
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("category", { ascending: true, nullsFirst: false })
    .order("key", { ascending: true })
    .order("id", { ascending: true });
  if (error) fail("listActivePreferences", error.message);
  return (data ?? []).map(toPreferenceRow);
}

/**
 * The one open `proposed` preference question, if any.
 * @param userId owner
 * @returns the open question (with `askedAt`) or null
 */
export async function getOpenQuestion(userId: string): Promise<OpenQuestionRow | null> {
  const { data, error } = await db()
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "proposed")
    .maybeSingle();
  if (error) fail("getOpenQuestion", error.message);
  if (!data) return null;
  return { ...toPreferenceRow(data), askedAt: data.asked_at ? new Date(data.asked_at) : null };
}

/**
 * Queued proposals to surface later (V2-06 briefing asks ≤1 per briefing).
 * @param userId owner
 * @param limit max rows (default 1)
 * @returns queued rows, oldest first
 */
export async function listQueuedProposals(userId: string, limit: number = 1): Promise<PreferenceRow[]> {
  const { data, error } = await db()
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "queued")
    .order("valid_from", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.floor(limit)));
  if (error) fail("listQueuedProposals", error.message);
  return (data ?? []).map(toPreferenceRow);
}

/**
 * Insert a preference proposal: `proposed` = ask now (sets `asked_at`), `queued` = ask later.
 * If another question is still open from an earlier conversation, that one goes back to
 * `queued` so the new question becomes the open one (the one-open-question index holds).
 * @param a proposal fields (`runId` = the proposing agent run)
 * @returns the inserted row
 */
export async function insertProposal(a: {
  userId: string;
  key: string;
  category: string;
  statement: string;
  status: "proposed" | "queued";
  runId: string;
  evidenceMessageId: string | null;
  constraintJson?: unknown;
}): Promise<PreferenceRow> {
  const row = {
    user_id: a.userId,
    key: a.key,
    category: a.category,
    statement: a.statement.trim(),
    status: a.status,
    proposed_by_run: a.runId,
    evidence_message_id: a.evidenceMessageId,
    constraint_json: (a.constraintJson ?? null) as Json,
    asked_at: a.status === "proposed" ? new Date().toISOString() : null,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db().from("user_preferences").insert(row).select("*").single();
    if (!error) return toPreferenceRow(data);
    const openClash = error.code === "23505" && error.message.includes(OPEN_QUESTION_INDEX);
    if (!openClash || attempt > 0) fail("insertProposal", error.message);
    const requeue = await db()
      .from("user_preferences")
      .update({ status: "queued" })
      .eq("user_id", a.userId)
      .eq("status", "proposed");
    if (requeue.error) fail("insertProposal", requeue.error.message);
  }
  return fail("insertProposal", "unreachable");
}

/**
 * Save a preference the user explicitly stated ("remember: sign my emails 'Best, Dan'"):
 * inserted as `queued` with source 'explicit', then confirmed via `decide_preference`
 * (which supersedes any active row with the same key).
 * Callers must have checked `decideProposal(...) === "activate"`.
 * @param a preference fields
 * @returns the now-active row
 */
export async function saveExplicitPreference(a: {
  userId: string;
  key: string;
  category: string;
  statement: string;
  runId: string | null;
  evidenceMessageId: string | null;
  constraintJson?: unknown;
}): Promise<PreferenceRow> {
  const { data, error } = await db()
    .from("user_preferences")
    .insert({
      user_id: a.userId,
      key: a.key,
      category: a.category,
      statement: a.statement.trim(),
      status: "queued",
      source: "explicit",
      proposed_by_run: a.runId,
      evidence_message_id: a.evidenceMessageId,
      constraint_json: (a.constraintJson ?? null) as Json,
    })
    .select("id")
    .single();
  if (error) fail("saveExplicitPreference", error.message);
  try {
    return await decidePreference(a.userId, data.id, "confirm");
  } catch (e) {
    await db().from("user_preferences").delete().eq("id", data.id).eq("user_id", a.userId);
    throw e;
  }
}

/**
 * Before a confirm: if the proposal replaces an active rule saved under a DIFFERENT key (same
 * single-valued constraint, or the same statement — `findReplacedPreference`), move the proposal
 * onto that key so `decide_preference` supersedes the old row instead of leaving two active rules.
 * Covers every confirm path (chat tool, web, explicit save, extraction proposals). Best effort:
 * the open row's key is the only thing changed; the supersede itself stays atomic in SQL.
 * @param userId owner
 * @param prefId the open proposal
 */
async function alignWithReplacedRule(userId: string, prefId: string): Promise<void> {
  const { data: row, error } = await db()
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .eq("id", prefId)
    .in("status", ["proposed", "queued"])
    .maybeSingle();
  if (error) fail("decidePreference", error.message);
  if (!row) return; // not open: the rpc reports it
  const replaced = findReplacedPreference(await listActivePreferences(userId), {
    key: row.key,
    statement: row.statement,
    constraintJson: row.constraint_json ?? null,
  });
  if (!replaced || replaced.key === row.key) return;
  const upd = await db()
    .from("user_preferences")
    .update({ key: replaced.key })
    .eq("user_id", userId)
    .eq("id", prefId)
    .in("status", ["proposed", "queued"]);
  if (upd.error) fail("decidePreference", upd.error.message);
}

/**
 * Confirm or reject a proposal atomically (rpc `decide_preference`; confirm supersedes the
 * active row with the same key — after `alignWithReplacedRule` moved a proposal that replaces a
 * rule saved under another key onto that key).
 * @param userId owner
 * @param prefId preference id (must be `proposed` or `queued`)
 * @param d decision
 * @returns the decided row
 * @throws PreferenceNotOpenError when the row isn't open or isn't this user's
 */
export async function decidePreference(userId: string, prefId: string, d: "confirm" | "reject"): Promise<PreferenceRow> {
  if (d === "confirm") await alignWithReplacedRule(userId, prefId);
  const { data, error } = await db().rpc("decide_preference", { p_user: userId, p_pref: prefId, p_decision: d });
  if (error) {
    if (error.code === "P0002" || error.message.includes("preference_not_open")) throw new PreferenceNotOpenError();
    fail("decidePreference", error.message);
  }
  return toPreferenceRow(data);
}

/**
 * Retire preferences ("forget"/web delete): active → superseded, open (proposed/queued) →
 * rejected. Closed rows are left alone.
 * @param userId owner
 * @param ids preference ids
 * @returns number of rows retired
 */
export async function retirePreferences(userId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  const [active, open] = await Promise.all([
    db()
      .from("user_preferences")
      .update({ status: "superseded", valid_to: now })
      .eq("user_id", userId)
      .in("id", [...ids])
      .eq("status", "active")
      .select("id"),
    db()
      .from("user_preferences")
      .update({ status: "rejected", valid_to: now, decided_at: now })
      .eq("user_id", userId)
      .in("id", [...ids])
      .in("status", ["proposed", "queued"])
      .select("id"),
  ]);
  if (active.error) fail("retirePreferences", active.error.message);
  if (open.error) fail("retirePreferences", open.error.message);
  return (active.data?.length ?? 0) + (open.data?.length ?? 0);
}

/**
 * Housekeeping (run by the memory job): an unanswered question older than 24h goes back to
 * `queued`; a queued proposal older than 7 days expires.
 * @param userId owner
 * @param now clock (default: now)
 * @returns rows re-queued and expired
 */
export async function expireStaleQuestions(userId: string, now: Date = new Date()): Promise<{ requeued: number; expired: number }> {
  const askedBefore = new Date(now.getTime() - QUESTION_TTL_H * 3_600_000).toISOString();
  const queuedBefore = new Date(now.getTime() - QUEUED_TTL_DAYS * 86_400_000).toISOString();
  const requeue = await db()
    .from("user_preferences")
    .update({ status: "queued" })
    .eq("user_id", userId)
    .eq("status", "proposed")
    .lt("asked_at", askedBefore)
    .select("id");
  if (requeue.error) fail("expireStaleQuestions", requeue.error.message);
  const expire = await db()
    .from("user_preferences")
    .update({ status: "expired", valid_to: now.toISOString() })
    .eq("user_id", userId)
    .eq("status", "queued")
    .lt("valid_from", queuedBefore)
    .select("id");
  if (expire.error) fail("expireStaleQuestions", expire.error.message);
  return { requeued: requeue.data?.length ?? 0, expired: expire.data?.length ?? 0 };
}
