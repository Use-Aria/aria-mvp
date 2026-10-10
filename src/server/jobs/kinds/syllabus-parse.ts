import "server-only";
// OWNER: 3.5

/**
 * Job kind `syllabus_parse` (master plan §1.3; V2-08 §9, §2.12). Enqueued by the `read_syllabus`
 * tool so the conversation turn returns fast:
 *
 *   load the inbound message (owner + direction checked) → SSRF-safe download of
 *   `media[mediaIndex].url` → `runSyllabusIntake` → 1–2 confirmation bubbles via
 *   `deliver(…, {proactive: false, reason: "syllabus_parsed"})` (a direct follow-up to the user's
 *   own request, so quiet hours don't defer it).
 *
 * maxAttempts 2 (the global 330s lock covers the ≤ 280s parse, master plan C11). A retryable
 * failure on attempt 1 retries; on the last attempt the user gets an apology instead. Bubble
 * idempotency keys derive from `syl:<messageId>:<mediaIndex>`, so a retry never double-sends.
 */
import { z } from "zod";
import { deliver, textPlan } from "@/server/channels";
import { db } from "@/server/db";
import { syllabusSettings } from "@/server/integrations/syllabus/config";
import { renderSyllabusConfirmation } from "@/server/integrations/syllabus/confirm";
import { runSyllabusIntake } from "@/server/integrations/syllabus/intake";
import { fetchAttachmentPdf, MediaFetchError } from "@/server/integrations/syllabus/media";
import type { IntakeOutcome } from "@/server/integrations/syllabus/types";
import { defineJobKind, PermanentJobError, type JobContext, type JobOutcome } from "@/server/jobs/types";
import { safeTimeZone } from "@/shared/time/tz";

/** Payload of `syllabus_parse`. Dedupe key: `syllabus:<messageId>:<mediaIndex>`. */
export const syllabusParsePayload = z.object({
  /** inbound message carrying the PDF */
  messageId: z.uuid(),
  mediaIndex: z.number().int().min(0).max(9).default(0),
  courseHint: z.string().trim().min(1).max(80).optional(),
  replace: z.boolean().default(false),
});

/** Dedupe key of one attachment's parse job. */
export function syllabusJobKey(messageId: string, mediaIndex: number): string {
  return `syllabus:${messageId}:${mediaIndex}`;
}

/** Stored `messages.media` entries (read defensively). */
const MediaListSchema = z.array(
  z.looseObject({ url: z.string().min(1), kind: z.string().optional(), filename: z.string().optional() }),
);

/** Time reserved after the parse for the DB writes and the delivery. */
const DELIVERY_RESERVE_MS = 8_000;

/**
 * Handler body (exported for tests and the smoke run).
 * @param ctx job context
 * @param p parsed payload
 * @returns done, retry (transient failure before the last attempt) or dead (bad message)
 */
export async function runSyllabusParseJob(ctx: JobContext, p: z.output<typeof syllabusParsePayload>): Promise<JobOutcome> {
  const userId = ctx.userId;
  if (!userId) throw new PermanentJobError("syllabus_parse: job has no user");

  const msg = await db()
    .from("messages")
    .select("id, user_id, direction, media, provider")
    .eq("id", p.messageId)
    .maybeSingle();
  if (msg.error) throw new Error(`syllabus_parse: message lookup failed (${msg.error.code ?? "db_error"})`);
  if (!msg.data || msg.data.user_id !== userId || msg.data.direction !== "in") return { type: "dead", error: "message_not_found" };
  const media = MediaListSchema.safeParse(msg.data.media ?? []);
  const item = media.success ? media.data[p.mediaIndex] : undefined;
  if (!item) return { type: "dead", error: "attachment_not_found" };

  const settings = syllabusSettings();
  let outcome: IntakeOutcome;
  try {
    const { bytes } = await fetchAttachmentPdf(item.url, {
      maxBytes: settings.maxPdfBytes,
      allowedHosts: settings.mediaAllowedHosts,
      allowLocal: settings.allowLocalMedia,
    });
    outcome = await runSyllabusIntake({
      userId,
      bytes,
      source: msg.data.provider === "dev" ? "dev" : "imessage",
      sourceMessageId: p.messageId,
      ...(item.filename ? { filename: item.filename } : {}),
      ...(p.courseHint ? { courseHint: p.courseHint } : {}),
      replace: p.replace,
      jobId: ctx.jobId,
      deadline: ctx.deadline - DELIVERY_RESERVE_MS,
      signal: ctx.signal,
    });
  } catch (e) {
    if (!(e instanceof MediaFetchError)) throw e;
    console.warn(`[syllabus] attachment download failed: ${e.code}${e.status ? ` ${e.status}` : ""}`);
    outcome = { status: "failed", code: e.code, retryable: e.retryable, ...(e.status !== undefined ? { httpStatus: e.status } : {}) };
  }

  if (outcome.status === "failed" && outcome.retryable && ctx.attempt < ctx.maxAttempts) {
    return { type: "retry", error: `syllabus:${outcome.code}` };
  }

  const user = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
  const bubbles = renderSyllabusConfirmation(outcome, safeTimeZone(user.data?.timezone), ctx.now);
  const sent = await deliver(userId, textPlan(bubbles), {
    proactive: false,
    reason: "syllabus_parsed",
    dedupeKey: `syl:${p.messageId}:${p.mediaIndex}`,
  });
  if (sent.status === "failed") throw new Error(`syllabus_parse: delivery failed (${sent.error.slice(0, 80)})`);
  return { type: "done" };
}

/** `syllabus_parse` handler (maxAttempts 2). */
export const syllabusParse = defineJobKind({
  payload: syllabusParsePayload,
  maxAttempts: 2,
  run: runSyllabusParseJob,
});
