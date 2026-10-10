import "server-only";
// OWNER: 3.5

/**
 * Syllabus integration types (master plan §1.13). Re-exported by the barrel `index.ts`.
 * `IntakeInput` / `IntakeOutcome` keep the Wave 0 shapes; the fields marked "3.5" are optional
 * additions (non-breaking).
 */
import type { Tables } from "@/server/db";
import type { ParsedSyllabus, ParseIssue } from "@/server/integrations/syllabus/contract";

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
  /** 3.5: epoch ms after which the parser call must not run (job deadline / route budget) */
  deadline?: number;
  /** 3.5: caller abort (job lease loss) */
  signal?: AbortSignal;
}

/** Next upcoming exam, for the confirmation line (3.5). */
export interface NextExam {
  title: string;
  /** ISO instant (timed) or null */
  startsAt: string | null;
  /** "YYYY-MM-DD" local date */
  date: string;
  allDay: boolean;
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
      /** 3.5: soonest upcoming dated exam */
      nextExam?: NextExam | null;
      /** 3.5: grading weights total (null when no weights) */
      gradingTotalPct?: number | null;
      /** 3.5: pages in the file / pages read (> 40 pages → first 20 read) */
      pageCount?: number;
      truncatedPages?: boolean;
      /** 3.5: this was a re-delivery of an already-stored parse of the same message (job retry) */
      redelivered?: boolean;
    }
  /** same course already parsed and `replace` not confirmed (or the very same file — `reason`) */
  | { status: "exists"; courseKey: string; courseLabel: string; parsedAt: string; reason?: "same_course" | "same_file" }
  | { status: "not_syllabus"; documentKind: string }
  | { status: "unreadable" }
  | { status: "rate_limited" }
  /** download / parser failure (`code` from MediaFetchError or ParserError) */
  | { status: "failed"; code: string; retryable: boolean; httpStatus?: number };
