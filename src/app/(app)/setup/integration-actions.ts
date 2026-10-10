"use server";
// OWNER: 4.5

/**
 * /setup integration server actions (web plan §7.4 Canvas/Google, §2.3; master plan §1.11, §1.12).
 * Connecting or removing an account needs a fresh setup session (`fresh_setup`, < 15 min).
 * Every action re-checks Origin + session inside (`requireActionViewer`) and returns a small
 * `ActionResult`, never a row.
 *
 * - Canvas connect calls `connectCanvas({…, via: "web"})`, which already rate-limits (10/h),
 *   test-fetches before saving, sends the chat confirmation, and fills an empty profile school.
 *   This action only maps its result. The feed URL is a bearer secret: it is never logged and
 *   never echoed back (the client keeps its own input).
 * - Google connect is NOT an action: it is a plain `<a href="/api/google/oauth">` (GET, C20).
 * - Google disconnect calls `disconnectGoogle(userId, {reason: "user"})` (no API route).
 */
import { refresh } from "next/cache";
import { z } from "zod";
import { connectCanvas, disconnectCanvas } from "@/server/integrations/canvas";
import { disconnectGoogle } from "@/server/integrations/google";
import { requireActionViewer } from "@/server/web/guard";
import { actionFail, actionOk, type ActionResult } from "@/shared/action-result";

/** What a successful Canvas connect shows. */
export type CanvasConnected = { host: string; itemCount: number; upcomingCount: number };

const ConnectForm = z.object({
  url: z.string().trim().min(1).max(2048),
  school: z.string().trim().max(120).optional(),
  customHost: z.string().trim().max(253).optional(),
});

function str(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

/**
 * Connect (or replace) the Canvas calendar feed.
 * @param _prev previous result (`useActionState`)
 * @param form `url` (pasted feed link), optional `school` (picker value), optional `customHost`
 * @returns host + counts, or a `CanvasConnectError` / guard code for inline copy
 */
export async function connectCanvasAction(
  _prev: ActionResult<CanvasConnected> | null,
  form: FormData,
): Promise<ActionResult<CanvasConnected>> {
  const guard = await requireActionViewer("fresh_setup");
  if (!guard.ok) return actionFail(guard.code);
  const parsed = ConnectForm.safeParse({ url: str(form, "url"), school: str(form, "school"), customHost: str(form, "customHost") });
  if (!parsed.success) {
    return actionFail(str(form, "url") === undefined ? "no_url_found" : "not_a_url");
  }
  try {
    const r = await connectCanvas({
      userId: guard.viewer.userId,
      rawUrl: parsed.data.url,
      schoolName: parsed.data.school ?? null,
      via: "web",
    });
    if (!r.ok) return actionFail(r.code);
    refresh();
    return actionOk({ host: r.host, itemCount: r.itemCount, upcomingCount: r.upcomingCount });
  } catch (e) {
    console.error(`[setup] canvas connect failed: ${errName(e)}`);
    return actionFail("server");
  }
}

/**
 * Disconnect Canvas (idempotent). Callable directly (`disconnectCanvasAction()`) or from a form
 * with `useActionState`.
 * @param _prev previous result (ignored)
 * @param _form form data (ignored)
 * @returns ok, or a guard code
 */
export async function disconnectCanvasAction(_prev?: unknown, _form?: FormData): Promise<ActionResult> {
  void _prev;
  void _form;
  const guard = await requireActionViewer("fresh_setup");
  if (!guard.ok) return actionFail(guard.code);
  try {
    await disconnectCanvas(guard.viewer.userId);
    refresh();
    return actionOk();
  } catch (e) {
    console.error(`[setup] canvas disconnect failed: ${errName(e)}`);
    return actionFail("server");
  }
}

/**
 * Disconnect Google: revoke at Google, stop watches, delete the integration and what it pulled in.
 * Callable directly (`disconnectGoogleAction()`, e.g. from /settings) or with `useActionState`.
 * @param _prev previous result (ignored)
 * @param _form form data (ignored)
 * @returns `revoked: false` when a grant may remain at Google (point the user at
 *   myaccount.google.com/permissions), or a guard code
 */
export async function disconnectGoogleAction(
  _prev?: unknown,
  _form?: FormData,
): Promise<ActionResult<{ revoked: boolean }>> {
  void _prev;
  void _form;
  const guard = await requireActionViewer("fresh_setup");
  if (!guard.ok) return actionFail(guard.code);
  try {
    const { revoked } = await disconnectGoogle(guard.viewer.userId, { reason: "user" });
    refresh();
    return actionOk({ revoked });
  } catch (e) {
    console.error(`[setup] google disconnect failed: ${errName(e)}`);
    return actionFail("server");
  }
}

/**
 * Form-action variant of {@link disconnectGoogleAction} for the server-rendered Google section's
 * confirm dialog (no client state there). Re-renders /setup either way: on success it shows
 * "Not connected"; when the setup link went stale, the re-render shows the fresh-link notice
 * instead of the button; a signed-out session re-renders as SignedOut.
 * @param _form form data (ignored)
 * @throws on a server failure or a cross-origin post (the error boundary offers a retry)
 */
export async function disconnectGoogleFormAction(_form: FormData): Promise<void> {
  void _form;
  const r = await disconnectGoogleAction();
  if (r.ok) return;
  if (r.code === "needs_fresh_link" || r.code === "signed_out" || r.code === "needs_recent_link") {
    refresh();
    return;
  }
  throw new Error(`google disconnect refused: ${r.code}`);
}
