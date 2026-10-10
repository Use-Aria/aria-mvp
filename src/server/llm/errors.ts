import "server-only";
// OWNER: 1.3

/**
 * Typed LLM failures (master plan §1.6). Callers branch on these, never on SDK classes.
 * Messages carry status codes only — never prompt or response text.
 */

/** Provider unavailable (429, 408/409, 5xx/529, timeout, connection). Retry with backoff. */
export class LlmUnavailableError extends Error {
  readonly retryable = true;
  /** HTTP status when there was one. */
  status?: number;

  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmUnavailableError";
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** The request itself is wrong (400/401/403/404/413/422), or a structured output didn't validate. Don't retry as-is. */
export class LlmBadRequestError extends Error {
  /** HTTP status when there was one. */
  status?: number;

  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmBadRequestError";
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** The model refused (`stop_reason: "refusal"`). Thrown by `runStructured` only; `callModel` returns refusals. */
export class LlmRefusalError extends Error {
  /** `stop_details.category` (e.g. "cyber", "general_harms") or null. */
  category: string | null;

  constructor(category: string | null) {
    super(`model refused${category ? ` (${category})` : ""}`);
    this.name = "LlmRefusalError";
    this.category = category;
  }
}
