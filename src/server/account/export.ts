import "server-only";
// OWNER: 4.6

/**
 * Account export (master plan §1.16, §1.18; web plan §7.6 "Export contents").
 *
 * `collectAccountExport` reads every exportable table for one user, paged by 1,000 rows (PostgREST's
 * cap), and `shapeExport` (pure) keeps only an allow-list of columns per table. Secrets never leave:
 * no `enc_*` column, token, hash, feed URL, session, magic link, job, agent run, LLM log, runtime row
 * or conversation summary is selected, and `shapeExport` drops any key matching
 * `FORBIDDEN_EXPORT_KEY` again as a second line of defense. Signups are the user's own (matched to
 * them) only, without the IP or user agent.
 */
import { db } from "@/server/db";
import type { JsonValue } from "@/server/timeline/types";

/** JSON export (version 1): included tables → rows, secrets and internal tables excluded. */
export interface AccountExport {
  version: 1;
  exportedAt: string;
  tables: Record<string, Array<Record<string, JsonValue>>>;
}

/** Rows per PostgREST page. */
export const EXPORT_PAGE_SIZE = 1000;

/**
 * Columns exported per table (web §7.6). Anything not listed is dropped. Internal ids and foreign
 * keys are left out on purpose: the export is for the person, not for re-import.
 */
export const EXPORT_COLUMNS = {
  users: [
    "name",
    "timezone",
    "timezone_source",
    "briefing_enabled",
    "briefing_time",
    "quiet_start",
    "quiet_end",
    "deadline_nudge_minutes",
    "persona_prefs",
    "birth_year",
    "created_at",
  ],
  channels: [
    "kind",
    "handle",
    "handle_kind",
    "provider",
    "is_primary",
    "verified_at",
    "opted_out_at",
    "paused_until",
    "last_inbound_at",
    "created_at",
  ],
  consents: ["scope", "granted", "copy_version", "source", "captured_at"],
  // Only signups matched to this user, and never `ip`/`user_agent`: an unmatched signup for the same
  // phone may be someone else's form submission (5.5 #8).
  signups: ["name", "phone_e164", "timezone", "consent_version", "created_at"],
  user_profile: ["school", "courses", "class_times", "updated_at"],
  user_preferences: ["key", "category", "statement", "status", "source", "constraint_json", "valid_from", "valid_to", "decided_at"],
  memory_facts: ["content", "category", "source", "expires_at", "created_at", "updated_at"],
  timeline_items: [
    "source",
    "kind",
    "title",
    "course",
    "starts_at",
    "ends_at",
    "due_at",
    "all_day",
    "url",
    "status",
    "removed_at",
    "updated_at",
  ],
  reminders: ["body", "kind", "origin", "due_at", "offset_minutes", "rrule", "status", "fire_count", "last_fired_at", "created_at"],
  messages: ["direction", "body", "media", "service", "status", "created_at"],
  email_items: ["from_addr", "subject", "summary", "category", "importance", "kind", "course", "received_at", "created_at"],
  syllabi: ["course_name", "course_code", "term", "status", "parsed_json", "source", "parsed_at"],
  pending_actions: ["kind", "payload", "status", "summary", "result", "created_at", "expires_at", "decided_at", "executed_at"],
  integrations: ["provider", "account_email", "scopes", "status", "synced_at"],
} as const satisfies Record<string, readonly string[]>;

/** Tables in the export, in output order. */
export type ExportTable = keyof typeof EXPORT_COLUMNS;

/** Raw rows as read from the DB, before shaping. Missing tables export as `[]`. */
export type RawExport = Partial<Record<ExportTable, ReadonlyArray<Record<string, unknown>>>>;

/**
 * Keys that must never appear in an export, whatever the allow-list says: secrets, plus the
 * signup form's network metadata (`ip`, `user_agent`).
 */
export const FORBIDDEN_EXPORT_KEY = /^enc_|token|hash|^ip$|user_agent/i;

/**
 * Coerce a DB value to JSON (PostgREST already returns JSON; `inet` etc. become strings).
 * @param v raw value
 * @returns a JSON value
 */
function toJson(v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object") {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = toJson(inner);
    return out;
  }
  return String(v);
}

/**
 * Shape raw rows into the export document (pure): per-table column allow-list, forbidden keys
 * stripped, values coerced to JSON.
 * @param raw rows per table
 * @param now export timestamp
 * @returns version-1 export with every table present (empty tables as `[]`)
 */
export function shapeExport(raw: RawExport, now: Date = new Date()): AccountExport {
  const tables: Record<string, Array<Record<string, JsonValue>>> = {};
  for (const table of Object.keys(EXPORT_COLUMNS) as ExportTable[]) {
    const cols: readonly string[] = EXPORT_COLUMNS[table];
    tables[table] = (raw[table] ?? []).map((row) => {
      const out: Record<string, JsonValue> = {};
      for (const col of cols) {
        if (FORBIDDEN_EXPORT_KEY.test(col)) continue;
        if (Object.prototype.hasOwnProperty.call(row, col)) out[col] = toJson(row[col]);
      }
      return out;
    });
  }
  return { version: 1, exportedAt: now.toISOString(), tables };
}

type PageResult = { data: ReadonlyArray<Record<string, unknown>> | null; error: { message: string } | null };

/**
 * Read every page of a query (`.range(from, to)`) until a short page.
 * @param label table name for errors
 * @param page builds the query for one range (must have a stable order)
 * @returns all rows
 */
async function readAll(label: string, page: (from: number, to: number) => PromiseLike<PageResult>): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += EXPORT_PAGE_SIZE) {
    const { data, error } = await page(from, from + EXPORT_PAGE_SIZE - 1);
    if (error) throw new Error(`collectAccountExport(${label}): ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < EXPORT_PAGE_SIZE) return rows;
  }
}

/** `col1, col2, …` for a table's allow-list (the select never asks for anything else). */
function cols(table: ExportTable): string {
  return EXPORT_COLUMNS[table].join(", ");
}

/**
 * Collect a user's exportable rows (paged by 1,000).
 * @param userId owner
 * @returns the export document
 */
export async function collectAccountExport(userId: string): Promise<AccountExport> {
  const byUser = (table: Exclude<ExportTable, "users" | "signups" | "user_profile">, order: string) =>
    readAll(table, (from, to) =>
      db()
        .from(table)
        .select(`id, ${cols(table)}`)
        .eq("user_id", userId)
        .order(order, { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult>,
    );

  const [user, profile, channels] = await Promise.all([
    db().from("users").select(cols("users")).eq("id", userId).maybeSingle(),
    db().from("user_profile").select(cols("user_profile")).eq("user_id", userId).maybeSingle(),
    byUser("channels", "created_at"),
  ]);
  if (user.error) throw new Error(`collectAccountExport(users): ${user.error.message}`);
  if (profile.error) throw new Error(`collectAccountExport(user_profile): ${profile.error.message}`);

  const [consents, signups, prefs, facts, timeline, reminders, messages, emails, syllabi, pending, integrations] = await Promise.all([
    byUser("consents", "captured_at"),
    readAll("signups", (from, to) =>
      db()
        .from("signups")
        .select(`id, ${cols("signups")}`)
        .eq("matched_user_id", userId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult>,
    ),
    byUser("user_preferences", "valid_from"),
    readAll("memory_facts", (from, to) =>
      db()
        .from("memory_facts")
        .select(`id, ${cols("memory_facts")}`)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult>,
    ),
    byUser("timeline_items", "updated_at"),
    byUser("reminders", "created_at"),
    byUser("messages", "created_at"),
    byUser("email_items", "created_at"),
    byUser("syllabi", "parsed_at"),
    byUser("pending_actions", "created_at"),
    byUser("integrations", "created_at"),
  ]);

  return shapeExport({
    users: user.data ? [user.data as unknown as Record<string, unknown>] : [],
    channels,
    consents,
    signups,
    user_profile: profile.data ? [profile.data as unknown as Record<string, unknown>] : [],
    user_preferences: prefs,
    memory_facts: facts,
    timeline_items: timeline,
    reminders,
    messages,
    email_items: emails,
    syllabi,
    pending_actions: pending,
    integrations,
  });
}
