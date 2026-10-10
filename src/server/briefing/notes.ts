import "server-only";
// OWNER: 2.6

/**
 * Briefing notes: things to mention in the next briefing (master plan §1.14; `briefing_notes`
 * table, V2-06 §4). Titles in payloads are untrusted third-party text; the briefing renderer
 * wraps them. Never store email bodies here.
 */
import { db } from "@/server/db";
import type { Json } from "@/server/db/types";
import type { JsonValue } from "@/server/timeline/types";

/** `briefing_notes.kind` (check constraint in migration 003 §8). */
export type BriefingNoteKind =
  | "due_changed"
  | "item_removed"
  | "reminder_cancelled"
  | "reminder_expired"
  | "alert_expired"
  | "preference_proposal"
  | "other";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";
/** Postgres foreign-key-violation SQLSTATE. */
const FK_VIOLATION = "23503";

/**
 * Add a note for the next briefing. With `dedupeKey`, at most one unconsumed note per key
 * (a replay is a silent no-op).
 * @param userId owner
 * @param kind note kind
 * @param payload note data (titles are untrusted; wrapped at render time)
 * @param o optional related timeline item and dedupe key
 * @throws on a DB error other than the dedupe conflict
 */
export async function addBriefingNote(
  userId: string,
  kind: BriefingNoteKind,
  payload: Record<string, JsonValue>,
  o?: { itemId?: string; dedupeKey?: string },
): Promise<void> {
  const insert = (itemId: string | null) =>
    db()
      .from("briefing_notes")
      .insert({ user_id: userId, kind, payload: payload as Json, item_id: itemId, dedupe_key: o?.dedupeKey ?? null });
  let { error } = await insert(o?.itemId ?? null);
  // The item may already be hard-deleted (e.g. an `item_removed` note): keep the note, drop the link.
  if (error?.code === FK_VIOLATION && o?.itemId) ({ error } = await insert(null));
  if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`addBriefingNote: ${error.message}`);
}
