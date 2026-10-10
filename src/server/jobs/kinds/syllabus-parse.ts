import "server-only";
// OWNER: 3.5

/**
 * Job kind `syllabus_parse` (master plan §1.3). Downloads the PDF, runs `runSyllabusIntake`, delivers the confirmation. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `syllabus_parse`. Dedupe key: `syllabus:<messageId>:<mediaIndex>`. */
export const syllabusParsePayload = z.object({
  /** inbound message carrying the PDF */
  messageId: z.uuid(),
  mediaIndex: z.number().int().min(0).max(9).default(0),
  courseHint: z.string().trim().min(1).max(80).optional(),
  replace: z.boolean().default(false),
});

/** `syllabus_parse` handler (maxAttempts 2). */
export const syllabusParse = defineJobKind({
  payload: syllabusParsePayload,
  maxAttempts: 2,
  run: async () => {
    throw notImplemented("3.5");
  },
});
