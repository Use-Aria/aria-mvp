/** Confirmation bubbles (V2-08 §10 `confirm.test.ts`): 1–2 bubbles ≤ 320 chars, local dates only. */
import { displayCourseKey, MAX_BUBBLE_CHARS, renderSyllabusConfirmation } from "@/server/integrations/syllabus/confirm";
import type { IntakeOutcome } from "@/server/integrations/syllabus/types";

const TZ = "America/New_York";
const NOW = new Date("2026-10-10T15:00:00Z");

const OK: IntakeOutcome = {
  status: "ok",
  syllabusId: "sid",
  courseKey: "HIST101",
  courseLabel: "HIST 101 The Ancient World",
  replaced: false,
  previousParsedAt: null,
  examCount: 2,
  assignmentCount: 1,
  itemCount: 2,
  issues: [],
  courseMismatch: false,
  nextExam: { title: "Midterm", startsAt: "2026-10-15T17:00:00Z", date: "2026-10-15", allDay: false },
  gradingTotalPct: 100,
  pageCount: 2,
  truncatedPages: false,
};

const ALL: IntakeOutcome[] = [
  OK,
  { ...OK, replaced: true, previousParsedAt: "2026-09-03T14:00:00Z" },
  {
    ...OK,
    status: "needs_review",
    gradingTotalPct: 85,
    courseMismatch: true,
    issues: [
      { code: "weights_sum", severity: "error", message: "grading weights sum to 85", path: "grading" },
      { code: "course_mismatch", severity: "warn", message: "x", path: "course" },
    ],
  },
  { ...OK, examCount: 0, assignmentCount: 0, itemCount: 0, nextExam: null },
  { ...OK, truncatedPages: true, pageCount: 120, courseLabel: "X".repeat(400) },
  { ...OK, issues: [{ code: "stale_term", severity: "warn", message: "x", path: "" }] },
  { status: "exists", courseKey: "CPSC223", courseLabel: "CPSC 223 Data Structures", parsedAt: "2026-09-03T14:00:00Z", reason: "same_course" },
  { status: "exists", courseKey: "CPSC223", courseLabel: "CPSC 223", parsedAt: "2026-09-03T14:00:00Z", reason: "same_file" },
  { status: "not_syllabus", documentKind: "assignment" },
  { status: "not_syllabus", documentKind: "other" },
  { status: "unreadable" },
  { status: "rate_limited" },
  { status: "failed", code: "status", retryable: false, httpStatus: 403 },
  { status: "failed", code: "encrypted_pdf", retryable: false },
  { status: "failed", code: "too_large", retryable: false },
  { status: "failed", code: "unreachable", retryable: true },
];

describe("renderSyllabusConfirmation", () => {
  it.each(ALL.map((o, i) => [i, o] as const))("outcome %i → 1–2 bubbles ≤ 320 chars, no raw ISO timestamps", (_i, o) => {
    const b = renderSyllabusConfirmation(o, TZ, NOW);
    expect(b.length).toBeGreaterThanOrEqual(1);
    expect(b.length).toBeLessThanOrEqual(2);
    for (const text of b) {
      expect(text.length).toBeLessThanOrEqual(MAX_BUBBLE_CHARS);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text.trim()).toBe(text);
    }
  });

  it("ok: course, counts and next exam in local time", () => {
    const [first, second] = renderSyllabusConfirmation(OK, TZ, NOW);
    expect(first).toContain("HIST 101 The Ancient World");
    expect(first).toContain("2 exams, 1 assignment");
    expect(first).toContain("midterm Thu 1pm"); // Oct 15 17:00Z = 1pm EDT, 5 days out
    expect(second).toBeUndefined();
  });

  it("replaced: mentions the earlier upload's date", () => {
    expect(renderSyllabusConfirmation(ALL[1], TZ, NOW)[0]).toMatch(/updated your .* \(replaced the one from Thu Sep 3\)/);
  });

  it("issues are mentioned: weight total, course mismatch, truncation, stale term", () => {
    expect(renderSyllabusConfirmation(ALL[2], TZ, NOW)[1]).toMatch(/85%/);
    expect(renderSyllabusConfirmation(ALL[2], TZ, NOW)[1]).toMatch(/saved it under that/);
    expect(renderSyllabusConfirmation(ALL[4], TZ, NOW)[1]).toMatch(/120 pages so I read the first 20/);
    expect(renderSyllabusConfirmation(ALL[5], TZ, NOW)[1]).toMatch(/older syllabus/);
  });

  it("exists asks before replacing; same file is a short ack", () => {
    expect(renderSyllabusConfirmation(ALL[6], TZ, NOW)[0]).toBe(
      "I already have your CPSC 223 Data Structures syllabus from Thu Sep 3 — want me to replace it?",
    );
    expect(renderSyllabusConfirmation(ALL[7], TZ, NOW)).toEqual(["already have that one 👍"]);
  });

  it("failures map to friendly asks", () => {
    expect(renderSyllabusConfirmation(ALL[12], TZ, NOW)[0]).toMatch(/link expired/);
    expect(renderSyllabusConfirmation(ALL[13], TZ, NOW)[0]).toMatch(/password-protected/);
    expect(renderSyllabusConfirmation(ALL[8], TZ, NOW)[0]).toMatch(/an assignment, not a syllabus/);
  });
});

describe("displayCourseKey", () => {
  it.each([
    ["CPSC223", "CPSC 223"],
    ["S&DS230", "S&DS 230"],
    ["t:data-structures", "data structures"],
  ])("%s → %s", (k, want) => expect(displayCourseKey(k)).toBe(want));
});
