import "server-only";
// OWNER: 3.5 (Wave 0 wrote the contract mirror; master plan §1.13 = V2-08 §8.1 verbatim)

/**
 * Parser HTTP contract v1 (`POST /v1/parse-syllabus`), zod mirror + inferred types.
 * Headers: `content-type: application/json`, `x-aria-timestamp`, `x-aria-signature: v1=<hex>`,
 * `x-aria-request-id: <uuid>`. Error body `{error: {code, message, retryable}}` (V2-08 §8.1 table).
 * Lenient on extra keys (the Python side may add fields within v1).
 */
import { z } from "zod";

/** Contract version echoed in every response. */
export const PARSER_CONTRACT = "v1";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DateConfidence = z.enum(["exact", "inferred_year", "from_week", "unresolved"]);
const WeekdayCode = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/** Request body of `POST /v1/parse-syllabus`. */
export const parseSyllabusRequestSchema = z.object({
  /** standard base64, no newlines */
  pdf_base64: z.string().min(1),
  /** prompt label only; never logged */
  filename: z.string().nullable(),
  /** ≤ 80 chars, user-authored */
  course_hint: z.string().max(80).nullable(),
  /** users.timezone (IANA) */
  timezone: z.string().min(1),
  /** user-local date */
  today: IsoDate,
  term: z.object({ name: z.string().nullable(), start: IsoDate.nullable(), end: IsoDate.nullable() }).nullable(),
  known_courses: z.array(z.object({ key: z.string(), label: z.string() })).max(12),
  allow_escalation: z.boolean(),
});

const parsedExamSchema = z.object({
  title: z.string(),
  kind: z.string(),
  date_text: z.string(),
  date: IsoDate.nullable(),
  date_confidence: DateConfidence,
  all_day: z.boolean(),
  start_local: z.string().nullable(),
  end_local: z.string().nullable(),
  starts_at_utc: z.string().nullable(),
  ends_at_utc: z.string().nullable(),
  location: z.string(),
  weight_pct: z.number().nullable(),
  topics: z.array(z.string()),
  cumulative: z.boolean(),
});

const parsedAssignmentSchema = z.object({
  title: z.string(),
  category: z.string(),
  due_text: z.string(),
  due_date: IsoDate.nullable(),
  date_confidence: DateConfidence,
  all_day: z.boolean(),
  due_local: z.string().nullable(),
  due_at_utc: z.string().nullable(),
  weight_pct: z.number().nullable(),
});

const parsedSyllabusSchema = z.object({
  course: z.object({
    code: z.string(),
    title: z.string(),
    key: z.string(),
    cross_listed: z.array(z.string()),
    term: z.string(),
    term_start: IsoDate.nullable(),
    term_end: IsoDate.nullable(),
  }),
  timezone: z.string(),
  instructors: z.array(
    z.object({
      name: z.string(),
      role: z.enum(["instructor", "ta", "other"]),
      email: z.string(),
      office_hours: z.string(),
    }),
  ),
  meetings: z.array(
    z.object({
      kind: z.string(),
      days: z.array(WeekdayCode),
      start_local: z.string().nullable(),
      end_local: z.string().nullable(),
      location: z.string(),
    }),
  ),
  grading: z.array(z.object({ name: z.string(), weight_pct: z.number().nullable(), notes: z.string() })),
  grading_total_pct: z.number().nullable(),
  exams: z.array(parsedExamSchema),
  assignments: z.array(parsedAssignmentSchema),
  schedule: z.array(
    z.object({
      week: z.number().nullable(),
      date: IsoDate.nullable(),
      topics: z.array(z.string()),
      readings: z.array(z.string()),
      due: z.array(z.string()),
    }),
  ),
  policies: z.object({
    late_work: z.string(),
    attendance: z.string(),
    collaboration: z.string(),
    exam_makeup: z.string(),
  }),
  notes: z.array(z.string()),
});

const parseIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warn"]),
  message: z.string(),
  path: z.string().optional(),
});

const llmAttemptSchema = z.object({
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
  latency_ms: z.number(),
  stop_reason: z.string().nullable(),
  outcome: z.enum(["ok", "invalid", "refused", "truncated", "api_error", "timeout"]),
});

/** 200 response body of `POST /v1/parse-syllabus`. */
export const parseSyllabusResponseSchema = z.object({
  contract: z.literal(PARSER_CONTRACT),
  status: z.enum(["ok", "needs_review", "not_syllabus", "unreadable"]),
  document_kind: z.enum(["syllabus", "course_schedule", "assignment", "exam", "reading", "other"]),
  /** null for not_syllabus / unreadable */
  syllabus: parsedSyllabusSchema.nullable(),
  issues: z.array(parseIssueSchema),
  attempts: z.array(llmAttemptSchema),
  chosen_attempt: z.number().int().nullable(),
  page_count: z.number().int(),
  sent_pages: z.number().int(),
  truncated_pages: z.boolean(),
  scanned: z.boolean(),
  /** computed by the parser too; TS asserts equality */
  pdf_sha256: z.string(),
  parser_version: z.string(),
  prompt_version: z.string(),
});

/** Error response body (4xx/5xx). */
export const parserErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
});

export type ParseSyllabusRequest = z.infer<typeof parseSyllabusRequestSchema>;
export type ParseSyllabusResponse = z.infer<typeof parseSyllabusResponseSchema>;
export type ParsedSyllabus = z.infer<typeof parsedSyllabusSchema>;
export type ParsedExam = z.infer<typeof parsedExamSchema>;
export type ParsedAssignment = z.infer<typeof parsedAssignmentSchema>;
export type ParseIssue = z.infer<typeof parseIssueSchema>;
export type LlmAttempt = z.infer<typeof llmAttemptSchema>;
