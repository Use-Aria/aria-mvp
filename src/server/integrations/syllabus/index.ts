import "server-only";
// OWNER: 3.5
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 3.5 lands */

/**
 * Syllabus integration surface (master plan §1.13; V2-08 §7.2 / §8.2). Wave 0 stub:
 * `collapseSyllabusDuplicates` is identity, reads return [] / null, intake throws.
 * Task 3.5 splits this into intake/store/signals/dedupe/confirm and re-exports the same names.
 */
import { notImplemented } from "@/server/_stub";
import type { Tables } from "@/server/db";
import type { ParsedSyllabus, ParseIssue } from "@/server/integrations/syllabus/contract";
import type { TimelineLike } from "@/server/timeline/types";

export { callParseSyllabus, ParserError } from "@/server/integrations/syllabus/client";
export type * from "@/server/integrations/syllabus/contract";

/** A stored syllabus. */
export type SyllabusRow = Tables<"syllabi">;
/** Listing shape (V2-08 `listSyllabi`). */
export type SyllabusSummary = Pick<SyllabusRow, "id" | "course_key" | "course_name" | "parsed_at" | "status">;

/** Scheduling/briefing signals from one saved syllabus (V2-08 §7.2 `signals.ts`). */
export interface SyllabusSignals {
  courseKey: string;
  courseLabel: string;
  grading: { name: string; weightPct: number | null }[];
  exams: { title: string; startsAt: string | null; weightPct: number | null; topics: string[] }[];
  meetings: ParsedSyllabus["meetings"];
}

/** Intake request shared by the `syllabus_parse` job and the upload route. */
export interface IntakeInput {
  userId: string;
  bytes: Buffer;
  source: "imessage" | "upload" | "dev";
  sourceMessageId?: string;
  filename?: string;
  courseHint?: string;
  replace?: boolean;
  jobId?: string;
}

/** Result of one intake; `renderSyllabusConfirmation` turns it into 1–2 bubbles. */
export type IntakeOutcome =
  | {
      status: "ok" | "needs_review";
      syllabusId: string;
      courseKey: string;
      courseLabel: string;
      /** true when an earlier parse of this course was replaced */
      replaced: boolean;
      previousParsedAt: string | null;
      examCount: number;
      assignmentCount: number;
      /** timeline items written */
      itemCount: number;
      issues: ParseIssue[];
      /** the user's hint named a different course than the parsed one */
      courseMismatch: boolean;
    }
  /** same course already parsed and `replace` not confirmed */
  | { status: "exists"; courseKey: string; courseLabel: string; parsedAt: string }
  | { status: "not_syllabus"; documentKind: string }
  | { status: "unreadable" }
  | { status: "rate_limited" }
  /** download / parser failure (`code` from MediaFetchError or ParserError) */
  | { status: "failed"; code: string; retryable: boolean };

/** Read-time collapse: drop syllabus items shadowed by Canvas items, attach `syllabus` info. Wave 0: identity. */
export function collapseSyllabusDuplicates<T extends TimelineLike>(items: readonly T[], timezone: string): T[] {
  return [...items];
}

/**
 * Signals from every saved syllabus (meetings as busy time, exam weights/topics).
 * @param userId owner
 * @returns one entry per syllabus (Wave 0: none)
 */
export async function getSyllabusSignals(userId: string): Promise<SyllabusSignals[]> {
  return [];
}

/**
 * Rate limit → hash guard → hint guard → parser → store → timeline upsert + prune → outcome.
 * @param input PDF bytes and context
 * @returns intake outcome
 */
export async function runSyllabusIntake(input: IntakeInput): Promise<IntakeOutcome> {
  throw notImplemented("3.5");
}

/**
 * Find a saved syllabus by course (exact course_key, then case-insensitive course_name; never on empty).
 * @param userId owner
 * @param query course code or name
 * @returns the row, or null
 */
export async function findSyllabusByCourse(userId: string, query: string): Promise<SyllabusRow | null> {
  return null;
}

/**
 * Saved syllabi.
 * @param userId owner
 * @returns summaries (Wave 0: none)
 */
export async function listSyllabi(userId: string): Promise<SyllabusSummary[]> {
  return [];
}
