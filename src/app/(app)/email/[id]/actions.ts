"use server";
// OWNER: 4.5

/**
 * /email/[id] server actions (web plan §7.7; master plan §1.5). All go through the one
 * pending-action path, owner-scoped by the session's user:
 * - Save → `revisePendingAction(…, "web")` with ONLY `subject` + `body_text` (recipients are
 *   read-only on the web; the pending module throws `PendingActionError` for anything else).
 * - Send → `confirmPendingAction({via: "web", expectedVersion})`, which also posts
 *   "<summary> ✅" into the chat itself.
 * - Cancel → `cancelPendingAction(…, "web")`.
 * Save and Send need a recent (< 60 min) session; Cancel any session (web plan §2.3).
 * Every action re-checks Origin + session inside (`requireActionViewer`), never throws for an
 * expected failure, and returns a small `ActionResult`. Email content is never logged.
 */
import { refresh } from "next/cache";
import {
  PendingActionError,
  cancelPendingAction,
  confirmPendingAction,
  revisePendingAction,
} from "@/server/agent/pending/actions";
import { rateLimit } from "@/server/ratelimit";
import { formatDraftTime, isDraftId, parseDraftEdit, parseDraftRef } from "@/server/web/email-data";
import { requireActionViewer } from "@/server/web/guard";
import { actionFail, actionOk, type ActionResult } from "@/shared/action-result";

/** Send attempts per user per 10 minutes (web plan §2.6). */
const SEND_LIMIT = 5;
const SEND_WINDOW_SEC = 600;

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

/**
 * Save subject/body edits under the version guard.
 * @param _prev previous result (`useActionState`)
 * @param form `id`, `version`, `subject`, `body` (any other field is ignored)
 * @returns the new version, or why not (`version_conflict` also refreshes the page to the latest draft)
 */
export async function saveDraftAction(
  _prev: ActionResult<{ version: number }> | null,
  form: FormData,
): Promise<ActionResult<{ version: number }>> {
  const guard = await requireActionViewer("recent");
  if (!guard.ok) return actionFail(guard.code);
  const edit = parseDraftEdit(form);
  if (!edit) return actionFail("invalid");
  try {
    const r = await revisePendingAction(
      guard.viewer.userId,
      edit.id,
      edit.version,
      { subject: edit.subject, body_text: edit.body },
      "web",
    );
    if (!r.ok) {
      if (r.code !== "not_found") refresh();
      return actionFail(r.code);
    }
    refresh();
    return actionOk({ version: r.version });
  } catch (e) {
    if (e instanceof PendingActionError) return actionFail("invalid");
    console.error(`[email] save failed: ${errName(e)}`);
    return actionFail("server");
  }
}

/**
 * Send the draft the user reviewed (exactly the version on screen).
 * @param _prev previous result (`useActionState`)
 * @param form `id`, `version`
 * @returns the send time label, or why not (`version_conflict` / `expired` / `not_pending`
 *   refresh the page so the latest state shows; `google_disconnected` → the page offers Setup;
 *   `send_unconfirmed` (Gmail didn't confirm it) keeps the editor on screen, locked, with its warning
 *   — a refresh would swap it for the generic "sending" banner)
 */
export async function sendDraftAction(
  _prev: ActionResult<{ sentAtLabel: string }> | null,
  form: FormData,
): Promise<ActionResult<{ sentAtLabel: string }>> {
  const guard = await requireActionViewer("recent");
  if (!guard.ok) return actionFail(guard.code);
  const ref = parseDraftRef(form);
  if (!ref) return actionFail("invalid");
  const { userId, timezone } = guard.viewer;
  try {
    if (!(await rateLimit(`email_send:${userId}`, SEND_LIMIT, SEND_WINDOW_SEC))) return actionFail("rate_limited");
    const r = await confirmPendingAction(userId, ref.id, { via: "web", expectedVersion: ref.version });
    if (!r.ok) {
      if (r.code !== "not_found" && r.code !== "send_unconfirmed") refresh();
      return actionFail(r.code);
    }
    refresh();
    return actionOk({ sentAtLabel: formatDraftTime(new Date(), timezone) });
  } catch (e) {
    console.error(`[email] send failed: ${errName(e)}`);
    return actionFail("server");
  }
}

/**
 * Cancel the draft (any session; cancelling is the safe direction).
 * @param _prev previous result (`useActionState`)
 * @param form `id`
 * @returns ok, or why not
 */
export async function cancelDraftAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const guard = await requireActionViewer("any");
  if (!guard.ok) return actionFail(guard.code);
  const id = form.get("id");
  if (!isDraftId(id)) return actionFail("invalid");
  try {
    const r = await cancelPendingAction(guard.viewer.userId, id, "web");
    if (!r.ok) {
      if (r.code !== "not_found") refresh();
      return actionFail(r.code);
    }
    refresh();
    return actionOk();
  } catch (e) {
    console.error(`[email] cancel failed: ${errName(e)}`);
    return actionFail("server");
  }
}
