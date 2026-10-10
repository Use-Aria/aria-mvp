import "server-only";
// OWNER: 2.2

/**
 * Web memory API for /settings "What Aria knows about you" (web plan §8, shapes verbatim).
 * Every call is owner-scoped by `userId`; ids come from `listMemory` (raw UUIDs are fine here —
 * the web is not the model). Facts are hard-deleted.
 */
import { db } from "@/server/db";
import { deleteFacts, updateFact } from "@/server/memory/facts";
import { PreferenceNotOpenError, decidePreference, retirePreferences } from "@/server/memory/preferences";
import { parseCourses, refreshProfileBlock } from "@/server/memory/profile";

/** /settings memory view (web §8). Proposed covers both open questions and queued suggestions. */
export interface MemoryView {
  profile: { name: string | null; school: string | null; courses: string[] };
  preferences: Array<{ id: string; key: string; statement: string; status: "active" | "proposed"; validFrom: Date }>;
  facts: Array<{ id: string; content: string; createdAt: Date; expiresAt: Date | null }>;
}

const MAX_PREF_STATEMENT = 280;
const MAX_FACTS = 200;
const OPEN_STATUSES = ["proposed", "queued"];

function fail(where: string, message: string): never {
  throw new Error(`memory.${where}: ${message}`);
}

function cleanStatement(statement: string): string {
  const t = statement.replace(/\s+/g, " ").trim();
  if (!t || t.length > MAX_PREF_STATEMENT) throw new Error("memory.editPreference: statement must be 1–280 chars");
  return t;
}

/**
 * Everything /settings shows under "What Aria knows about you".
 * @param userId owner
 * @returns profile, active + open (proposed/queued → "proposed") preferences, live facts
 */
export async function listMemory(userId: string): Promise<MemoryView> {
  const nowIso = new Date().toISOString();
  const [u, p, prefs, facts] = await Promise.all([
    db().from("users").select("name").eq("id", userId).maybeSingle(),
    db().from("user_profile").select("school, courses").eq("user_id", userId).maybeSingle(),
    db()
      .from("user_preferences")
      .select("id, key, statement, status, valid_from, category")
      .eq("user_id", userId)
      .in("status", ["active", ...OPEN_STATUSES]),
    db()
      .from("memory_facts")
      .select("id, content, created_at, expires_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(MAX_FACTS),
  ]);
  for (const r of [u, p, prefs, facts]) if (r.error) fail("listMemory", r.error.message);

  const rank = (s: string) => (s === "active" ? 1 : 0);
  const preferences = (prefs.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        (a.category ?? "other").localeCompare(b.category ?? "other") ||
        a.key.localeCompare(b.key) ||
        a.id.localeCompare(b.id),
    )
    .map((r) => ({
      id: r.id,
      key: r.key,
      statement: r.statement,
      status: r.status === "active" ? ("active" as const) : ("proposed" as const),
      validFrom: new Date(r.valid_from),
    }));

  return {
    profile: { name: u.data?.name ?? null, school: p.data?.school ?? null, courses: parseCourses(p.data?.courses ?? null) },
    preferences,
    facts: (facts.data ?? []).map((f) => ({
      id: f.id,
      content: f.content,
      createdAt: new Date(f.created_at),
      expiresAt: f.expires_at ? new Date(f.expires_at) : null,
    })),
  };
}

/**
 * Edit a preference's statement. Active rows use supersede semantics: a new row (source
 * 'explicit') is confirmed via `decide_preference`, which closes the old one atomically. The
 * machine-readable constraint is dropped (the old one may no longer match the words).
 * Open (proposed/queued) rows are edited in place.
 * @param userId owner
 * @param prefId preference id
 * @param statement new text (1–280 chars after trimming)
 * @returns ok, or not_found when no active/open row matches
 */
export async function editPreference(
  userId: string,
  prefId: string,
  statement: string,
): Promise<{ ok: true } | { ok: false; code: "not_found" }> {
  const text = cleanStatement(statement);
  const { data: row, error } = await db()
    .from("user_preferences")
    .select("id, key, category, status")
    .eq("user_id", userId)
    .eq("id", prefId)
    .maybeSingle();
  if (error) fail("editPreference", error.message);
  if (!row) return { ok: false, code: "not_found" };

  if (OPEN_STATUSES.includes(row.status)) {
    const upd = await db()
      .from("user_preferences")
      .update({ statement: text })
      .eq("user_id", userId)
      .eq("id", prefId)
      .in("status", OPEN_STATUSES)
      .select("id");
    if (upd.error) fail("editPreference", upd.error.message);
    return (upd.data?.length ?? 0) > 0 ? { ok: true } : { ok: false, code: "not_found" };
  }
  if (row.status !== "active") return { ok: false, code: "not_found" };

  const ins = await db()
    .from("user_preferences")
    .insert({ user_id: userId, key: row.key, category: row.category, statement: text, status: "queued", source: "explicit" })
    .select("id")
    .single();
  if (ins.error) fail("editPreference", ins.error.message);
  try {
    await decidePreference(userId, ins.data.id, "confirm");
  } catch (e) {
    await db().from("user_preferences").delete().eq("id", ins.data.id).eq("user_id", userId);
    throw e;
  }
  return { ok: true };
}

/**
 * Retire a preference (web delete): active → superseded, open → rejected.
 * @param userId owner
 * @param prefId preference id
 * @returns ok, or not_found when nothing active/open matched
 */
export async function removePreference(userId: string, prefId: string): Promise<{ ok: true } | { ok: false; code: "not_found" }> {
  const n = await retirePreferences(userId, [prefId]);
  return n > 0 ? { ok: true } : { ok: false, code: "not_found" };
}

/**
 * Keep / don't keep a proposed (or queued) preference from the web.
 * @param userId owner
 * @param prefId proposal id
 * @param keep true = confirm, false = reject
 * @returns ok; not_found (no such row for this user) or not_pending (already decided)
 */
export async function answerProposal(
  userId: string,
  prefId: string,
  keep: boolean,
): Promise<{ ok: true } | { ok: false; code: "not_found" | "not_pending" }> {
  try {
    await decidePreference(userId, prefId, keep ? "confirm" : "reject");
    return { ok: true };
  } catch (e) {
    if (!(e instanceof PreferenceNotOpenError)) throw e;
    const { data, error } = await db().from("user_preferences").select("id").eq("user_id", userId).eq("id", prefId).maybeSingle();
    if (error) fail("answerProposal", error.message);
    return { ok: false, code: data ? "not_pending" : "not_found" };
  }
}

/**
 * Edit a remembered fact's text (source becomes 'user_edit').
 * @param userId owner
 * @param factId fact id
 * @param content new text (1–500 chars)
 * @returns ok or not_found
 */
export async function editFact(userId: string, factId: string, content: string): Promise<{ ok: true } | { ok: false; code: "not_found" }> {
  const ok = await updateFact(userId, factId, { content, source: "user_edit" });
  return ok ? { ok: true } : { ok: false, code: "not_found" };
}

/**
 * Hard delete ("forget X" must really forget).
 * @param userId owner
 * @param factId fact id
 * @returns ok or not_found
 */
export async function deleteFact(userId: string, factId: string): Promise<{ ok: true } | { ok: false; code: "not_found" }> {
  const n = await deleteFacts(userId, [factId]);
  return n > 0 ? { ok: true } : { ok: false, code: "not_found" };
}

/**
 * Set `user_profile.school` (web Canvas connect) and refresh the profile block.
 * @param userId owner
 * @param school school name, or null to clear
 */
export async function setProfileSchool(userId: string, school: string | null): Promise<void> {
  const value = school?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const { error } = await db()
    .from("user_profile")
    .upsert({ user_id: userId, school: value, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) fail("setProfileSchool", error.message);
  await refreshProfileBlock(userId);
}
