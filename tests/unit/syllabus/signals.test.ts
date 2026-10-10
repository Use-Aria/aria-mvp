/** Signals + topicsForExam — the V1 `exams[0]` regression (V2-08 §10 `signals.test.ts`). */
import { parseSyllabusResponseSchema, type ParsedSyllabus } from "@/server/integrations/syllabus/contract";
import { scheduleRowDate, signalsFromRow, topicsForExam } from "@/server/integrations/syllabus/signals";
import { loadContractFixture } from "./fixtures";

const GOLDEN = parseSyllabusResponseSchema.parse(loadContractFixture("response_ok.json")).syllabus as ParsedSyllabus;

function clone(p: ParsedSyllabus): ParsedSyllabus {
  return JSON.parse(JSON.stringify(p)) as ParsedSyllabus;
}

describe("topicsForExam", () => {
  it("picks the exam matching the date, not exams[0]", () => {
    expect(topicsForExam(GOLDEN, { title: "final", date: "2026-12-14" })).toEqual(["Classical Greece", "Rome"]);
    expect(topicsForExam(GOLDEN, { title: "whatever", date: "2026-12-15" })).toEqual(["Classical Greece", "Rome"]);
  });

  it("matches by title when no date is given", () => {
    expect(topicsForExam(GOLDEN, { title: "Final Exam", date: null })).toEqual(["Classical Greece", "Rome"]);
    expect(topicsForExam(GOLDEN, { title: "midterm exam", date: null })).toEqual(["Mesopotamia", "Egypt", "Archaic Greece"]);
  });

  it("falls back to schedule topics between the previous exam and this one", () => {
    const p = clone(GOLDEN);
    p.exams[1].topics = [];
    p.schedule = [
      { week: 5, date: null, topics: ["Egypt"], readings: [], due: [] }, // Sep 21 week, before the midterm
      { week: null, date: "2026-10-20", topics: ["Classical Greece"], readings: [], due: [] },
      { week: null, date: "2026-11-10", topics: ["Rome", "classical greece"], readings: [], due: [] },
      { week: null, date: "2026-12-20", topics: ["After"], readings: [], due: [] },
    ];
    expect(topicsForExam(p, { title: "Final Exam", date: "2026-12-14" })).toEqual(["Classical Greece", "Rome"]);
  });

  it("returns [] when the exam is unknown and undated", () => {
    expect(topicsForExam(GOLDEN, { title: "Lab practical", date: null })).toEqual([]);
  });
});

describe("scheduleRowDate", () => {
  it("week N → Monday of the term-start week + 7·(N−1)", () => {
    // term starts Wed 2026-08-26 → week 1 Monday is 2026-08-24; week 5 → 2026-09-21
    expect(scheduleRowDate({ week: 5, date: null, topics: [], readings: [], due: [] }, "2026-08-26")).toBe("2026-09-21");
    expect(scheduleRowDate({ week: 5, date: null, topics: [], readings: [], due: [] }, null)).toBeNull();
    expect(scheduleRowDate({ week: null, date: "2026-10-01", topics: [], readings: [], due: [] }, null)).toBe("2026-10-01");
  });
});

describe("signalsFromRow", () => {
  it("maps grading, exams (with topics) and meetings; null on unusable JSON", () => {
    const s = signalsFromRow({ course_key: "HIST101", course_name: "HIST 101 The Ancient World", parsed_json: GOLDEN });
    expect(s).toMatchObject({
      courseKey: "HIST101",
      courseLabel: "HIST 101 The Ancient World",
      grading: [
        { name: "Participation", weightPct: 10 },
        { name: "Response papers", weightPct: 30 },
        { name: "Midterm exam", weightPct: 25 },
        { name: "Final exam", weightPct: 35 },
      ],
    });
    expect(s?.exams[1]).toEqual({ title: "Final Exam", startsAt: "2026-12-14T14:00:00Z", weightPct: 35, topics: ["Classical Greece", "Rome"] });
    expect(s?.meetings[0].days).toEqual(["TU", "TH"]);
    expect(signalsFromRow({ course_key: "X", course_name: "X", parsed_json: {} })).toBeNull();
  });
});
