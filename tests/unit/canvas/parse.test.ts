/**
 * Unit tests for src/server/integrations/canvas/parse.ts (V2-05 §2.1, §2.3, §2.4, §10.2). Run: npm test
 */
import { lexIcs, type IcsCalendar, type IcsEvent } from "@/server/integrations/canvas/ics";
import {
  CANVAS_FEED_CAP,
  deriveItemUrl,
  inferKind,
  matchKeyOf,
  parseCanvasFeed,
  resolveTiming,
  splitSummary,
  uidKind,
  type ParsedCanvasFeed,
} from "@/server/integrations/canvas/parse";
import type { TimelineItemInput } from "@/server/timeline/types";
import { toLocal } from "@/shared/time/tz";
import { fixtureBytes, generatedFeed } from "./fixtures";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const HOST = "yale.instructure.com";

function parseFixture(name: string, timezone = NY): ParsedCanvasFeed {
  return parseCanvasFeed(lexIcs(fixtureBytes(name)), { timezone, host: HOST });
}

function item(feed: ParsedCanvasFeed, externalId: string): TimelineItemInput {
  const it = feed.items.find((i) => i.externalId === externalId);
  if (!it) throw new Error(`missing ${externalId}`);
  return it;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

describe("splitSummary", () => {
  it.each<[string, string, string | null]>([
    ["Problem Set 4 [CPSC 323 01 (FA26)]", "Problem Set 4", "CPSC 323 01 (FA26)"],
    ["Lab [Part 2] [CHEM 134L]", "Lab [Part 2]", "CHEM 134L"],
    ["Pset 5 (Extension) [CPSC 323]", "Pset 5 (Extension)", "CPSC 323"],
    ["Fall Recess", "Fall Recess", null],
    ["Weird [unterminated", "Weird [unterminated", null],
    ["Empty group []", "Empty group []", null],
    ["Nested [a]b]", "Nested [a]b]", null],
    ["[CPSC 323]", "CPSC 323", "CPSC 323"],
    ["  Spaced\n title   [ ENGL  120 ]  ", "Spaced title", "ENGL 120"],
    ["Essay - English 120", "Essay - English 120", null], // V1's " - " split never matched Canvas
  ])("%j", (summary, title, course) => {
    expect(splitSummary(summary)).toEqual({ title, course });
  });

  it("is linear on adversarial input", () => {
    const evil = `${"[".repeat(100_000)}x${"]".repeat(100_000)}`;
    const t0 = Date.now();
    splitSummary(evil);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe("uidKind / inferKind", () => {
  it.each([
    ["event-assignment-412345", "assignment"],
    ["event-assignment-override-77", "assignment_override"],
    ["event-sub-assignment-901", "sub_assignment"],
    ["event-calendar-event-77", "calendar_event"],
    ["event-assignment-abc", "unknown"],
    ["4f3c2a10-uuid@google.com", "unknown"],
  ])("uidKind(%s) = %s", (uid, kind) => {
    expect(uidKind(uid)).toBe(kind);
  });

  it.each<[Parameters<typeof inferKind>[0], string, string]>([
    ["assignment", "Final Project", "assignment"],
    ["assignment", "Final Exam", "exam"],
    ["calendar_event", "Final Exam", "exam"],
    ["calendar_event", "Exam Review", "event"],
    ["assignment", "Prelim 1", "exam"],
    ["assignment", "Midterm", "exam"],
    ["assignment", "Mid-term 2", "exam"],
    ["calendar_event", "Midterm Review Session", "event"],
    ["assignment", "Practice Midterm", "assignment"],
    ["assignment", "Exam Corrections", "assignment"],
    ["assignment", "Exam 2 Wrapper", "assignment"],
    ["assignment", "Examination of texts", "assignment"],
    ["sub_assignment", "Discussion 3 Reply", "assignment"],
    ["unknown", "Club meeting", "event"],
  ])("inferKind(%s, %s) = %s", (k, title, kind) => {
    expect(inferKind(k, title)).toBe(kind);
  });
});

describe("matchKeyOf / deriveItemUrl", () => {
  const url = (frag: string, ctx = "course_98765") =>
    `https://${HOST}/calendar?include_contexts=${ctx}&month=10&year=2026#${frag}`;

  it("keys assignments and overrides by the base assignment id, events by event id", () => {
    expect(matchKeyOf("assignment", url("assignment_500"))).toBe("assignment_500");
    expect(matchKeyOf("assignment_override", url("assignment_500"))).toBe("assignment_500");
    expect(matchKeyOf("calendar_event", url("calendar_event_77"))).toBe("calendar_event_77");
  });

  it("is null for sub-assignments, mismatched fragments, unknown UIDs, and no URL", () => {
    expect(matchKeyOf("sub_assignment", url("assignment_900"))).toBeNull();
    expect(matchKeyOf("assignment", url("calendar_event_77"))).toBeNull();
    expect(matchKeyOf("unknown", url("assignment_1"))).toBeNull();
    expect(matchKeyOf("assignment", null)).toBeNull();
  });

  it("derives a same-host direct link, else the same-host calendar URL, else null", () => {
    expect(deriveItemUrl(url("assignment_412345"), HOST)).toBe(`https://${HOST}/courses/98765/assignments/412345`);
    expect(deriveItemUrl(url("calendar_event_77"), HOST)).toBe(url("calendar_event_77"));
    expect(deriveItemUrl(url("assignment_1", "user_5"), HOST)).toBe(url("assignment_1", "user_5"));
    expect(deriveItemUrl(url("assignment_1").replace(HOST, "evil.com"), HOST)).toBeNull();
    expect(deriveItemUrl(url("assignment_1").replace("https:", "http:"), HOST)).toBeNull();
    expect(deriveItemUrl("javascript:alert(1)", HOST)).toBeNull();
    expect(deriveItemUrl(null, HOST)).toBeNull();
  });
});

describe("parseCanvasFeed — basic.ics", () => {
  const feed = parseFixture("basic.ics");

  it("parses every item with counts and the Canvas fingerprint", () => {
    expect(feed.items).toHaveLength(6);
    expect(feed.counts).toEqual({ assignments: 3, events: 3 });
    expect(feed.looksLikeCanvas).toBe(true);
    expect(feed.warnings).toEqual({
      duplicateUids: 0,
      skippedNoStart: 0,
      skippedNoUid: 0,
      capSaturated: { assignments: false, events: false },
    });
  });

  it("maps a timed assignment", () => {
    expect(item(feed, "event-assignment-412345")).toEqual({
      externalId: "event-assignment-412345",
      kind: "assignment",
      title: "Problem Set 4",
      course: "CPSC 323 01 (FA26)",
      startsAt: null,
      endsAt: null,
      dueAt: new Date("2026-10-16T21:00:00Z"),
      allDay: false,
      url: "https://yale.instructure.com/courses/98765/assignments/412345",
      timingKey: "U:20261016T210000Z",
      matchKey: "assignment_412345",
      raw: {
        uid: "event-assignment-412345",
        dtstart: "U:20261016T210000Z",
        dtend: "U:20261016T210000Z",
        calendar_url:
          "https://yale.instructure.com/calendar?include_contexts=course_98765&month=10&year=2026#assignment_412345",
        description:
          "Implement the shell described in the handout. Submit via Gradescope by the deadline. Late days apply per the syllabus.",
        dtstamp: "2026-10-10T12:00:00Z",
      },
    });
  });

  it("date-only assignment → 23:59 local (2026-10-16T03:59:00Z in New York, not 19:59 local)", () => {
    const essay = item(feed, "event-assignment-412400");
    expect(iso(essay.dueAt)).toBe("2026-10-16T03:59:00.000Z");
    expect(essay.allDay).toBe(true);
    expect(essay.timingKey).toBe("D:20261015");
    expect(essay.course).toBe("ENGL 120");
  });

  it("the same date in Los Angeles → 06:59Z", () => {
    expect(iso(item(parseFixture("basic.ics", LA), "event-assignment-412400").dueAt)).toBe("2026-10-16T06:59:00.000Z");
  });

  it("maps calendar events, an all-day account event, and exam inference", () => {
    const oh = item(feed, "event-calendar-event-77");
    expect([oh.kind, iso(oh.startsAt), iso(oh.endsAt), oh.dueAt, oh.matchKey]).toEqual([
      "event",
      "2026-10-14T19:00:00.000Z",
      "2026-10-14T20:00:00.000Z",
      null,
      "calendar_event_77",
    ]);
    const recess = item(feed, "event-calendar-event-80");
    expect([recess.course, recess.allDay, iso(recess.startsAt), iso(recess.endsAt)]).toEqual([
      null,
      true,
      "2026-10-17T04:00:00.000Z",
      "2026-10-18T04:00:00.000Z",
    ]);
    expect(recess.timingKey).toBe("D:20261017");
    expect(item(feed, "event-assignment-412500").kind).toBe("exam");
    expect(item(feed, "event-calendar-event-81").kind).toBe("event");
  });

  it("never stores X-ALT-DESC HTML", () => {
    expect(JSON.stringify(feed.items)).not.toContain("<p>");
  });
});

describe("parseCanvasFeed — overrides and sub-assignments", () => {
  it("an override keeps the base assignment's match key and moves the timing key", () => {
    const before = item(parseFixture("override-before.ics"), "event-assignment-500");
    const after = item(parseFixture("override-after.ics"), "event-assignment-override-77");
    expect(before.matchKey).toBe("assignment_500");
    expect(after.matchKey).toBe("assignment_500");
    expect(before.timingKey).toBe("D:20261015");
    expect(after.timingKey).toBe("D:20261018");
    expect(after.title).toBe("Pset 5 (Extension)");
    expect(after.kind).toBe("assignment");
    expect(after.url).toBe("https://yale.instructure.com/courses/98765/assignments/500");
  });

  it("sub-assignments get no match key (the parent's fragment isn't unique)", () => {
    const feed = parseFixture("subassignments.ics");
    expect(feed.items.map((i) => i.matchKey)).toEqual([null, null]);
    expect(feed.items.map((i) => i.kind)).toEqual(["assignment", "assignment"]);
    expect(feed.counts.assignments).toBe(2);
  });
});

describe("parseCanvasFeed — DST and time zones", () => {
  it("date-only assignments are 23:59 local on both DST transition days", () => {
    const feed = parseFixture("dst-ny.ics");
    expect(iso(item(feed, "event-assignment-600").dueAt)).toBe("2026-03-09T03:59:00.000Z"); // EDT
    expect(iso(item(feed, "event-assignment-601").dueAt)).toBe("2026-11-02T04:59:00.000Z"); // EST
    expect(iso(item(feed, "event-assignment-602").dueAt)).toBe("2026-11-01T05:59:00.000Z");
    expect(iso(item(feed, "event-assignment-603").dueAt)).toBe("2026-11-01T06:30:00.000Z");
  });

  it("all-day events span the local day: 23h in spring, 25h in fall", () => {
    const feed = parseFixture("dst-ny.ics");
    const spring = item(feed, "event-calendar-event-610");
    const fall = item(feed, "event-calendar-event-611");
    const hours = (i: TimelineItemInput) => ((i.endsAt as Date).getTime() - (i.startsAt as Date).getTime()) / 3_600_000;
    expect(iso(spring.startsAt)).toBe("2026-03-08T05:00:00.000Z");
    expect(hours(spring)).toBe(23);
    expect(iso(fall.startsAt)).toBe("2026-11-01T04:00:00.000Z");
    expect(hours(fall)).toBe(25);
  });

  it("converts TZID, floating, VTIMEZONE-only, and unknown TZIDs", () => {
    const feed = parseFixture("tz-variants.ics");
    expect(iso(item(feed, "event-calendar-event-700").startsAt)).toBe("2026-10-15T22:00:00.000Z");
    expect(iso(item(feed, "event-calendar-event-700").endsAt)).toBe("2026-10-15T23:30:00.000Z");
    expect(iso(item(feed, "event-calendar-event-701").startsAt)).toBe("2026-10-15T21:00:00.000Z"); // floating → user's zone
    expect(iso(item(feed, "event-calendar-event-702").startsAt)).toBe("2026-10-15T23:00:00.000Z"); // VTIMEZONE −06:00
    expect(iso(item(feed, "event-calendar-event-703").startsAt)).toBe("2026-10-15T21:00:00.000Z"); // unknown → floating
    const conf = item(feed, "event-calendar-event-704");
    expect([iso(conf.startsAt), iso(conf.endsAt)]).toEqual(["2026-10-23T04:00:00.000Z", "2026-10-26T04:00:00.000Z"]);
    const chi = item(feed, "event-assignment-705");
    expect([iso(chi.dueAt), chi.allDay, chi.timingKey]).toEqual([
      "2026-10-16T04:59:00.000Z",
      false,
      "Z:America/Chicago:20261015T235900",
    ]);
  });

  it("a time-zone change moves date-only instants but not the timing key", () => {
    const ny = item(parseFixture("basic.ics", NY), "event-assignment-412400");
    const la = item(parseFixture("basic.ics", LA), "event-assignment-412400");
    expect(ny.timingKey).toBe(la.timingKey);
    expect(iso(ny.dueAt)).not.toBe(iso(la.dueAt));
  });

  it("midnight-transition zones (Santiago, early September) start the day at the first valid instant", () => {
    const tz = "America/Santiago";
    let found = false;
    for (let day = 1; day <= 14; day++) {
      const t = resolveTiming("event", "calendar_event", { kind: "date", year: 2026, month: 9, day }, null, tz);
      const local = toLocal(t.startsAt as Date, tz);
      expect(local.day).toBe(day);
      if (local.hour !== 0) {
        found = true;
        expect(local.hour).toBe(1); // 00:00 doesn't exist; gap shifts forward
        expect(((t.endsAt as Date).getTime() - (t.startsAt as Date).getTime()) / 3_600_000).toBe(23);
      }
    }
    expect(found).toBe(true);
  });

  it("falls back to the default zone for an invalid user zone", () => {
    const essay = item(parseCanvasFeed(lexIcs(fixtureBytes("basic.ics")), { timezone: "Mars/Olympus", host: HOST }), "event-assignment-412400");
    expect(iso(essay.dueAt)).toBe("2026-10-16T03:59:00.000Z");
  });
});

describe("parseCanvasFeed — robustness", () => {
  it("duplicate UIDs: last in file order wins and is counted", () => {
    const feed = parseFixture("duplicates.ics");
    expect(feed.items.map((i) => i.externalId)).toEqual(["event-assignment-801", "event-assignment-800"]);
    expect(item(feed, "event-assignment-800").title).toBe("Response 1");
    expect(item(feed, "event-assignment-800").timingKey).toBe("D:20261014");
    expect(feed.warnings.duplicateUids).toBe(1);
  });

  it("an empty feed parses to nothing", () => {
    const feed = parseFixture("empty.ics");
    expect(feed.items).toEqual([]);
    expect(feed.looksLikeCanvas).toBe(true);
  });

  it("skips events without UID or DTSTART and caps field lengths", () => {
    const base: IcsEvent = { uid: "event-assignment-1", summary: "x", dtstart: { kind: "utc", iso: "2026-10-16T21:00:00Z" }, dtend: null, url: null, description: null, dtstamp: null };
    const cal: IcsCalendar = {
      prodid: "-//Google Inc//Google Calendar 70.9054//EN",
      calName: "Personal",
      parseWarnings: 0,
      events: [
        { ...base, uid: null },
        { ...base, uid: "event-assignment-2", dtstart: null },
        {
          ...base,
          uid: "event-assignment-3",
          summary: `${"T".repeat(400)} [${"C".repeat(150)}]`,
          description: `line1\nline2\u0007 ${"d".repeat(2000)}`,
          url: `https://${HOST}/calendar?x=${"a".repeat(3000)}`,
        },
      ],
    };
    const feed = parseCanvasFeed(cal, { timezone: NY, host: HOST });
    expect(feed.warnings.skippedNoUid).toBe(1);
    expect(feed.warnings.skippedNoStart).toBe(1);
    expect(feed.items).toHaveLength(1);
    const it3 = feed.items[0];
    expect(it3.title).toHaveLength(300);
    expect(it3.course).toHaveLength(100);
    expect(it3.url).toBeNull();
    const raw = it3.raw as { description: string; calendar_url: string };
    expect(raw.description.length).toBeLessThanOrEqual(1000);
    expect(raw.description.startsWith("line1 line2 ")).toBe(true);
    expect(raw.calendar_url.length).toBeLessThanOrEqual(2048);
    expect(feed.looksLikeCanvas).toBe(true); // Canvas-shaped UIDs
  });

  it("a non-Canvas feed doesn't look like Canvas", () => {
    const cal: IcsCalendar = {
      prodid: "-//Google Inc//Google Calendar 70.9054//EN",
      calName: "Personal",
      parseWarnings: 0,
      events: [{ uid: "abc123@google.com", summary: "Dinner", dtstart: { kind: "utc", iso: "2026-10-16T23:00:00Z" }, dtend: null, url: null, description: null, dtstamp: null }],
    };
    const feed = parseCanvasFeed(cal, { timezone: NY, host: "calendar.example.com" });
    expect(feed.looksLikeCanvas).toBe(false);
    expect(feed.items[0].kind).toBe("event");
    expect(feed.counts).toEqual({ assignments: 0, events: 1 });
  });

  it("flags cap saturation per kind at Canvas's 1,000 limit", () => {
    const at = parseCanvasFeed(lexIcs(generatedFeed(CANVAS_FEED_CAP)), { timezone: NY, host: HOST });
    expect(at.warnings.capSaturated).toEqual({ assignments: true, events: false });
    const below = parseCanvasFeed(lexIcs(generatedFeed(CANVAS_FEED_CAP - 1)), { timezone: NY, host: HOST });
    expect(below.warnings.capSaturated).toEqual({ assignments: false, events: false });
    const events = parseCanvasFeed(lexIcs(generatedFeed(CANVAS_FEED_CAP, "calendar-event")), { timezone: NY, host: HOST });
    expect(events.warnings.capSaturated).toEqual({ assignments: false, events: true });
  });

  it("lexes and parses 2,000 events in under 500 ms", () => {
    const bytes = generatedFeed(2000);
    lexIcs(generatedFeed(10)); // warm up
    const t0 = performance.now();
    const feed = parseCanvasFeed(lexIcs(bytes), { timezone: NY, host: HOST });
    const ms = performance.now() - t0;
    expect(feed.items).toHaveLength(2000);
    expect(ms).toBeLessThan(500);
  });
});
