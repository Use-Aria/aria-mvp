import vectors from "../../fixtures/contract/course_key_vectors.json";
import { courseKey, sameCourse } from "@/shared/course-key";

interface Vector {
  input: string | null;
  expected: string | null;
  note?: string;
}

describe("courseKey shared vectors (TS ↔ Python contract)", () => {
  const list = vectors.vectors as Vector[];

  it("has a meaningful vector set", () => {
    expect(list.length).toBeGreaterThanOrEqual(20);
  });

  it.each(list.map((v) => [JSON.stringify(v.input), v] as const))("%s", (_label, v) => {
    expect(courseKey(v.input)).toBe(v.expected);
  });

  it("is idempotent on every non-null output", () => {
    for (const v of list) {
      if (v.expected !== null) expect(courseKey(v.expected)).toBe(v.expected);
    }
  });
});

describe("courseKey", () => {
  it("maps the Canvas [CPSC 223 01 (FA26)] format", () => {
    expect(courseKey("[CPSC 223 01 (FA26)]")).toBe("CPSC223");
    expect(courseKey("CPSC 223 01 (FA26)")).toBe("CPSC223");
  });

  it("never yields a key for empty input (V1 regression)", () => {
    expect(courseKey("")).toBeNull();
    expect(courseKey(undefined)).toBeNull();
    expect(courseKey(null)).toBeNull();
  });

  it("caps long title slugs at 60 chars without a trailing dash", () => {
    const k = courseKey("An Extremely Long Seminar Title About Many Things Including Several Others Too");
    expect(k).not.toBeNull();
    expect((k ?? "").length).toBeLessThanOrEqual(62);
    expect(k).not.toMatch(/-$/);
  });
});

describe("sameCourse", () => {
  it("matches Canvas code text against user and syllabus forms", () => {
    expect(sameCourse("CPSC 223 01 (FA26)", "cpsc223")).toBe(true);
    expect(sameCourse("CPSC 223 01 (FA26)", "CPSC223")).toBe(true);
    expect(sameCourse("Data Structures", "data structures (Fall 2026)")).toBe(true);
    expect(sameCourse("CPSC 223", "CPSC 323")).toBe(false);
  });

  it("is false when either side is null or empty", () => {
    expect(sameCourse(null, "CPSC 223")).toBe(false);
    expect(sameCourse("CPSC 223", null)).toBe(false);
    expect(sameCourse(null, null)).toBe(false);
    expect(sameCourse("", "")).toBe(false);
  });
});
