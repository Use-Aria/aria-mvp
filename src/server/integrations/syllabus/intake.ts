import "server-only";
// OWNER: 3.5

/**
 * Syllabus intake orchestrator shared by the `syllabus_parse` job and the upload route
 * (V2-08 §7.2 `intake.ts`, §2.6, §2.12):
 *
 *   magic check → hash guard → hint guard → daily rate limit → build request (user tz, local
 *   today, Canvas term hint, known courses) → parser → `llm_calls` per attempt → `syllabi` upsert
 *   → timeline upsert + prune (via `@/server/timeline`) → outcome.
 *
 * - The rate limit counts only real parser calls (hash/hint hits are free). It is shared by the
 *   chat and upload paths (`syllabus:<userId>`, `SYLLABUS_DAILY_LIMIT` per 24 h).
 * - Hash hit from the same inbound message (a job retry after the write succeeded) re-writes the
 *   timeline (idempotent) and re-renders the success outcome instead of "already have that one".
 * - The PDF bytes live only in memory; nothing here logs syllabus text, filenames or bodies.
 */
import { db } from "@/server/db";
import { costFor, isModelId, recordLlmCall } from "@/server/llm";
import { rateLimit } from "@/server/ratelimit";
import { listCourses, pruneTimelineItems, termHintForCourse, upsertTimelineItems } from "@/server/timeline";
import { parseSyllabusCall, ParserError, type ParserCallOptions } from "@/server/integrations/syllabus/client";
import { syllabusSettings } from "@/server/integrations/syllabus/config";
import type { ParseIssue, ParseSyllabusRequest, ParseSyllabusResponse, ParsedSyllabus } from "@/server/integrations/syllabus/contract";
import { looksLikePdf, sha256Hex } from "@/server/integrations/syllabus/pdf";
import { readParsedJson } from "@/server/integrations/syllabus/signals";
import { findSyllabusByCourse, findSyllabusByHash, loadSyllabi, upsertSyllabus } from "@/server/integrations/syllabus/store";
import { examTiming, syllabusIdPrefix, syllabusItemIds, toTimelineItems } from "@/server/integrations/syllabus/timeline-map";
import type { IntakeInput, IntakeOutcome, NextExam, SyllabusRow } from "@/server/integrations/syllabus/types";
import { courseKey } from "@/shared/course-key";
import { formatLocalDate, localDateOf, safeTimeZone } from "@/shared/time/tz";

const DAY_SEC = 86_400;
const MAX_KNOWN_COURSES = 12;
/** Minimum span of Canvas items before it is sent as the term window. */
const MIN_TERM_HINT_DAYS = 42;

/** Test seams for {@link runSyllabusIntake}. */
export interface IntakeOptions {
  /** parser transport (default global fetch) */
  fetchImpl?: ParserCallOptions["fetchImpl"];
  /** clock (default now) */
  now?: () => Date;
}

/**
 * Model id to price an attempt with: exact ids, or a dated fallback id (`<id>-YYYYMMDD`).
 * `fake-llm` and unknown ids price at 0.
 * @param model attempt model as reported by the parser
 * @returns a priced model id, or null
 */
export function pricedModel(model: string): string | null {
  if (isModelId(model)) return model;
  const base = model.replace(/-\d{8}$/, "");
  return isModelId(base) ? base : null;
}

/**
 * `llm_calls` rows for one parser response (one per attempt), best-effort.
 * Reported `input_tokens` already include the parser's system prompt + structured-output schema
 * overhead (~5k tokens), so the API usage is priced as-is.
 */
async function recordAttempts(res: ParseSyllabusResponse, input: IntakeInput, parserRequestId: string): Promise<void> {
  await Promise.all(
    res.attempts.map((a, i) => {
      const priced = pricedModel(a.model);
      const counts = {
        inputTokens: a.input_tokens,
        outputTokens: a.output_tokens,
        cacheReadTokens: a.cache_read,
        cacheWriteTokens: a.cache_write,
      };
      return recordLlmCall({
        route: "syllabus",
        model: a.model,
        provider: a.model === "fake-llm" ? "fake" : "anthropic",
        usage: { ...counts, thinkingTokens: 0, costUsd: priced ? costFor(priced, counts) : 0 },
        latencyMs: a.latency_ms,
        stopReason: a.stop_reason,
        ...(a.outcome === "ok" ? {} : { error: a.outcome }),
        userId: input.userId,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        iteration: i,
        meta: {
          attempt: i,
          outcome: a.outcome,
          chosen: res.chosen_attempt === i,
          parser_request_id: parserRequestId,
          parser_version: res.parser_version,
          prompt_version: res.prompt_version,
          sent_pages: res.sent_pages,
          ...(priced ? {} : { unpriced: true }),
        },
      });
    }),
  );
}

/**
 * Soonest dated exam that isn't over yet. Pure.
 * @param parsed normalized syllabus
 * @param now clock
 * @returns the exam, or null
 */
export function nextExamOf(parsed: ParsedSyllabus, now: Date): NextExam | null {
  const tz = safeTimeZone(parsed.timezone);
  let best: { exam: NextExam; at: number } | null = null;
  for (const e of parsed.exams) {
    const t = examTiming(e, tz);
    if (!t || !e.date || t.end.getTime() < now.getTime()) continue;
    const at = (t.startsAt ?? t.end).getTime();
    if (!best || at < best.at) {
      best = { exam: { title: e.title, startsAt: t.allDay ? null : e.starts_at_utc, date: e.date, allDay: t.allDay }, at };
    }
  }
  return best?.exam ?? null;
}

function safeFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return clean || null;
}

function resolveCourseKey(parsed: ParsedSyllabus, sha: string): string {
  return (
    courseKey(parsed.course.key) ??
    courseKey(parsed.course.code) ??
    courseKey(parsed.course.title) ??
    `t:syllabus-${sha.slice(0, 8)}`
  );
}

/** Upsert the dated, upcoming items and prune this course's items that are no longer in the syllabus. */
async function writeTimeline(userId: string, row: SyllabusRow, parsed: ParsedSyllabus, now: Date): Promise<number> {
  const items = toTimelineItems({ courseKey: row.course_key, courseLabel: row.course_name, syllabusId: row.id, parsed, now });
  if (items.length > 0) await upsertTimelineItems(userId, items);
  await pruneTimelineItems({
    userId,
    source: "syllabus",
    externalIdPrefix: syllabusIdPrefix(row.course_key),
    keep: syllabusItemIds(row.course_key, parsed),
  });
  return items.length;
}

function successOutcome(
  row: SyllabusRow,
  parsed: ParsedSyllabus,
  o: {
    status: "ok" | "needs_review";
    replaced: boolean;
    previousParsedAt: string | null;
    itemCount: number;
    issues: ParseIssue[];
    pageCount?: number;
    truncatedPages?: boolean;
    redelivered?: boolean;
    now: Date;
  },
): IntakeOutcome {
  return {
    status: o.status,
    syllabusId: row.id,
    courseKey: row.course_key,
    courseLabel: row.course_name,
    replaced: o.replaced,
    previousParsedAt: o.previousParsedAt,
    examCount: parsed.exams.length,
    assignmentCount: parsed.assignments.length,
    itemCount: o.itemCount,
    issues: o.issues,
    courseMismatch: o.issues.some((i) => i.code === "course_mismatch"),
    nextExam: nextExamOf(parsed, o.now),
    gradingTotalPct: parsed.grading_total_pct,
    ...(o.pageCount !== undefined ? { pageCount: o.pageCount } : {}),
    ...(o.truncatedPages !== undefined ? { truncatedPages: o.truncatedPages } : {}),
    ...(o.redelivered ? { redelivered: true } : {}),
  };
}

async function buildRequest(input: IntakeInput, now: Date): Promise<ParseSyllabusRequest> {
  const user = await db().from("users").select("timezone").eq("id", input.userId).maybeSingle();
  if (user.error) throw new Error(`syllabus.intake(user): ${user.error.code ?? "db_error"}`);
  const tz = safeTimeZone(user.data?.timezone);
  const hint = input.courseHint?.trim().slice(0, 80) || null;

  let term: ParseSyllabusRequest["term"] = null;
  if (hint) {
    const t = await termHintForCourse(input.userId, hint);
    // Canvas min/max anchors only describe the term once they span most of it; a narrow window
    // (early in the term, one quiz) would flag every exam `exam_out_of_term`.
    if (t && t.end.getTime() - t.start.getTime() >= MIN_TERM_HINT_DAYS * 86_400_000) {
      term = { name: null, start: formatLocalDate(localDateOf(t.start, tz)), end: formatLocalDate(localDateOf(t.end, tz)) };
    }
  }

  const known = new Map<string, string>();
  for (const r of await loadSyllabi(input.userId)) known.set(r.course_key, r.course_name.slice(0, 160));
  for (const c of await listCourses(input.userId, now)) {
    const k = courseKey(c);
    if (k && !known.has(k)) known.set(k, c.slice(0, 160));
  }
  return {
    pdf_base64: input.bytes.toString("base64"),
    filename: safeFilename(input.filename),
    course_hint: hint,
    timezone: tz,
    today: formatLocalDate(localDateOf(now, tz)),
    term,
    known_courses: [...known]
      .slice(0, MAX_KNOWN_COURSES)
      .map(([key, label]) => ({ key: key.slice(0, 64), label })),
    allow_escalation: true,
  };
}

/**
 * Rate limit → hash guard → hint guard → parser → store → timeline upsert + prune → outcome.
 * DB failures throw (the job retries; the route answers 500); parser and policy failures are
 * returned as outcomes.
 * @param input PDF bytes and context
 * @param opts test seams (parser fetch, clock)
 * @returns intake outcome
 */
export async function runSyllabusIntake(input: IntakeInput, opts: IntakeOptions = {}): Promise<IntakeOutcome> {
  const now = opts.now?.() ?? new Date();
  if (!looksLikePdf(input.bytes)) return { status: "failed", code: "not_pdf", retryable: false };
  const sha = sha256Hex(input.bytes);

  const same = await findSyllabusByHash(input.userId, sha);
  if (same) {
    const parsed = readParsedJson(same.parsed_json);
    if (parsed && input.sourceMessageId && same.source_message_id === input.sourceMessageId) {
      const itemCount = await writeTimeline(input.userId, same, parsed, now);
      const issues = Array.isArray(same.issues) ? (same.issues as unknown as ParseIssue[]) : [];
      return successOutcome(same, parsed, {
        status: same.status === "needs_review" ? "needs_review" : "ok",
        replaced: false,
        previousParsedAt: null,
        itemCount,
        issues,
        redelivered: true,
        now,
      });
    }
    return { status: "exists", courseKey: same.course_key, courseLabel: same.course_name, parsedAt: same.parsed_at, reason: "same_file" };
  }

  const hint = input.courseHint?.trim();
  if (hint && !input.replace) {
    const existing = await findSyllabusByCourse(input.userId, hint);
    if (existing) {
      return {
        status: "exists",
        courseKey: existing.course_key,
        courseLabel: existing.course_name,
        parsedAt: existing.parsed_at,
        reason: "same_course",
      };
    }
  }

  const settings = syllabusSettings();
  if (!(await rateLimit(`syllabus:${input.userId}`, settings.dailyLimit, DAY_SEC))) return { status: "rate_limited" };

  const req = await buildRequest(input, now);
  let res: ParseSyllabusResponse;
  let requestId: string;
  try {
    const r = await parseSyllabusCall(req, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    res = r.response;
    requestId = r.requestId;
  } catch (e) {
    if (e instanceof ParserError) {
      return { status: "failed", code: e.code, retryable: e.retryable, ...(e.status !== null ? { httpStatus: e.status } : {}) };
    }
    throw e;
  }

  await recordAttempts(res, input, requestId);

  if (res.pdf_sha256 && res.pdf_sha256 !== sha) {
    console.warn("[syllabus] parser pdf_sha256 mismatch; result discarded");
    return { status: "failed", code: "sha_mismatch", retryable: false };
  }
  if (res.status === "not_syllabus") return { status: "not_syllabus", documentKind: res.document_kind };
  if (res.status === "unreadable" || !res.syllabus) return { status: "unreadable" };

  const parsed = res.syllabus;
  const key = resolveCourseKey(parsed, sha);
  const stored = await upsertSyllabus(input.userId, res, {
    source: input.source,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    sha256: sha,
    courseKey: key,
  });
  const itemCount = await writeTimeline(input.userId, stored.row, parsed, now);
  return successOutcome(stored.row, parsed, {
    status: res.status,
    replaced: stored.replaced,
    previousParsedAt: stored.previousParsedAt,
    itemCount,
    issues: res.issues,
    pageCount: res.page_count,
    truncatedPages: res.truncated_pages,
    now,
  });
}
