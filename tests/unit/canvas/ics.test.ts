/**
 * Unit tests for src/server/integrations/canvas/ics.ts (V2-05 §2.2, §10.2). Run: npm test
 */
import { IcsParseError, lexIcs, timingKeyOf, type IcsEvent } from "@/server/integrations/canvas/ics";
import { fixtureBytes } from "./fixtures";

function byUid(events: IcsEvent[], uid: string): IcsEvent {
  const ev = events.find((e) => e.uid === uid);
  if (!ev) throw new Error(`missing ${uid}`);
  return ev;
}

describe("lexIcs", () => {
  it("reads the Canvas header and every event of basic.ics", () => {
    const cal = lexIcs(fixtureBytes("basic.ics"));
    expect(cal.prodid).toBe("icalendar-ruby");
    expect(cal.calName).toBe("Test Student Calendar (Canvas)");
    expect(cal.parseWarnings).toBe(0);
    expect(cal.events.map((e) => e.uid)).toEqual([
      "event-assignment-412345",
      "event-assignment-412400",
      "event-calendar-event-77",
      "event-calendar-event-80",
      "event-assignment-412500",
      "event-calendar-event-81",
    ]);
    const ps4 = byUid(cal.events, "event-assignment-412345");
    expect(ps4.summary).toBe("Problem Set 4 [CPSC 323 01 (FA26)]");
    expect(ps4.dtstart).toEqual({ kind: "utc", iso: "2026-10-16T21:00:00Z" });
    expect(ps4.url).toBe(
      "https://yale.instructure.com/calendar?include_contexts=course_98765&month=10&year=2026#assignment_412345",
    );
    expect(ps4.description).toContain("Implement the shell");
    expect(ps4.dtstamp).toBe("2026-10-10T12:00:00Z");
  });

  it("maps VALUE=DATE (no DTEND) and plain URL: properties", () => {
    const cal = lexIcs(fixtureBytes("basic.ics"));
    const essay = byUid(cal.events, "event-assignment-412400");
    expect(essay.dtstart).toEqual({ kind: "date", year: 2026, month: 10, day: 15 });
    expect(essay.dtend).toBeNull();
    expect(essay.url).toMatch(/#assignment_412400$/);
  });

  it("unfolds at the byte level, so a fold inside a multi-byte char keeps é", () => {
    const cal = lexIcs(fixtureBytes("escapes-folding.ics"));
    const ev = byUid(cal.events, "event-assignment-1001");
    expect(ev.summary).toMatch(/Café, crème ; notes\nline \[FREN 110\]$/);
    expect(ev.summary).not.toContain("�");
    const lab = byUid(cal.events, "event-assignment-1002");
    expect(lab.summary).toBe("Lab [Part 2] [CHEM 134L]");
    expect(lab.description).toContain("Résumé of the procedure: titrate, record, repeat.");
  });

  it("maps TZID (IANA), floating, VTIMEZONE-only, and unknown TZIDs", () => {
    const cal = lexIcs(fixtureBytes("tz-variants.ics"));
    const wall = { year: 2026, month: 10, day: 15, hour: 17, minute: 0, second: 0 };
    expect(byUid(cal.events, "event-calendar-event-700").dtstart).toEqual({
      kind: "zoned",
      tzid: "America/Chicago",
      wall,
      utcFromVtimezone: null,
    });
    expect(byUid(cal.events, "event-calendar-event-701").dtstart).toEqual({ kind: "floating", wall });
    expect(byUid(cal.events, "event-calendar-event-702").dtstart).toEqual({
      kind: "zoned",
      tzid: "Custom/Zone",
      wall,
      utcFromVtimezone: "2026-10-15T23:00:00Z", // VTIMEZONE fixed at -0600
    });
    expect(byUid(cal.events, "event-calendar-event-703").dtstart).toEqual({
      kind: "zoned",
      tzid: "Not/AZone",
      wall,
      utcFromVtimezone: null,
    });
    expect(byUid(cal.events, "event-calendar-event-704").dtend).toEqual({ kind: "date", year: 2026, month: 10, day: 26 });
  });

  it("accepts LF-only line endings and a BOM", () => {
    const text = "﻿BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20261016T210000Z\nSUMMARY:Hi\n  there\nEND:VEVENT\nEND:VCALENDAR\n";
    const cal = lexIcs(new TextEncoder().encode(text));
    expect(cal.events).toHaveLength(1);
    expect(cal.events[0].summary).toBe("Hi there");
  });

  it("returns no events for an empty calendar", () => {
    const cal = lexIcs(fixtureBytes("empty.ics"));
    expect(cal.events).toEqual([]);
    expect(cal.calName).toBe("Test Student Calendar (Canvas)");
  });

  it("throws IcsParseError on HTML and garbage", () => {
    expect(() => lexIcs(fixtureBytes("unauthorized-feed.html"))).toThrow(IcsParseError);
    expect(() => lexIcs(new TextEncoder().encode(""))).toThrow(IcsParseError);
    expect(() => lexIcs(new TextEncoder().encode("{\"error\":1}"))).toThrow(IcsParseError);
  });

  it("skips a malformed event instead of dropping the whole feed", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:icalendar-ruby",
      "BEGIN:VEVENT",
      "UID:event-assignment-1",
      "DTSTART:20261016T210000Z",
      "SUMMARY:Good [A 1]",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:event-assignment-2",
      "this line has no colon or semicolon",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:event-assignment-3",
      "DTSTART:20261017T210000Z",
      "SUMMARY:Also good [A 1]",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const cal = lexIcs(new TextEncoder().encode(text));
    expect(cal.events.map((e) => e.uid)).toEqual(["event-assignment-1", "event-assignment-3"]);
    expect(cal.parseWarnings).toBe(1);
    expect(cal.prodid).toBe("icalendar-ruby");
  });

  it("counts an unreadable DTSTART value as a warning, not a crash", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:event-assignment-9",
      "DTSTART;VALUE=DATE:20261345",
      "DTEND:20261016T256100Z",
      "SUMMARY:Bad date",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const cal = lexIcs(new TextEncoder().encode(text));
    expect(cal.events).toEqual([]); // ical.js would have normalized it to 2027-02-14
    expect(cal.parseWarnings).toBe(1);
  });
});

describe("timingKeyOf", () => {
  const wall = { year: 2026, month: 10, day: 15, hour: 17, minute: 0, second: 0 };
  it.each([
    [{ kind: "date" as const, year: 2026, month: 10, day: 15 }, "D:20261015"],
    [{ kind: "utc" as const, iso: "2026-10-16T03:59:00Z" }, "U:20261016T035900Z"],
    [{ kind: "utc" as const, iso: "2026-10-16T03:59:00.000Z" }, "U:20261016T035900Z"],
    [{ kind: "zoned" as const, tzid: "America/Chicago", wall, utcFromVtimezone: null }, "Z:America/Chicago:20261015T170000"],
    [{ kind: "floating" as const, wall }, "F:20261015T170000"],
  ])("%j → %s", (v, key) => {
    expect(timingKeyOf(v)).toBe(key);
  });
});
