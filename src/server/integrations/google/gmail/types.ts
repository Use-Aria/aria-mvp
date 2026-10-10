import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Gmail cross-task types (master plan §1.12; V2-07 §7.3 verbatim): `EmailMeta`, `Address`,
 * `PrefilterHint`, `ClassifiedEmail`, `BriefingEmailItem`, `TriagePayload` (+ its zod schema,
 * V2-07 §9.1, used by the `gmail_triage_chunk` job kind).
 */
import { z } from "zod";

export interface Address {
  name: string | null;
  email: string;
}
export interface EmailMeta {
  id: string;
  threadId: string;
  labels: string[];
  snippet: string;
  internalDate: Date;
  from: Address | null;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  messageId: string | null;
  references: string | null;
  listUnsubscribe: boolean;
  autoSubmitted: string | null;
  precedence: string | null;
}
export type PrefilterHint = "canvas" | "gradescope" | "recruiter" | "school" | "keyword" | "personal";
/** Classifier `kind` (V2-07 §2.10 `EmailClassification.kind`). */
export type EmailKind = "deadline_change" | "interview" | "action_needed" | "fyi";
export interface ClassifiedEmail {
  id: string;
  importance: "high" | "medium" | "low";
  kind: EmailKind;
  course: string | null;
  oldDue: Date | null;
  newDue: Date | null;
  confidence: number;
  summary: string;
}
export interface BriefingEmailItem {
  id: string;
  from: string;
  subject: string;
  kind: string | null;
  importance: "high" | "medium";
  course: string | null;
  newDue: Date | null;
  summaryUntrusted: string;
  permalink: string | null;
}

/** Gmail message id (hex). */
const GmailIdSchema = z.string().regex(/^[0-9a-f]{8,32}$/);

/** `gmail_triage_chunk` payload: one phase step of inbox triage (V2-07 §2.11 / §9.1). */
export const TriagePayloadSchema = z.discriminatedUnion("phase", [
  z.object({ runId: z.string().min(1), phase: z.literal("list") }),
  z.object({
    runId: z.string().min(1),
    phase: z.literal("meta"),
    ids: z.array(GmailIdSchema).max(100),
    offset: z.number().int().min(0),
  }),
  z.object({ runId: z.string().min(1), phase: z.literal("classify"), offset: z.number().int().min(0) }),
  z.object({ runId: z.string().min(1), phase: z.literal("digest") }),
]);
export type TriagePayload =
  | { runId: string; phase: "list" }
  | { runId: string; phase: "meta"; ids: string[]; offset: number }
  | { runId: string; phase: "classify"; offset: number }
  | { runId: string; phase: "digest" };

// Compile-time guard: the schema's output stays identical to `TriagePayload`.
const _triageCompat: (p: z.output<typeof TriagePayloadSchema>) => TriagePayload = (p) => p;
void _triageCompat;
