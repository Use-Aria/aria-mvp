import "server-only";
/**
 * /email/[id] data access (web plan §7.7; master plan §1.5, §1.17). OWNER: 4.5.
 *
 * Reads a `send_email` pending action through the one pending-action path (`getPendingAction`,
 * owner-scoped) and returns a view model: plain strings, labels preformatted in the user's zone,
 * never the raw row. Everything in the draft is untrusted (the model wrote it from third-party
 * email), so recipients and the subject go through `cleanText`; React escapes all of it and the
 * page never parses it as HTML. The body textarea keeps the raw text.
 */
import { z } from "zod";
import { getPendingAction } from "@/server/agent/pending/actions";
import type { PendingActionView } from "@/server/agent/pending/types";
import { isRecent } from "@/server/web/guard";
import type { Viewer } from "@/server/viewer";
import { SendEmailPayload } from "@/shared/email-draft";
import { cleanText, gmailPermalink } from "@/shared/safe-url";

/** What the page shows. `sending` = the confirm is running (or stuck awaiting recovery). */
export type DraftStatus = "pending" | "sending" | "sent" | "cancelled" | "expired" | "failed";

/** The draft as /email/[id] renders it. */
export interface DraftView {
  id: string;
  /** Version the editor saw; Save and Send post it back (compare-and-set). */
  version: number;
  status: DraftStatus;
  from: string;
  to: string[];
  cc: string[];
  /** Cleaned (no bidi/zero-width/control characters), ≤ 250 characters. */
  subject: string;
  /** Raw body text, line endings normalized to LF (textarea / `pre-wrap`; never HTML). */
  body: string;
  /** e.g. "Sat 3:10 PM" in the user's zone. */
  expiresAtLabel: string;
  /** When the user (or expiry) decided, e.g. "Sat 3:12 PM"; null while pending. */
  decidedAtLabel: string | null;
  /** When the email went out (executor result `sent_at`, else the decision time); null unless sent. */
  sentAtLabel: string | null;
  /** Gmail search link for the email being replied to, when known. */
  originalPermalink: string | null;
  /** The session is < 60 min old, so Save and Send are allowed (web plan §2.3 `recent`). */
  canSend: boolean;
}

/** Max subject length (the payload schema's limit). */
export const SUBJECT_MAX = 250;
/** Max body length (the payload schema's limit). */
export const BODY_MAX = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a route param is a UUID (checked before any query; anything else is a 404).
 * @param id raw `[id]` segment
 * @returns true for a canonical UUID
 */
export function isDraftId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * Short weekday + clock in a zone, e.g. "Sat 3:10 PM".
 * @param date instant
 * @param timeZone IANA zone
 * @returns label
 */
export function formatDraftTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function statusOf(v: PendingActionView): DraftStatus {
  switch (v.status) {
    case "pending":
      return "pending";
    case "executing":
      return "sending";
    case "done":
      return "sent";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      return "failed";
  }
}

function sentAt(v: PendingActionView): Date | null {
  const raw = v.result?.sent_at ?? v.result?.sentAt;
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return v.decidedAt;
}

/**
 * Pending-action view → draft view model. Pure.
 * @param v owner-scoped pending action
 * @param opts the viewer's zone and whether the session is recent
 * @returns the draft, or null when it isn't a `send_email` action or its payload doesn't parse
 */
export function toDraftView(v: PendingActionView, opts: { timezone: string; recent: boolean }): DraftView | null {
  if (v.kind !== "send_email") return null;
  const parsed = SendEmailPayload.safeParse(v.payload);
  if (!parsed.success) return null;
  const p = parsed.data;
  const status = statusOf(v);
  const sent = status === "sent" ? sentAt(v) : null;
  const rfc822 = p.original_rfc822_id?.trim();
  return {
    id: v.id,
    version: v.version,
    status,
    from: cleanText(p.from, 320),
    to: p.to.map((a) => cleanText(a, 320)),
    cc: p.cc.map((a) => cleanText(a, 320)),
    subject: cleanText(p.subject, SUBJECT_MAX),
    body: p.body_text.replace(/\r\n?/g, "\n"),
    expiresAtLabel: formatDraftTime(v.expiresAt, opts.timezone),
    decidedAtLabel: v.decidedAt ? formatDraftTime(v.decidedAt, opts.timezone) : null,
    sentAtLabel: sent ? formatDraftTime(sent, opts.timezone) : null,
    originalPermalink: rfc822 ? gmailPermalink(rfc822) : null,
    canSend: opts.recent,
  };
}

/**
 * Loads one draft for the signed-in viewer (owner-scoped; never reveals another user's action).
 * @param viewer the signed-in viewer
 * @param id `pending_actions.id` from the URL
 * @param now clock (tests)
 * @returns the draft, or null (bad id, not found, not the viewer's, not an email draft) → 404
 */
export async function getDraftView(viewer: Viewer, id: string, now: Date = new Date()): Promise<DraftView | null> {
  if (!isDraftId(id)) return null;
  const action = await getPendingAction(viewer.userId, id);
  if (!action) return null;
  const view = toDraftView(action, { timezone: viewer.timezone, recent: isRecent(viewer.session, now.getTime()) });
  if (!view) console.warn("[email] draft not renderable", action.kind);
  return view;
}

// ── form parsing (pure; used by `(app)/email/[id]/actions.ts`) ───────────────

const VERSION = z.coerce.number().int().min(1).max(1_000_000);

const EditForm = z.object({
  id: z.string().regex(UUID_RE),
  version: VERSION,
  subject: z
    .string()
    .max(SUBJECT_MAX)
    .refine((s) => !/[\r\n]/.test(s), "subject has a line break"),
  body: z.string().max(BODY_MAX),
});

const RefForm = z.object({ id: z.string().regex(UUID_RE), version: VERSION });

function field(form: FormData, name: string): unknown {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
}

/**
 * Parses the Save form. Only `subject` and `body` are read: recipients are never accepted from
 * the web (master plan §1.17), whatever else the form carries.
 * @param form posted form data
 * @returns the edit (subject cleaned, body with CRLF normalized to LF), or null when invalid
 */
export function parseDraftEdit(form: FormData): { id: string; version: number; subject: string; body: string } | null {
  const r = EditForm.safeParse({
    id: field(form, "id"),
    version: field(form, "version"),
    subject: field(form, "subject"),
    body: field(form, "body"),
  });
  if (!r.success) return null;
  return {
    id: r.data.id,
    version: r.data.version,
    subject: cleanText(r.data.subject, SUBJECT_MAX),
    body: r.data.body.replace(/\r\n?/g, "\n"),
  };
}

/**
 * Parses the Send / Cancel forms.
 * @param form posted form data
 * @returns id + version, or null when invalid
 */
export function parseDraftRef(form: FormData): { id: string; version: number } | null {
  const r = RefForm.safeParse({ id: field(form, "id"), version: field(form, "version") });
  return r.success ? r.data : null;
}
