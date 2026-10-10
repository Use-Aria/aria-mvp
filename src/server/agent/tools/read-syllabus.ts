import "server-only";
// OWNER: 3.5

/**
 * Agent tool `read_syllabus` (master plan §1.4 #19; input per V2-08 §9: attachment = m_ alias +
 * index; + evidence). Mutating: the evidence must be the user's own message in this run's batch.
 *
 * Resolves the attachment alias (only aliases shown in this run resolve), checks the message is
 * the user's own inbound message with that attachment, applies the replace guard for a hinted
 * course that already has a syllabus (`{status: "exists"}` → the agent asks before replacing),
 * then enqueues `syllabus_parse` and returns at once. The rate limit is applied by the job when
 * the parser is actually called (cached/duplicate files don't count).
 * Output carries only normalized course keys (constrained alphabet), never syllabus text.
 */
import { z } from "zod";
import { db } from "@/server/db";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { displayCourseKey } from "@/server/integrations/syllabus/confirm";
import { findSyllabusByCourse } from "@/server/integrations/syllabus/store";
import { enqueueJob } from "@/server/jobs/enqueue";
import { syllabusJobKey } from "@/server/jobs/kinds/syllabus-parse";
import { formatForTool } from "@/shared/time/tz";

const input = z.strictObject({
  attachment: z
    .string()
    .regex(/^m_[0-9a-f]{8,10}:\d$/)
    .describe("attachment id from the transcript, e.g. m_1a2b3c4d:0"),
  /** from the user's words, e.g. "orgo" */
  courseHint: z.string().trim().min(1).max(80).optional(),
  /** only after the user confirmed replacing */
  replace: z.boolean().default(false),
  evidence: EV,
});

const MediaListSchema = z.array(
  z.looseObject({ url: z.string().min(1), kind: z.string().optional(), contentType: z.string().optional() }),
);

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns `{status: "queued"}`, `{status: "exists", course, parsed_at}`, or a model-readable error
 */
export async function runReadSyllabus(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const resolved = ctx.aliases.resolve(i.attachment, "m");
  const m = resolved ? /^([0-9a-f-]{36}):(\d)$/.exec(resolved) : null;
  if (!m) return { ok: false, error: `unknown attachment ${i.attachment}: use an attachment id shown in <new_messages>` };
  const [, messageId, idx] = m;
  const mediaIndex = Number(idx);

  try {
    const msg = await db()
      .from("messages")
      .select("id, user_id, direction, media")
      .eq("id", messageId)
      .maybeSingle();
    if (msg.error) throw new Error(msg.error.code ?? "db_error");
    if (!msg.data || msg.data.user_id !== ctx.userId || msg.data.direction !== "in") {
      return { ok: false, error: "that attachment isn't from the student's own messages" };
    }
    const media = MediaListSchema.safeParse(msg.data.media ?? []);
    const item = media.success ? media.data[mediaIndex] : undefined;
    if (!item) return { ok: false, error: `no attachment ${i.attachment}` };
    const kind = item.kind ?? "other";
    if (kind !== "pdf" && kind !== "other" && !(item.contentType ?? "").includes("pdf")) {
      return { ok: false, error: `that attachment is ${kind === "image" ? "an image" : `a ${kind} file`}, not a PDF: ask them to send the syllabus as a PDF` };
    }

    if (i.courseHint && !i.replace) {
      const existing = await findSyllabusByCourse(ctx.userId, i.courseHint);
      if (existing) {
        return {
          ok: true,
          data: {
            status: "exists",
            course: displayCourseKey(existing.course_key),
            parsed_at: formatForTool(new Date(existing.parsed_at), ctx.timezone),
            next: "ask whether to replace the saved one; if they say yes, call read_syllabus again with replace=true",
          },
        };
      }
    }

    await enqueueJob({
      kind: "syllabus_parse",
      userId: ctx.userId,
      payload: {
        messageId,
        mediaIndex,
        ...(i.courseHint ? { courseHint: i.courseHint } : {}),
        replace: i.replace,
      },
      dedupeKey: syllabusJobKey(messageId, mediaIndex),
      mode: "keep",
    });
    return {
      ok: true,
      data: {
        status: "queued",
        next: "tell them you're reading it now; the result arrives as its own message in a minute or two",
      },
    };
  } catch (e) {
    ctx.log("read_syllabus_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { ok: false, error: "couldn't start reading that file just now", retryable: true };
  }
}

/** `read_syllabus` tool. */
export const readSyllabusTool = defineTool({
  name: "read_syllabus",
  description:
    "Read a syllabus PDF the user just sent and save its exams, assignments and grading. Use when the user sends a PDF that is (or might be) a syllabus. Returns immediately; you'll tell them you're reading it.",
  input,
  mutates: true,
  run: runReadSyllabus,
});
