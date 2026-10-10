/** Parsed syllabus → timeline items (V2-08 §10 `timeline-map.test.ts`). */
import { parseSyllabusResponseSchema, type ParsedSyllabus } from "@/server/integrations/syllabus/contract";
import {
  syllabusExternalId,
  syllabusIdPrefix,
  syllabusItemIds,
  toTimelineItems,
} from "@/server/integrations/syllabus/timeline-map";
import { loadContractFixture } from "./fixtures";

const GOLDEN = parseSyllabusResponseSchema.parse(loadContractFixture("response_ok.json")).syllabus as ParsedSyllabus;
const NOW = new Date("2026-09-01T12:00:00Z");

function clone(p: ParsedSyllabus): ParsedSyllabus {
  return JSON.parse(JSON.stringify(p)) as ParsedSyllabus;
}

function map(p: ParsedSyllabus, now = NOW) {
  return toTimelineItems({ courseKey: "HIST101", courseLabel: "HIST 101 The Ancient World", syllabusId: "sid", parsed: p, now });
}

describe("syllabusExternalId", () => {
  it("is prefixed by syl:<courseKey>: and stable across case/punctuation", () => {
    const a = syllabusExternalId("HIST101", "exam", "Midterm", 0);
    expect(a).toMatch(/^syl:HIST101:[0-9a-f]{16}$/);
    expect(a.startsWith(syllabusIdPrefix("HIST101"))).toBe(true);
    expect(syllabusExternalId("HIST101", "exam", "  midterm!", 0)).toBe(a);
    expect(syllabusExternalId("HIST101", "assignment", "Midterm", 0)).not.toBe(a);
  });
});

describe("toTimelineItems", () => {
  it("maps exams and assignments with UTC instants and raw syllabus info", () => {
    const items = map(GOLDEN);
    expect(items).toHaveLength(3);
    const mid = items.find((i) => i.title === "Midterm");
    expect(mid).toMatchObject({
      source: "syllabus",
      kind: "exam",
      course: "HIST 101 The Ancient World",
      allDay: false,
      startsAt: new Date("2026-10-15T17:00:00Z"),
      endsAt: new Date("2026-10-15T18:15:00Z"),
      dueAt: null,
    });
    expect(mid?.raw).toMatchObject({ syllabus_id: "sid", weight_pct: 25, topics: ["Mesopotamia", "Egypt", "Archaic Greece"], all_day: false });
    expect(mid?.timingKey).toBeUndefined();
    for (const i of items) expect(i.externalId.startsWith("syl:HIST101:")).toBe(true);
  });

  it("external ids are stable when only the date changes", () => {
    const moved = clone(GOLDEN);
    moved.exams[0].date = "2026-10-20";
    moved.exams[0].starts_at_utc = "2026-10-20T17:00:00Z";
    moved.exams[0].ends_at_utc = "2026-10-20T18:15:00Z";
    const before = map(GOLDEN).find((i) => i.title === "Midterm")?.externalId;
    const after = map(moved).find((i) => i.title === "Midterm")?.externalId;
    expect(after).toBe(before);
  });

  it("repeated titles get distinct ordinals", () => {
    const p = clone(GOLDEN);
    const quiz = { ...p.exams[0], title: "Quiz", kind: "quiz" };
    p.exams = [
      { ...quiz, date: "2026-10-20", starts_at_utc: "2026-10-20T17:00:00Z", ends_at_utc: null },
      { ...quiz, date: "2026-10-27", starts_at_utc: "2026-10-27T17:00:00Z", ends_at_utc: null },
    ];
    const ids = map(p).filter((i) => i.kind === "exam").map((i) => i.externalId);
    expect(new Set(ids).size).toBe(2);
  });

  it("skips undated and past items (but keeps them in the prune keep-list when dated)", () => {
    const p = clone(GOLDEN);
    p.exams.push({ ...p.exams[0], title: "Quiz week 8", date: null, date_confidence: "unresolved", starts_at_utc: null, ends_at_utc: null });
    const late = map(p, new Date("2026-11-01T00:00:00Z"));
    expect(late.map((i) => i.title)).toEqual(["Final Exam"]);
    const keep = syllabusItemIds("HIST101", p);
    expect(keep).toHaveLength(3); // midterm, final, response paper (undated quiz excluded)
  });

  it("all-day: exam spans local midnight → midnight, assignment due 23:59 local, floating timing key", () => {
    const p = clone(GOLDEN);
    p.exams[0] = {
      ...p.exams[0],
      all_day: true,
      start_local: null,
      end_local: null,
      starts_at_utc: "2026-10-15T04:00:00Z",
      ends_at_utc: "2026-10-16T04:00:00Z",
    };
    p.assignments[0] = { ...p.assignments[0], due_date: "2026-11-05", all_day: true, due_local: null, due_at_utc: "2026-11-05T05:00:00Z" };
    const items = map(p);
    const exam = items.find((i) => i.title === "Midterm");
    expect(exam).toMatchObject({ allDay: true, timingKey: "2026-10-15", startsAt: new Date("2026-10-15T04:00:00Z"), endsAt: new Date("2026-10-16T04:00:00Z") });
    const a = items.find((i) => i.kind === "assignment");
    // Nov 5 2026 is EST (UTC-5): 23:59 local = 04:59Z next day
    expect(a).toMatchObject({ allDay: true, timingKey: "2026-11-05", dueAt: new Date("2026-11-06T04:59:00Z") });
    expect(a?.raw).toMatchObject({ all_day: true });
  });
});
