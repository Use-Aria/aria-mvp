/**
 * Parser client retry/sign policy (V2-08 §7.2 `client.ts` + Wave 1 parser requests):
 * fresh signature per retry, one retry for connection/429/fast-503, no retry for timeouts, 504,
 * slow 503 or 4xx; zod-validated body; error body → ParserError(code).
 */
import { callParseSyllabus, parseSyllabusCall, ParserError, SLOW_OVERLOAD_MS } from "@/server/integrations/syllabus/client";
import type { ParseSyllabusRequest } from "@/server/integrations/syllabus/contract";
import { signParserRequest } from "@/server/integrations/syllabus/signing";
import { loadContractFixture } from "./fixtures";

const SECRET = "unit-secret-0123456789abcdef0123456789";
const REQ: ParseSyllabusRequest = {
  pdf_base64: "JVBERi0xLjQK",
  filename: null,
  course_hint: null,
  timezone: "America/New_York",
  today: "2026-10-10",
  term: null,
  known_courses: [],
  allow_escalation: true,
};
const OK = loadContractFixture("response_ok.json");

beforeEach(() => {
  process.env.PARSER_SHARED_SECRET = SECRET;
  process.env.PARSER_SERVICE_URL = "http://parser.test/";
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Step = { status: number; body?: unknown; delayMs?: number } | "network" | "abort";

/** Fake fetch that serves `steps` in order and records each request. */
function fakeFetch(steps: Step[], seen: Seen[], clock?: { ms: number }): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    seen.push({ url: String(input), headers, body: String(init?.body ?? "") });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "abort") {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }
    if (step.delayMs && clock) jest.setSystemTime(Date.now() + step.delayMs);
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const noSleep = async () => undefined;
let tick = 1_791_600_000_000;
const now = () => new Date((tick += 1000));

describe("callParseSyllabus", () => {
  it("signs the exact body and returns the validated response", async () => {
    const seen: Seen[] = [];
    const res = await callParseSyllabus(REQ, { fetchImpl: fakeFetch([{ status: 200, body: OK }], seen), now, sleep: noSleep });
    expect(res.status).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://parser.test/v1/parse-syllabus");
    const ts = Number(seen[0].headers["x-aria-timestamp"]);
    expect(seen[0].headers["x-aria-signature"]).toBe(
      signParserRequest({ secret: SECRET, method: "POST", path: "/v1/parse-syllabus", body: seen[0].body, timestamp: ts }),
    );
    expect(JSON.parse(seen[0].body)).toEqual(REQ);
  });

  it("re-signs every retry with a fresh timestamp and request id (connection error → one retry)", async () => {
    const seen: Seen[] = [];
    const r = await parseSyllabusCall(REQ, {
      fetchImpl: fakeFetch(["network", { status: 200, body: OK }], seen),
      now,
      sleep: noSleep,
    });
    expect(r.httpAttempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0].headers["x-aria-timestamp"]).not.toBe(seen[1].headers["x-aria-timestamp"]);
    expect(seen[0].headers["x-aria-signature"]).not.toBe(seen[1].headers["x-aria-signature"]);
    expect(seen[0].headers["x-aria-request-id"]).not.toBe(seen[1].headers["x-aria-request-id"]);
    expect(r.requestId).toBe(seen[1].headers["x-aria-request-id"]);
  });

  it("retries a 429 and a fast 503 once, then gives up retryable", async () => {
    const seen: Seen[] = [];
    const overloaded = { error: { code: "overloaded", message: "x", retryable: true } };
    await expect(
      callParseSyllabus(REQ, { fetchImpl: fakeFetch([{ status: 503, body: overloaded }], seen), now, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "overloaded", retryable: true, status: 503 });
    expect(seen).toHaveLength(2);

    const seen2: Seen[] = [];
    const r = await callParseSyllabus(REQ, {
      fetchImpl: fakeFetch([{ status: 429, body: { error: { code: "rate", message: "x", retryable: true } } }, { status: 200, body: OK }], seen2),
      now,
      sleep: noSleep,
    });
    expect(r.status).toBe("ok");
    expect(seen2).toHaveLength(2);
  });

  it("does not retry a 503 that took longer than ~150s, and marks it not job-retryable", async () => {
    jest.useFakeTimers({ now: Date.now(), doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      const seen: Seen[] = [];
      const err = await callParseSyllabus(REQ, {
        fetchImpl: fakeFetch(
          [{ status: 503, body: { error: { code: "overloaded", message: "x", retryable: true } }, delayMs: SLOW_OVERLOAD_MS + 5_000 }],
          seen,
          { ms: 0 },
        ),
        now,
        sleep: noSleep,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ParserError);
      expect(err).toMatchObject({ code: "overloaded", retryable: false });
      expect(seen).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("never retries a timeout or a 504", async () => {
    const seen: Seen[] = [];
    await expect(callParseSyllabus(REQ, { fetchImpl: fakeFetch(["abort"], seen), now, sleep: noSleep })).rejects.toMatchObject({
      code: "timeout",
      retryable: false,
    });
    expect(seen).toHaveLength(1);
    const seen2: Seen[] = [];
    await expect(callParseSyllabus(REQ, { fetchImpl: fakeFetch([{ status: 504 }], seen2), now, sleep: noSleep })).rejects.toMatchObject({
      code: "http_504",
      retryable: false,
    });
    expect(seen2).toHaveLength(1);
  });

  it("maps 4xx and 502 error bodies without retrying", async () => {
    const errors = (loadContractFixture("response_errors.json") as { errors: Record<string, unknown> }).errors;
    for (const [status, code, retryable] of [
      [400, "invalid_pdf", false],
      [401, "bad_signature", false],
      [413, "too_large", false],
      [422, "too_many_pages", false],
      [502, "upstream_llm", true],
    ] as const) {
      const seen: Seen[] = [];
      await expect(
        callParseSyllabus(REQ, { fetchImpl: fakeFetch([{ status, body: errors[String(status)] }], seen), now, sleep: noSleep }),
      ).rejects.toMatchObject({ code, retryable, status });
      expect(seen).toHaveLength(1);
    }
  });

  it("rejects a body that breaks the contract", async () => {
    const { attempts: _a, ...broken } = OK as Record<string, unknown>;
    void _a;
    await expect(
      callParseSyllabus(REQ, { fetchImpl: fakeFetch([{ status: 200, body: broken }], []), now, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "bad_response", retryable: false });
  });

  it("refuses to run without a secret", async () => {
    delete process.env.PARSER_SHARED_SECRET;
    await expect(callParseSyllabus(REQ, { fetchImpl: fakeFetch([{ status: 200, body: OK }], []) })).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("does not retry when the deadline leaves no room", async () => {
    const seen: Seen[] = [];
    await expect(
      callParseSyllabus(REQ, { fetchImpl: fakeFetch(["network", { status: 200, body: OK }], seen), now, sleep: noSleep, deadline: Date.now() + 10_000 }),
    ).rejects.toMatchObject({ code: "unreachable", retryable: true });
    expect(seen).toHaveLength(1);
  });
});
