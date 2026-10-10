/**
 * Parser contract v1 — cross-language goldens (services/parser/tests/fixtures/contract/):
 * signing vectors, the three golden 200 responses, and the error bodies.
 */
import { canonicalString, parserHeaders, signParserRequest } from "@/server/integrations/syllabus/signing";
import {
  PARSER_CONTRACT,
  parseSyllabusRequestSchema,
  parseSyllabusResponseSchema,
  parserErrorSchema,
} from "@/server/integrations/syllabus/contract";
import { loadContractFixture } from "./fixtures";

interface Vector {
  secret: string;
  timestamp: number;
  method: "POST";
  path: string;
  body: string;
  canonical: string;
  signature: string;
}

describe("signing_vectors.json", () => {
  const { vectors } = loadContractFixture("signing_vectors.json") as { vectors: Vector[] };

  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(3);
  });

  it.each(vectors.map((v, i) => [i, v] as const))("vector %i: canonical + signature match Python", (_i, v) => {
    expect(canonicalString(v)).toBe(v.canonical);
    expect(signParserRequest(v)).toBe(v.signature);
  });

  it("uses the secret as raw UTF-8 bytes (a base64-looking secret is NOT decoded)", () => {
    const v = vectors.find((x) => x.secret.endsWith("=="));
    expect(v).toBeDefined();
    if (!v) return;
    const decoded = Buffer.from(v.secret, "base64").toString("latin1");
    expect(signParserRequest({ ...v, secret: decoded })).not.toBe(v.signature);
  });

  it("parserHeaders: fresh timestamp + request id per call, signature over the exact body", () => {
    const body = '{"a":1}';
    const h1 = parserHeaders("s3cret", "/v1/parse-syllabus", body, new Date(1_791_600_000_000));
    const h2 = parserHeaders("s3cret", "/v1/parse-syllabus", body, new Date(1_791_600_001_000));
    expect(h1["x-aria-timestamp"]).toBe("1791600000");
    expect(h2["x-aria-timestamp"]).toBe("1791600001");
    expect(h1["x-aria-signature"]).not.toBe(h2["x-aria-signature"]);
    expect(h1["x-aria-request-id"]).not.toBe(h2["x-aria-request-id"]);
    expect(h1["x-aria-signature"]).toBe(
      signParserRequest({ secret: "s3cret", method: "POST", path: "/v1/parse-syllabus", body, timestamp: 1_791_600_000 }),
    );
    expect(h1["content-type"]).toBe("application/json");
  });
});

describe("golden responses", () => {
  it.each(["response_ok.json", "response_needs_review.json", "response_not_syllabus.json"])("%s validates", (name) => {
    const r = parseSyllabusResponseSchema.safeParse(loadContractFixture(name));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.contract).toBe(PARSER_CONTRACT);
      for (const issue of r.data.issues) expect(typeof issue.path).toBe("string");
    }
  });

  it("ok golden: HIST101 with two exams and weights to 100", () => {
    const r = parseSyllabusResponseSchema.parse(loadContractFixture("response_ok.json"));
    expect(r.status).toBe("ok");
    expect(r.syllabus?.course.key).toBe("HIST101");
    expect(r.syllabus?.exams.map((e) => e.date)).toEqual(["2026-10-15", "2026-12-14"]);
    expect(r.syllabus?.grading_total_pct).toBe(100);
  });

  it("needs_review golden: escalated attempt chosen, issues carry string paths", () => {
    const r = parseSyllabusResponseSchema.parse(loadContractFixture("response_needs_review.json"));
    expect(r.chosen_attempt).toBe(1);
    expect(r.attempts.map((a) => a.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(r.issues.map((i) => i.code)).toContain("weights_sum");
  });

  it("not_syllabus golden has a null syllabus", () => {
    const r = parseSyllabusResponseSchema.parse(loadContractFixture("response_not_syllabus.json"));
    expect(r.syllabus).toBeNull();
    expect(r.document_kind).toBe("assignment");
  });

  it("rejects a mutated golden (missing attempts)", () => {
    const json = loadContractFixture("response_ok.json") as Record<string, unknown>;
    const { attempts: _drop, ...rest } = json;
    void _drop;
    expect(parseSyllabusResponseSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts the dev fake-llm attempt (zero tokens) and a fallback model id", () => {
    const json = loadContractFixture("response_ok.json") as { attempts: Record<string, unknown>[] };
    const fake = { ...json, attempts: [{ ...json.attempts[0], model: "fake-llm", input_tokens: 0, output_tokens: 0 }] };
    expect(parseSyllabusResponseSchema.safeParse(fake).success).toBe(true);
    const fb = { ...json, attempts: [{ ...json.attempts[0], model: "claude-sonnet-5-20260801" }] };
    expect(parseSyllabusResponseSchema.safeParse(fb).success).toBe(true);
  });

  it("issue.path defaults to an empty string when absent", () => {
    const json = loadContractFixture("response_needs_review.json") as { issues: Record<string, unknown>[] };
    const noPath = { ...json, issues: [{ code: "sparse", severity: "warn", message: "x" }] };
    expect(parseSyllabusResponseSchema.parse(noPath).issues[0].path).toBe("");
  });
});

describe("error bodies", () => {
  it("every golden error body validates with retryable as documented", () => {
    const { errors } = loadContractFixture("response_errors.json") as { errors: Record<string, unknown> };
    const retryable: Record<string, boolean> = { "400": false, "401": false, "413": false, "422": false, "502": true, "503": true };
    for (const [status, body] of Object.entries(errors)) {
      const r = parserErrorSchema.parse(body);
      expect(r.error.retryable).toBe(retryable[status]);
    }
  });
});

describe("request schema", () => {
  it("accepts a V2-08 §8.1 request", () => {
    expect(
      parseSyllabusRequestSchema.safeParse({
        pdf_base64: "JVBERi0xLjQK",
        filename: null,
        course_hint: "orgo",
        timezone: "America/New_York",
        today: "2026-10-10",
        term: { name: null, start: "2026-08-26", end: null },
        known_courses: [{ key: "CPSC223", label: "CPSC 223 01 (FA26)" }],
        allow_escalation: true,
      }).success,
    ).toBe(true);
  });
});
