/** Pure helpers behind intake, store lookup and the syllabus_info tool. */
import { renderAspect } from "@/server/agent/tools/syllabus-info";
import { parseSyllabusResponseSchema, type ParsedSyllabus } from "@/server/integrations/syllabus/contract";
import { nextExamOf, pricedModel } from "@/server/integrations/syllabus/intake";
import { courseLabelFor, matchSyllabusCourse } from "@/server/integrations/syllabus/store";
import { loadContractFixture } from "./fixtures";

const GOLDEN = parseSyllabusResponseSchema.parse(loadContractFixture("response_ok.json")).syllabus as ParsedSyllabus;

describe("pricedModel", () => {
  it("prices exact and dated fallback ids; fake-llm and unknown ids are unpriced", () => {
    expect(pricedModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(pricedModel("claude-opus-5-5-20261001")).toBe("claude-opus-5-5");
    expect(pricedModel("fake-llm")).toBeNull();
    expect(pricedModel("claude-sonnet-4-6")).toBeNull();
  });
});

describe("nextExamOf", () => {
  it("is the soonest exam not yet over", () => {
    expect(nextExamOf(GOLDEN, new Date("2026-10-10T12:00:00Z"))).toEqual({
      title: "Midterm",
      startsAt: "2026-10-15T17:00:00Z",
      date: "2026-10-15",
      allDay: false,
    });
    expect(nextExamOf(GOLDEN, new Date("2026-10-16T00:00:00Z"))?.title).toBe("Final Exam");
    expect(nextExamOf(GOLDEN, new Date("2027-01-01T00:00:00Z"))).toBeNull();
  });
});

describe("matchSyllabusCourse", () => {
  const rows = [
    { course_key: "HIST101", course_name: "HIST 101 The Ancient World", parsed_json: GOLDEN },
    {
      course_key: "CPSC223",
      course_name: "CPSC 223 Data Structures",
      parsed_json: { ...GOLDEN, course: { ...GOLDEN.course, code: "CPSC 223", title: "Data Structures", key: "CPSC223", cross_listed: ["S&DS 223"] } },
    },
  ];

  it.each([
    ["CPSC 223", "CPSC223"],
    ["cpsc223", "CPSC223"],
    ["S&DS 223", "CPSC223"],
    ["hist 101 the ancient world", "HIST101"],
    ["data structures", "CPSC223"],
    ["ancient world", "HIST101"],
  ])("%s → %s", (q, want) => {
    expect(matchSyllabusCourse(rows, q)?.course_key).toBe(want);
  });

  it.each(["", "   ", "orgo", "art", "MATH 120"])("no match for %j (never on empty)", (q) => {
    expect(matchSyllabusCourse(rows, q)).toBeNull();
  });

  it("courseLabelFor joins code and title, else the key", () => {
    expect(courseLabelFor({ code: "HIST 101", title: "The Ancient World" }, "HIST101")).toBe("HIST 101 The Ancient World");
    expect(courseLabelFor({ code: "", title: "" }, "t:data-structures")).toBe("data structures");
  });
});

describe("syllabus_info renderAspect", () => {
  const NOW = new Date("2026-10-10T12:00:00Z");
  const TZ = "America/New_York";

  it("grading lists weights and the total", () => {
    const t = renderAspect(GOLDEN, "grading", TZ, NOW);
    expect(t).toContain("- Midterm exam (25%)");
    expect(t).toContain("total: 100%");
  });

  it("exams show local times, weights and topics; query narrows", () => {
    const t = renderAspect(GOLDEN, "exams", TZ, NOW);
    expect(t).toMatch(/Midterm \(25%\): Thu Oct 15, 1:00\s?PM EDT/);
    expect(t).toContain("topics: Mesopotamia; Egypt; Archaic Greece");
    const f = renderAspect(GOLDEN, "exams", TZ, NOW, "final");
    expect(f).toContain("Final Exam");
    expect(f).not.toContain("Midterm (25%)");
  });

  it("schedule defaults to the next 3 weeks; 'week 5' query finds the row", () => {
    expect(renderAspect(GOLDEN, "schedule", TZ, NOW)).toContain("nothing dated in the schedule for the next 3 weeks");
    expect(renderAspect(GOLDEN, "schedule", TZ, NOW, "week 5")).toContain("week 5, 2026-09-21: topics: Egypt | readings: Ch. 4");
  });

  it("overview, policies and staff render", () => {
    expect(renderAspect(GOLDEN, "overview", TZ, NOW)).toContain("course: HIST 101 The Ancient World");
    expect(renderAspect(GOLDEN, "policies", TZ, NOW)).toContain("late work: Papers lose a third of a grade per day late.");
    expect(renderAspect(GOLDEN, "staff", TZ, NOW)).toContain("Prof. Ada Marlow (instructor), ada.marlow@example.edu, office hours: Wed 2-4pm");
  });
});
