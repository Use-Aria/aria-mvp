import "server-only";
// OWNER: 3.5
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 3.5 lands */

/**
 * Parser service client (master plan §1.13; V2-08 §7.2 `client.ts`): HMAC-signed POST, timeout,
 * one retry only on connection error / 503 / 429, zod-validated response. Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";
import type { ParseSyllabusRequest, ParseSyllabusResponse } from "@/server/integrations/syllabus/contract";

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

/**
 * Call `POST /v1/parse-syllabus`.
 * @param req contract v1 request
 * @param opts injectable fetch
 * @returns the validated response
 * @throws ParserError on an error response or transport failure
 */
export async function callParseSyllabus(
  req: ParseSyllabusRequest,
  opts?: { fetchImpl?: typeof fetch },
): Promise<ParseSyllabusResponse> {
  throw notImplemented("3.5");
}
