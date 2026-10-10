/** Read-time Canvas ↔ syllabus collapse (V2-08 §2.11, §10 `dedupe.test.ts`). */
import { collapseSyllabusDuplicates, titlesMatch } from "@/server/integrations/syllabus/dedupe";
import type { TimelineItemView, TimelineLike } from "@/server/timeline/types";

const TZ = "America/New_York";

type Item = TimelineLike & { id: string; syllabus?: TimelineItemView["syllabus"] };

function item(p: Partial<Item> & Pick<Item, "id" | "source" | "kind" | "title">): Item {
  return { course: "HIST 101", dueAt: null, startsAt: null, allDay: false, allDayDate: null, ...p };
}

const canvasMid = item({
  id: "c1",
  source: "canvas",
  kind: "assignment",
  title: "Midterm Exam",
  course: "HIST 101 01 (FA26)",
  dueAt: new Date("2026-10-15T17:00:00Z"),
});
const sylMid = item({
  id: "s1",
  source: "syllabus",
  kind: "exam",
  title: "Midterm",
  course: "HIST 101 The Ancient World",
  startsAt: new Date("2026-10-15T17:00:00Z"),
  syllabus: { weight_pct: 25, topics: ["Egypt"] },
});

describe("collapseSyllabusDuplicates", () => {
  it("Canvas 'Midterm Exam' + syllabus 'Midterm' same day → one item carrying the weight", () => {
    const out = collapseSyllabusDuplicates([canvasMid, sylMid], TZ);
    expect(out.map((i) => i.id)).toEqual(["c1"]);
    expect(out[0].syllabus).toEqual({ weight_pct: 25, topics: ["Egypt"] });
    expect(canvasMid.syllabus).toBeUndefined(); // input not mutated
  });

  it("±1 day still collapses; 2 days apart does not for exams", () => {
    const nextDay = { ...sylMid, startsAt: new Date("2026-10-16T15:00:00Z") };
    expect(collapseSyllabusDuplicates([canvasMid, nextDay], TZ).map((i) => i.id)).toEqual(["c1"]);
    const twoDays = { ...sylMid, startsAt: new Date("2026-10-17T15:00:00Z") };
    expect(collapseSyllabusDuplicates([canvasMid, twoDays], TZ)).toHaveLength(2);
  });

  it("a different course keeps both", () => {
    const other = { ...sylMid, course: "CPSC 223" };
    expect(collapseSyllabusDuplicates([canvasMid, other], TZ)).toHaveLength(2);
  });

  it("'Quiz 2' vs 'Quiz 3' keeps both", () => {
    const c = item({ id: "c", source: "canvas", kind: "assignment", title: "Quiz 2", dueAt: new Date("2026-10-15T17:00:00Z") });
    const s = item({ id: "s", source: "syllabus", kind: "exam", title: "Quiz 3", startsAt: new Date("2026-10-15T17:00:00Z") });
    expect(collapseSyllabusDuplicates([c, s], TZ)).toHaveLength(2);
  });

  it("a syllabus item with no Canvas twin stays; non-canvas sources never shadow", () => {
    const gcal = { ...canvasMid, id: "g", source: "gcal" as const, kind: "event" as const };
    expect(collapseSyllabusDuplicates([gcal, sylMid], TZ).map((i) => i.id)).toEqual(["g", "s1"]);
    expect(collapseSyllabusDuplicates([sylMid], TZ)).toEqual([sylMid]);
  });

  it("assignments: kind must be assignment on both sides, ≤ 2 days", () => {
    const c = item({ id: "c", source: "canvas", kind: "assignment", title: "Response Paper 1", dueAt: new Date("2026-09-18T21:00:00Z") });
    const s = item({ id: "s", source: "syllabus", kind: "assignment", title: "Response paper 1", dueAt: new Date("2026-09-20T03:59:00Z") });
    expect(collapseSyllabusDuplicates([c, s], TZ).map((i) => i.id)).toEqual(["c"]);
    const ev = { ...c, kind: "event" as const };
    expect(collapseSyllabusDuplicates([ev, s], TZ)).toHaveLength(2);
  });

  it("uses allDayDate for all-day items and keeps order", () => {
    const c = item({ id: "c", source: "canvas", kind: "event", title: "Final exam", allDay: true, allDayDate: "2026-12-14", startsAt: new Date("2026-12-14T05:00:00Z") });
    const s = item({ id: "s", source: "syllabus", kind: "exam", title: "Final Exam", startsAt: new Date("2026-12-14T14:00:00Z") });
    const x = item({ id: "x", source: "canvas", kind: "assignment", title: "Other", dueAt: new Date("2026-12-01T05:00:00Z") });
    expect(collapseSyllabusDuplicates([x, s, c], TZ).map((i) => i.id)).toEqual(["x", "c"]);
  });

  it("each Canvas item absorbs at most one syllabus item", () => {
    const s2 = { ...sylMid, id: "s2" };
    expect(collapseSyllabusDuplicates([canvasMid, sylMid, s2], TZ).map((i) => i.id)).toEqual(["c1", "s2"]);
  });
});

describe("titlesMatch", () => {
  it.each([
    ["Midterm", "Midterm Exam", true],
    ["Midterm 1", "Mid-term Exam I", true],
    ["Final Exam", "Final", true],
    ["Problem Set 3", "PS 3", true],
    ["Quiz 2", "Quiz 3", false],
    ["Midterm", "Final", false],
    ["Response paper 1", "Response Paper #1", true],
    ["Lab report", "Reading response", false],
  ])("%s ~ %s → %s", (a, b, want) => {
    expect(titlesMatch(a, b)).toBe(want);
  });
});
