import "server-only";
// OWNER: 2.2

/**
 * Facts tier (`memory_facts`, V2-04 §2.7). Recall is Postgres FTS (`recall_facts`: OR of query
 * words, `ts_rank_cd` blended with a 30-day recency decay; expired and deleted rows excluded).
 * Deletes are HARD ("forget X" must really forget). Writes come only from user-authored text
 * (extraction job, explicit saves, web edits).
 */
import { db } from "@/server/db";

/** Recalled fact with its blended FTS + recency score. */
export interface RecalledFact {
  id: string;
  content: string;
  createdAt: Date;
  score: number;
}

/** Live fact row. */
export interface FactRow {
  id: string;
  content: string;
  createdAt: Date;
}

/** `memory_facts.category` values. */
export type FactCategory = "people" | "academics" | "career" | "schedule" | "life" | "other";
/** `memory_facts.source` values. */
export type FactSource = "extraction" | "explicit" | "user_edit";

const DEFAULT_RECALL = 8;
const MAX_RECALL = 20;
const MAX_CONTENT = 500;
// Built at runtime: `\p{…}` needs the `u` flag, which the ES2017 TS target rejects in literals.
const HAS_WORD_RE = new RegExp("[\\p{L}\\p{N}]", "u");

function fail(where: string, message: string): never {
  throw new Error(`memory.${where}: ${message}`);
}

function cleanContent(content: string): string {
  const t = content.replace(/\s+/g, " ").trim();
  if (!t) throw new Error("memory.facts: empty content");
  return t.length <= MAX_CONTENT ? t : t.slice(0, MAX_CONTENT);
}

/**
 * Full-text recall over live facts; bumps `last_recalled_at` on the hits (best-effort).
 * Punctuation in the query is safe (the SQL strips it).
 * @param userId owner
 * @param query keywords (blank → no results)
 * @param limit max results (default 8, max 20)
 * @returns facts, best first
 */
export async function recallFacts(userId: string, query: string, limit: number = DEFAULT_RECALL): Promise<RecalledFact[]> {
  if (!HAS_WORD_RE.test(query)) return [];
  const n = Math.min(MAX_RECALL, Math.max(1, Math.floor(limit)));
  const { data, error } = await db().rpc("recall_facts", { p_user: userId, p_query: query.slice(0, 300), p_limit: n });
  if (error) fail("recallFacts", error.message);
  const rows = (data ?? []).map((r) => ({ id: r.id, content: r.content, createdAt: new Date(r.created_at), score: r.score }));
  if (rows.length > 0) {
    const { error: bump } = await db()
      .from("memory_facts")
      .update({ last_recalled_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in(
        "id",
        rows.map((r) => r.id),
      );
    if (bump) console.warn("memory.recallFacts: last_recalled_at update failed", bump.code);
  }
  return rows;
}

/**
 * Most recent live facts (not deleted, not expired).
 * @param userId owner
 * @param limit max results
 * @returns facts, newest first
 */
export async function listRecentFacts(userId: string, limit: number): Promise<FactRow[]> {
  const { data, error } = await db()
    .from("memory_facts")
    .select("id, content, created_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.floor(limit)));
  if (error) fail("listRecentFacts", error.message);
  return (data ?? []).map((r) => ({ id: r.id, content: r.content, createdAt: new Date(r.created_at) }));
}

/**
 * Insert a fact (extraction job or explicit "remember that …").
 * @param a fact fields; content ≤ 500 chars (longer is cut)
 * @returns the new id
 */
export async function insertFact(a: {
  userId: string;
  content: string;
  source: FactSource;
  category?: FactCategory | null;
  sourceMessageId?: string | null;
  expiresAt?: Date | null;
  confidence?: number | null;
}): Promise<{ id: string }> {
  const { data, error } = await db()
    .from("memory_facts")
    .insert({
      user_id: a.userId,
      content: cleanContent(a.content),
      source: a.source,
      category: a.category ?? null,
      source_message_id: a.sourceMessageId ?? null,
      expires_at: a.expiresAt ? a.expiresAt.toISOString() : null,
      confidence: a.confidence ?? null,
    })
    .select("id")
    .single();
  if (error) fail("insertFact", error.message);
  return { id: data.id };
}

/**
 * Update a live fact (owner-scoped).
 * @param userId owner
 * @param factId fact id
 * @param patch new content / category / expiry / source
 * @returns true if a live row was updated
 */
export async function updateFact(
  userId: string,
  factId: string,
  patch: { content?: string; category?: FactCategory | null; expiresAt?: Date | null; source?: FactSource },
): Promise<boolean> {
  const update: {
    updated_at: string;
    content?: string;
    category?: string | null;
    expires_at?: string | null;
    source?: string;
  } = { updated_at: new Date().toISOString() };
  if (patch.content !== undefined) update.content = cleanContent(patch.content);
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt ? patch.expiresAt.toISOString() : null;
  if (patch.source !== undefined) update.source = patch.source;
  const { data, error } = await db()
    .from("memory_facts")
    .update(update)
    .eq("user_id", userId)
    .eq("id", factId)
    .is("deleted_at", null)
    .select("id");
  if (error) fail("updateFact", error.message);
  return (data?.length ?? 0) > 0;
}

/**
 * HARD-delete facts (owner-scoped). Used by `forget` and the web delete.
 * @param userId owner
 * @param ids fact ids
 * @returns number of rows deleted
 */
export async function deleteFacts(userId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await db().from("memory_facts").delete().eq("user_id", userId).in("id", [...ids]).select("id");
  if (error) fail("deleteFacts", error.message);
  return data?.length ?? 0;
}
