import "server-only";
// OWNER: 3.5

/**
 * Parser service client (master plan §1.13; V2-08 §7.2 `client.ts`, §8.1 contract v1).
 *
 * - Every attempt is signed afresh (new timestamp + request id): the parser's replay cache keys on
 *   the signature, so re-sending the same headers would be rejected as `replay`.
 * - At most ONE in-client retry, after 2s, and only for a connection error, a 429, or a FAST 503
 *   (cold start / overload before any model work). A 503 `overloaded` that took > 150s already
 *   burned the parser's deadline (and likely tokens), so it is not retried and is not job-retryable.
 * - Never retries a client timeout or a 504 (the parse may have run; a retry would double the LLM
 *   spend). 502 `upstream_llm` is not retried here but stays job-retryable.
 * - The 200 body is zod-validated against the contract; error bodies map to `ParserError(code)`.
 * - Logs carry codes, statuses and timings only — never request/response bodies.
 */
import { syllabusSettings } from "@/server/integrations/syllabus/config";
import {
  parseSyllabusResponseSchema,
  parserErrorSchema,
  type ParseSyllabusRequest,
  type ParseSyllabusResponse,
} from "@/server/integrations/syllabus/contract";
import { PARSER_HEADERS, parserHeaders } from "@/server/integrations/syllabus/signing";

/** Request path of contract v1. */
export const PARSE_PATH = "/v1/parse-syllabus";
/** Delay before the single in-client retry. */
export const RETRY_DELAY_MS = 2_000;
/** A 503 slower than this is not retried (the parser's deadline was spent). */
export const SLOW_OVERLOAD_MS = 150_000;
/** Minimum budget left to start a retry. */
const MIN_RETRY_BUDGET_MS = 15_000;

/** A parser call failed (`code` from the contract error table, or a transport code). */
export class ParserError extends Error {
  code: string;
  retryable: boolean;
  status: number | null;

  constructor(code: string, o: { retryable: boolean; status: number | null; message?: string }) {
    super(o.message ?? `parser error: ${code}`);
    this.name = "ParserError";
    this.code = code;
    this.retryable = o.retryable;
    this.status = o.status;
  }
}

/** Options for {@link callParseSyllabus} / {@link parseSyllabusCall}. */
export interface ParserCallOptions {
  fetchImpl?: typeof fetch;
  /** clock for signing (default `new Date()`) */
  now?: () => Date;
  /** per-attempt timeout (default `PARSER_TIMEOUT_MS`, 280s) */
  timeoutMs?: number;
  /** epoch ms after which no attempt may run (job deadline); shortens the timeout */
  deadline?: number;
  /** caller abort (job lease loss) */
  signal?: AbortSignal;
  /** test seam for the retry delay */
  sleep?: (ms: number) => Promise<void>;
}

/** A successful call plus transport metadata (for `llm_calls.meta`). */
export interface ParserCallResult {
  response: ParseSyllabusResponse;
  /** `x-aria-request-id` of the attempt that succeeded */
  requestId: string;
  /** HTTP attempts made (1 or 2) */
  httpAttempts: number;
  latencyMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAbortLike(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

async function errorFromResponse(res: Response, elapsedMs: number): Promise<ParserError> {
  let code = `http_${res.status}`;
  let retryable = res.status >= 500 && res.status !== 504;
  try {
    const parsed = parserErrorSchema.safeParse(await res.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      retryable = parsed.data.error.retryable;
    }
  } catch {
    // non-JSON error body (proxy / platform page): keep the status-derived code
  }
  if (res.status === 504) retryable = false;
  if (res.status === 503 && elapsedMs > SLOW_OVERLOAD_MS) retryable = false;
  return new ParserError(code, { retryable, status: res.status });
}

/**
 * Call `POST /v1/parse-syllabus` and return the validated response with transport metadata.
 * @param req contract v1 request
 * @param opts fetch, clock, timeout, deadline, abort signal, sleep
 * @returns response, request id, attempts, latency
 * @throws ParserError on an error response, transport failure, timeout or invalid body
 */
export async function parseSyllabusCall(req: ParseSyllabusRequest, opts: ParserCallOptions = {}): Promise<ParserCallResult> {
  const s = syllabusSettings();
  const secret = process.env.PARSER_SHARED_SECRET ?? "";
  if (!secret || !s.parserUrl) throw new ParserError("not_configured", { retryable: false, status: null });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const body = JSON.stringify(req);
  const url = `${s.parserUrl}${PARSE_PATH}`;
  const started = Date.now();

  for (let attempt = 1; ; attempt += 1) {
    const budget = opts.deadline !== undefined ? opts.deadline - Date.now() : Infinity;
    const timeoutMs = Math.min(opts.timeoutMs ?? s.parserTimeoutMs, budget);
    if (timeoutMs < 1_000) throw new ParserError("timeout", { retryable: false, status: null, message: "no time budget left" });

    const headers = parserHeaders(secret, PARSE_PATH, body, clock());
    const requestId = headers[PARSER_HEADERS.requestId];
    const signals = [AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])];
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.any(signals), redirect: "error" });
    } catch (e) {
      if (opts.signal?.aborted) throw new ParserError("aborted", { retryable: true, status: null });
      if (isAbortLike(e)) {
        console.warn(`[syllabus] parser timeout after ${Date.now() - t0}ms (attempt ${attempt})`);
        throw new ParserError("timeout", { retryable: false, status: null });
      }
      console.warn(`[syllabus] parser unreachable (attempt ${attempt})`);
      if (attempt === 1 && canRetry(opts.deadline)) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new ParserError("unreachable", { retryable: true, status: null });
    }
    const elapsed = Date.now() - t0;

    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ParserError("bad_response", { retryable: false, status: res.status, message: "parser returned non-JSON" });
      }
      const parsed = parseSyllabusResponseSchema.safeParse(json);
      if (!parsed.success) {
        const where = parsed.error.issues
          .slice(0, 4)
          .map((i) => i.path.join("."))
          .join(",");
        console.warn(`[syllabus] parser response failed contract validation at ${where}`);
        throw new ParserError("bad_response", { retryable: false, status: res.status, message: "response does not match contract v1" });
      }
      return { response: parsed.data, requestId, httpAttempts: attempt, latencyMs: Date.now() - started };
    }

    const err = await errorFromResponse(res, elapsed);
    console.warn(`[syllabus] parser error ${err.code} status=${res.status} after ${elapsed}ms (attempt ${attempt})`);
    const transient = res.status === 429 || (res.status === 503 && elapsed <= SLOW_OVERLOAD_MS);
    if (transient && attempt === 1 && canRetry(opts.deadline)) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    throw err;
  }
}

function canRetry(deadline: number | undefined): boolean {
  return deadline === undefined || deadline - Date.now() > RETRY_DELAY_MS + MIN_RETRY_BUDGET_MS;
}

/**
 * Call `POST /v1/parse-syllabus` (master plan §1.13 signature).
 * @param req contract v1 request
 * @param opts injectable fetch (plus clock / timeout / deadline / signal seams)
 * @returns the validated response
 * @throws ParserError on an error response or transport failure
 */
export async function callParseSyllabus(req: ParseSyllabusRequest, opts?: ParserCallOptions): Promise<ParseSyllabusResponse> {
  return (await parseSyllabusCall(req, opts)).response;
}
