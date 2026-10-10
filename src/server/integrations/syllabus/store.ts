import "server-only";
// OWNER: 3.5

/**
 * `syllabi` access (V2-08 §7.2 `store.ts`). Upsert key `(user_id, course_key)` so a row id is
 * stable across re-parses. Course lookup never matches on an empty query (the V1
 * `ilike('%'+''+'%')` bug): exact key → cross-listed key → case-insensitive name → title words
 * (queries ≥ 4 chars only).
 */
import { db } from "@/server/db";
import type { Json } from "@/server/db/types";
import type { ParseSyllabusResponse } from "@/server/integrations/syllabus/contract";
import { displayCourseKey } from "@/server/integrations/syllabus/confirm";
import { readParsedJson } from "@/server/integrations/syllabus/signals";
import type { SyllabusRow, SyllabusSummary } from "@/server/integrations/syllabus/types";
import { courseKey } from "@/shared/course-key";

const ROW_COLUMNS =
  "id, user_id, course_key, course_name, course_code, term, status, source, source_message_id, pdf_sha256, page_count, model, parser_version, issues, parsed_json, parsed_at, updated_at";

const QUERY_STOPWORDS = new Set(["the", "a", "an", "of", "and", "my", "class", "course", "syllabus", "intro", "to", "for", "in"]);

function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !QUERY_STOPWORDS.has(w));
}

/**
 * Pick the stored syllabus a course query refers to. Pure.
 * @param rows candidate rows (one user's syllabi)
 * @param query "CPSC 223", "cpsc223", "data structures", …
 * @returns the matching row, or null (always null for an empty query)
 */
export function matchSyllabusCourse<R extends Pick<SyllabusRow, "course_key" | "course_name" | "parsed_json">>(
  rows: readonly R[],
  query: string,
): R | null {
  const q = query.trim();
  if (!q) return null;
  const key = courseKey(q);
  if (key) {
    const exact = rows.find((r) => r.course_key === key);
    if (exact) return exact;
    const cross = rows.find((r) => readParsedJson(r.parsed_json)?.course.cross_listed.some((c) => courseKey(c) === key));
    if (cross) return cross;
  }
  const lower = q.toLowerCase();
  const byName = rows.find((r) => r.course_name.trim().toLowerCase() === lower);
  if (byName) return byName;
  if (q.length < 4) return null;
  const want = words(q);
  if (want.length === 0) return null;
  const hits = rows.filter((r) => {
    const parsed = readParsedJson(r.parsed_json);
    const have = new Set(words(`${r.course_name} ${parsed?.course.title ?? ""}`));
    return want.every((w) => have.has(w));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Row with the same file hash (re-parse guard).
 * @param userId owner
 * @param sha256 hex SHA-256 of the PDF bytes
 * @returns the row, or null
 */
export async function findSyllabusByHash(userId: string, sha256: string): Promise<SyllabusRow | null> {
  const { data, error } = await db()
    .from("syllabi")
    .select(ROW_COLUMNS)
    .eq("user_id", userId)
    .eq("pdf_sha256", sha256)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`syllabus.findSyllabusByHash: ${error.code ?? "db_error"}`);
  return data;
}

/**
 * All stored rows of a user (small: one per course).
 * @param userId owner
 * @returns rows ordered by course key
 */
export async function loadSyllabi(userId: string): Promise<SyllabusRow[]> {
  const { data, error } = await db().from("syllabi").select(ROW_COLUMNS).eq("user_id", userId).order("course_key");
  if (error) throw new Error(`syllabus.loadSyllabi: ${error.code ?? "db_error"}`);
  return data ?? [];
}

/**
 * Find a saved syllabus by course (exact course_key, cross-listed key, case-insensitive
 * course_name, then title words for queries ≥ 4 chars; never on empty).
 * @param userId owner
 * @param query course code or name
 * @returns the row, or null
 */
export async function findSyllabusByCourse(userId: string, query: string): Promise<SyllabusRow | null> {
  if (!query.trim()) return null;
  return matchSyllabusCourse(await loadSyllabi(userId), query);
}

/**
 * Saved syllabi.
 * @param userId owner
 * @returns summaries ordered by course key
 */
export async function listSyllabi(userId: string): Promise<SyllabusSummary[]> {
  const { data, error } = await db()
    .from("syllabi")
    .select("id, course_key, course_name, parsed_at, status")
    .eq("user_id", userId)
    .order("course_key");
  if (error) throw new Error(`syllabus.listSyllabi: ${error.code ?? "db_error"}`);
  return data ?? [];
}

/**
 * Display label of a parsed course: "HIST 101 The Ancient World" (code + title), else the key.
 * @param course parsed course block
 * @param key normalized key
 * @returns label (≤ 160 chars)
 */
export function courseLabelFor(course: { code: string; title: string }, key: string): string {
  const label = [course.code.trim(), course.title.trim()].filter((s) => s.length > 0).join(" ");
  return (label || displayCourseKey(key)).slice(0, 160);
}

/**
 * Insert or replace the syllabus of one course (upsert on `(user_id, course_key)`).
 * @param userId owner
 * @param res parser response (status ok | needs_review, `syllabus` non-null)
 * @param meta provenance: source, inbound message, file hash, and the resolved course key
 * @returns the stored row, whether an earlier parse was replaced, and its parse time
 */
export async function upsertSyllabus(
  userId: string,
  res: ParseSyllabusResponse,
  meta: { source: "imessage" | "upload" | "dev"; sourceMessageId?: string; sha256: string; courseKey: string },
): Promise<{ row: SyllabusRow; replaced: boolean; previousParsedAt: string | null }> {
  const parsed = res.syllabus;
  if (!parsed) throw new Error("syllabus.upsertSyllabus: response has no syllabus");
  const prev = await db()
    .from("syllabi")
    .select("id, parsed_at")
    .eq("user_id", userId)
    .eq("course_key", meta.courseKey)
    .maybeSingle();
  if (prev.error) throw new Error(`syllabus.upsertSyllabus(prev): ${prev.error.code ?? "db_error"}`);
  const chosen = res.chosen_attempt !== null ? res.attempts[res.chosen_attempt] : undefined;
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("syllabi")
    .upsert(
      {
        user_id: userId,
        course_key: meta.courseKey,
        course_name: courseLabelFor(parsed.course, meta.courseKey),
        course_code: parsed.course.code || null,
        term: parsed.course.term || null,
        status: res.status === "needs_review" ? "needs_review" : "parsed",
        source: meta.source,
        source_message_id: meta.sourceMessageId ?? null,
        pdf_sha256: meta.sha256,
        page_count: res.page_count,
        model: chosen?.model ?? null,
        parser_version: res.parser_version,
        issues: res.issues as unknown as Json,
        parsed_json: parsed as unknown as Json,
        parsed_at: now,
        updated_at: now,
      },
      { onConflict: "user_id,course_key" },
    )
    .select(ROW_COLUMNS)
    .single();
  if (error || !data) throw new Error(`syllabus.upsertSyllabus: ${error?.code ?? "no_row"}`);
  return { row: data, replaced: prev.data !== null, previousParsedAt: prev.data?.parsed_at ?? null };
}
