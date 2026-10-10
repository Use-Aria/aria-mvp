import "server-only";
// OWNER: 3.5

/**
 * HMAC request signing for the parser service (V2-08 §2.13). Pure (node:crypto only).
 * Canonical string: `v1\n{unix_ts}\n{METHOD}\n{path}\n{hex(sha256(body))}`; signature header
 * `x-aria-signature: v1=<hex(HMAC_SHA256(secret, canonical))>`. The secret is used as its raw
 * UTF-8 bytes (never hex/base64-decoded), exactly like `services/parser/app/auth.py`. Both sides
 * pass `services/parser/tests/fixtures/contract/signing_vectors.json`.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

/** Header names (contract v1). */
export const PARSER_HEADERS = {
  timestamp: "x-aria-timestamp",
  signature: "x-aria-signature",
  requestId: "x-aria-request-id",
} as const;

/**
 * Canonical bytes that get signed for one request.
 * @param input timestamp (unix seconds), method, path, exact UTF-8 body
 * @returns the canonical string
 */
export function canonicalString(input: { timestamp: number; method: string; path: string; body: string }): string {
  const digest = createHash("sha256").update(input.body, "utf8").digest("hex");
  return `v1\n${input.timestamp}\n${input.method.toUpperCase()}\n${input.path}\n${digest}`;
}

/**
 * Signature header value for one request.
 * @param input shared secret (raw UTF-8), method, path, exact body, unix timestamp
 * @returns `v1=<lowercase hex>`
 */
export function signParserRequest(input: {
  secret: string;
  method: "POST";
  path: string;
  body: string;
  timestamp: number;
}): string {
  const mac = createHmac("sha256", Buffer.from(input.secret, "utf8")).update(canonicalString(input), "utf8").digest("hex");
  return `v1=${mac}`;
}

/**
 * Fresh signed headers for one POST. Call again for every retry: the parser's replay cache keys
 * on the signature, so a retry must carry a new timestamp (and gets a new request id).
 * @param secret shared secret (raw UTF-8)
 * @param path request path, e.g. "/v1/parse-syllabus"
 * @param body exact JSON body that will be sent
 * @param now clock (default: now)
 * @returns content-type, timestamp, signature and request-id headers
 */
export function parserHeaders(secret: string, path: string, body: string, now: Date = new Date()): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    "content-type": "application/json",
    [PARSER_HEADERS.timestamp]: String(timestamp),
    [PARSER_HEADERS.signature]: signParserRequest({ secret, method: "POST", path, body, timestamp }),
    [PARSER_HEADERS.requestId]: randomUUID(),
  };
}
