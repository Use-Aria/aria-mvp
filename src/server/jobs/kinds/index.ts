import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Job kind registry (master plan §1.3 table, in this exact order). One file per kind.
 */
import type { z } from "zod";
import type { JobHandler } from "@/server/jobs/types";
import { conversationTurn } from "@/server/jobs/kinds/conversation-turn"; // 3.1
import { proactiveFlush } from "@/server/jobs/kinds/proactive-flush"; // 2.1
import { retentionPurge } from "@/server/jobs/kinds/retention-purge"; // 1.1
import { noop } from "@/server/jobs/kinds/noop"; // 1.1
import { memoryExtract } from "@/server/jobs/kinds/memory-extract"; // 3.3
import { conversationSummary } from "@/server/jobs/kinds/conversation-summary"; // 3.3
import { accountPurge } from "@/server/jobs/kinds/account-purge"; // 3.3
import { canvasSync } from "@/server/jobs/kinds/canvas-sync"; // 3.4
import { reminderFire } from "@/server/jobs/kinds/reminder-fire"; // 2.6
import { briefingPrepare } from "@/server/jobs/kinds/briefing-prepare"; // 4.1
import { briefingSend } from "@/server/jobs/kinds/briefing-send"; // 4.1
import { timelineChanges } from "@/server/jobs/kinds/timeline-changes"; // 4.1
import { googlePostConnect } from "@/server/jobs/kinds/google-post-connect"; // 3.6
import { gcalSync } from "@/server/jobs/kinds/gcal-sync"; // 3.6
import { gcalWatchRenew } from "@/server/jobs/kinds/gcal-watch-renew"; // 3.6
import { gmailWatchRenew } from "@/server/jobs/kinds/gmail-watch-renew"; // 2.5
import { gmailHistorySync } from "@/server/jobs/kinds/gmail-history-sync"; // 2.5
import { gmailTriageChunk } from "@/server/jobs/kinds/gmail-triage-chunk"; // 4.3
import { syllabusParse } from "@/server/jobs/kinds/syllabus-parse"; // 3.5

/** kind name → handler, in registry order. */
export const JOB_KINDS = {
  conversation_turn: conversationTurn,
  proactive_flush: proactiveFlush,
  retention_purge: retentionPurge,
  noop,
  memory_extract: memoryExtract,
  conversation_summary: conversationSummary,
  account_purge: accountPurge,
  canvas_sync: canvasSync,
  reminder_fire: reminderFire,
  briefing_prepare: briefingPrepare,
  briefing_send: briefingSend,
  timeline_changes: timelineChanges,
  google_post_connect: googlePostConnect,
  gcal_sync: gcalSync,
  gcal_watch_renew: gcalWatchRenew,
  gmail_watch_renew: gmailWatchRenew,
  gmail_history_sync: gmailHistorySync,
  gmail_triage_chunk: gmailTriageChunk,
  syllabus_parse: syllabusParse,
} satisfies Record<string, JobHandler<z.ZodType>>;

export type JobKind = keyof typeof JOB_KINDS;
/** Payload accepted by `enqueueJob` for a kind (zod input: defaults may be omitted). */
export type JobPayload<K extends JobKind> = z.input<(typeof JOB_KINDS)[K]["payload"]>;

/** Every registered kind, in registry order. */
export const REGISTERED_KINDS: readonly JobKind[] = Object.keys(JOB_KINDS) as JobKind[];

/**
 * Narrow an arbitrary string (e.g. `jobs.kind` from the DB) to a registered kind.
 * @param kind candidate kind name
 * @returns true if a handler is registered for it
 */
export function isJobKind(kind: string): kind is JobKind {
  return Object.hasOwn(JOB_KINDS, kind);
}
