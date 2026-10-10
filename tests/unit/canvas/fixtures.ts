/**
 * Fixture loader for Canvas unit tests (not a test file).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "..", "fixtures", "canvas");

/**
 * Raw bytes of a fixture in tests/fixtures/canvas.
 * @param name file name, e.g. "basic.ics"
 * @returns file contents
 */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIR, name)));
}

/**
 * A synthetic Canvas feed with `n` events (CRLF, Canvas header).
 * @param n number of VEVENTs
 * @param kind UID family to generate
 * @returns feed bytes
 */
export function generatedFeed(n: number, kind: "assignment" | "calendar-event" = "assignment"): Uint8Array {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:icalendar-ruby",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Test Student Calendar (Canvas)",
  ];
  for (let i = 0; i < n; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    lines.push(
      "BEGIN:VEVENT",
      "DTSTAMP:20261010T120000Z",
      i % 2 === 0 ? `DTSTART;VALUE=DATE:202611${day}` : `DTSTART:202611${day}T210000Z`,
      `SUMMARY:Item ${i} [CPSC ${100 + (i % 7)}]`,
      `URL;VALUE=URI:https://yale.instructure.com/calendar?include_contexts=course_${i % 7}&month=11&year=2026#${kind === "assignment" ? "assignment" : "calendar_event"}_${10_000 + i}`,
      `UID:event-${kind}-${10_000 + i}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR", "");
  return new TextEncoder().encode(lines.join("\r\n"));
}
