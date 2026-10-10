/**
 * Unit tests for src/shared/canvas-guide.ts (V2-05 §7.1). Run: npm test
 */
import {
  CANVAS_ERROR_COPY,
  CANVAS_GUIDE_STEPS,
  formatConnectSummary,
  shortCourseLabel,
  type CanvasConnectError,
} from "@/shared/canvas-guide";

const ALL_ERRORS: CanvasConnectError[] = [
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
];

describe("guide copy", () => {
  it("has the three Calendar Feed steps as plain text", () => {
    expect(CANVAS_GUIDE_STEPS).toHaveLength(3);
    expect(CANVAS_GUIDE_STEPS[1]).toContain("Calendar Feed");
    for (const s of CANVAS_GUIDE_STEPS) expect(s).not.toMatch(/\*\*/);
  });

  it("has non-empty copy for every connect error, including the salvaged V1 strings", () => {
    expect(Object.keys(CANVAS_ERROR_COPY).sort()).toEqual([...ALL_ERRORS].sort());
    for (const code of ALL_ERRORS) expect(CANVAS_ERROR_COPY[code].length).toBeGreaterThan(10);
    expect(CANVAS_ERROR_COPY.unreachable).toBe("Couldn't reach that Canvas feed. Double-check the URL.");
    expect(CANVAS_ERROR_COPY.not_ical).toContain("instructure.com/feeds/calendars/user_");
    expect(CANVAS_ERROR_COPY.course_feed).toContain("Calendar Feed");
  });
});

describe("formatConnectSummary", () => {
  it("matches the spec example", () => {
    expect(
      formatConnectSummary({
        deadlines: 14,
        courses: ["CPSC 323 01 (FA26)", "ENGL 120", "MATH 225", "HIST 101"],
        nextDue: { title: "Pset 4", course: "CPSC 323 01 (FA26)", label: "Thu 11:59pm" },
      }),
    ).toBe("found 14 deadlines across 4 courses — next up: Pset 4 (CPSC 323), due Thu 11:59pm");
  });

  it("counts courses by courseKey and handles singulars and missing parts", () => {
    expect(formatConnectSummary({ deadlines: 1, courses: ["CPSC 323 01 (FA26)", "CPSC 323"], nextDue: null })).toBe(
      "found 1 deadline across 1 course",
    );
    expect(formatConnectSummary({ deadlines: 2, courses: [], nextDue: { title: "Fall Recess", course: null, label: "Sat" } })).toBe(
      "found 2 deadlines — next up: Fall Recess, due Sat",
    );
  });

  it("zero deadlines is a success message, not an error", () => {
    expect(formatConnectSummary({ deadlines: 0, courses: [], nextDue: null })).toBe(
      "connected, but I don't see upcoming deadlines yet. That's normal before the term starts.",
    );
  });

  it("keeps titles on one line and clips long ones", () => {
    const s = formatConnectSummary({ deadlines: 3, courses: ["A"], nextDue: { title: `Line\nbreak ${"x".repeat(100)}`, course: null, label: "Fri" } });
    expect(s).not.toContain("\n");
    expect(s).toContain("Line break");
    expect(s).toContain("…");
  });
});

describe("shortCourseLabel", () => {
  it.each<[string | null, string | null]>([
    ["CPSC 323 01 (FA26)", "CPSC 323"],
    ["CHEM 134L", "CHEM 134L"],
    ["math-225", "MATH 225"],
    ["Data Structures and Algorithms in Practice", "Data Structures and Alg…"],
    [null, null],
    ["", null],
  ])("%j → %j", (input, out) => {
    expect(shortCourseLabel(input)).toBe(out);
  });
});
