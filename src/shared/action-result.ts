/**
 * Result type for every web server action (web plan §7.3). Pure and client-safe.
 * Actions never throw for expected failures: they return a code, and the form shows
 * the matching copy from `ACTION_ERROR_COPY` in `src/shared/copy.ts`.
 */

/**
 * Canvas connect error codes. Mirrors `CanvasConnectError` in
 * `src/server/integrations/canvas/connect.ts` (V2-05 superset, C22); a compile-time
 * check in `tests/unit/copy.test.ts` keeps the two in sync.
 */
export const CANVAS_CONNECT_ERROR_CODES = [
  "not_a_url",
  "not_ical",
  "course_feed",
  "not_canvas",
  "private_address",
  "feed_not_found",
  "unreachable",
  "timeout",
  "too_large",
  "forbidden",
  "rate_limited",
  "already_connected_elsewhere",
  "not_user_authored",
  "no_url_found",
  "multiple_urls",
  "internal",
] as const;
export type CanvasConnectErrorCode = (typeof CANVAS_CONNECT_ERROR_CODES)[number];

/** Failure codes of `confirmPendingAction` that the web Send button can see (master plan §1.5). */
export const SEND_ERROR_CODES = [
  "not_found",
  "not_pending",
  "expired",
  "version_conflict",
  "same_run",
  "executor_failed",
  "google_disconnected",
] as const;
export type SendErrorCode = (typeof SEND_ERROR_CODES)[number];

/** Codes every action can return, independent of the integration. */
export const BASE_ACTION_ERROR_CODES = [
  "signed_out",
  "needs_recent_link",
  "needs_fresh_link",
  "bad_origin",
  "rate_limited",
  "invalid",
  "not_found",
  "version_conflict",
  "not_pending",
  "expired",
  "unavailable",
  "server",
] as const;

/** Every code an action may return. */
export type ActionErrorCode =
  | (typeof BASE_ACTION_ERROR_CODES)[number]
  | CanvasConnectErrorCode
  | SendErrorCode;

/** Every `ActionErrorCode`, deduplicated (for exhaustive copy tests). */
export const ACTION_ERROR_CODES: readonly ActionErrorCode[] = [
  ...new Set<ActionErrorCode>([
    ...BASE_ACTION_ERROR_CODES,
    ...CANVAS_CONNECT_ERROR_CODES,
    ...SEND_ERROR_CODES,
  ]),
];

/** What a server action returns. Never a DB row; small, serializable values only. */
export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; code: ActionErrorCode };

/**
 * Success result.
 * @param data payload for the form (omit for `ActionResult<undefined>`)
 * @returns `{ok: true, data}`
 */
export function actionOk(): ActionResult<undefined>;
export function actionOk<T>(data: T): ActionResult<T>;
export function actionOk<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

/**
 * Failure result.
 * @param code why the action did nothing
 * @returns `{ok: false, code}`
 */
export function actionFail(code: ActionErrorCode): { ok: false; code: ActionErrorCode } {
  return { ok: false, code };
}

/**
 * Whether an error caught by an error boundary is deploy skew: a tab opened before a deploy
 * called a server action id that no longer exists ("Failed to find Server Action").
 * @param message `error.message`
 * @returns true when the page should offer "Aria just updated. Reload."
 */
export function isSkewError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /failed-to-find-server-action|failed to find server action|was not found on the server/i.test(
    message,
  );
}
