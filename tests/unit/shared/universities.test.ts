/**
 * Unit tests for src/shared/universities.ts (V2-05 §10.2). Run: npm test
 */
import {
  OTHER_UNIVERSITY,
  UNIVERSITIES,
  canvasBaseUrlForUniversity,
  canvasCalendarUrlForUniversity,
  canvasHostForSchool,
  isListedCanvasHost,
  normalizeCanvasHost,
  universityForCanvasHost,
} from "@/shared/universities";

describe("UNIVERSITIES list", () => {
  it("is sorted by name and has no duplicate names or domains", () => {
    const names = UNIVERSITIES.map((u) => u.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, "en"));
    expect(names).toEqual(sorted);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(UNIVERSITIES.map((u) => u.canvasDomain)).size).toBe(UNIVERSITIES.length);
  });

  it("has 51 schools (52 salvaged minus Vanderbilt), lower-case hosts, no Other entry", () => {
    expect(UNIVERSITIES).toHaveLength(51);
    for (const u of UNIVERSITIES) {
      expect(u.canvasDomain).toBe(u.canvasDomain.toLowerCase());
      expect(u.canvasDomain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(normalizeCanvasHost(u.canvasDomain)).toBe(u.canvasDomain);
    }
    expect(UNIVERSITIES.some((u) => u.name === OTHER_UNIVERSITY)).toBe(false);
    expect(OTHER_UNIVERSITY).toBe("Other");
  });

  it("applies the V2-05 §3.9 host corrections", () => {
    expect(canvasHostForSchool("Columbia University")).toBe("courseworks2.columbia.edu");
    expect(canvasHostForSchool("Penn State University")).toBe("psu.instructure.com");
    expect(canvasHostForSchool("Princeton University")).toBe("princeton.instructure.com");
    expect(canvasHostForSchool("University of Virginia")).toBe("canvas.its.virginia.edu");
    expect(canvasHostForSchool("University of Arizona")).toBe("arizona.instructure.com");
    expect(UNIVERSITIES.some((u) => /vanderbilt/i.test(u.name) || /vanderbilt/.test(u.canvasDomain))).toBe(false);
    for (const stale of ["canvas.columbia.edu", "canvas.psu.edu", "canvas.princeton.edu", "canvas.virginia.edu", "canvas.arizona.edu"]) {
      expect(isListedCanvasHost(stale)).toBe(false);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(UNIVERSITIES)).toBe(true);
    expect(Object.isFrozen(UNIVERSITIES[0])).toBe(true);
  });
});

describe("school lookups", () => {
  it("canvasHostForSchool is case- and space-insensitive", () => {
    expect(canvasHostForSchool("yale university ")).toBe("yale.instructure.com");
    expect(canvasHostForSchool("  YALE   University")).toBe("yale.instructure.com");
    expect(canvasHostForSchool("Other")).toBeNull();
    expect(canvasHostForSchool("Hogwarts")).toBeNull();
    expect(canvasHostForSchool(null)).toBeNull();
    expect(canvasHostForSchool("")).toBeNull();
  });

  it("builds base and calendar URLs", () => {
    expect(canvasBaseUrlForUniversity("Yale University")).toBe("https://yale.instructure.com");
    expect(canvasCalendarUrlForUniversity("UC Berkeley")).toBe("https://bcourses.berkeley.edu/calendar");
    expect(canvasBaseUrlForUniversity(null)).toBeNull();
    expect(canvasCalendarUrlForUniversity("Other")).toBeNull();
  });

  it("isListedCanvasHost / universityForCanvasHost match exactly (no suffix tricks)", () => {
    expect(isListedCanvasHost("canvas.harvard.edu")).toBe(true);
    expect(isListedCanvasHost("CANVAS.HARVARD.EDU.")).toBe(true);
    expect(isListedCanvasHost("evil.canvas.harvard.edu")).toBe(false);
    expect(isListedCanvasHost("canvas.harvard.edu.evil.com")).toBe(false);
    expect(universityForCanvasHost("yale.instructure.com")?.name).toBe("Yale University");
    expect(universityForCanvasHost("nope.example.edu")).toBeNull();
  });
});

describe("normalizeCanvasHost", () => {
  it.each([
    ["https://Canvas.Harvard.edu/calendar", "canvas.harvard.edu"],
    ["yale.instructure.com.", "yale.instructure.com"],
    ["x.edu", "x.edu"],
    ["  webcal://yale.instructure.com/feeds/calendars/user_abc.ics  ", "yale.instructure.com"],
    ["https://bcourses.berkeley.edu:443/", "bcourses.berkeley.edu"],
  ])("%s → %s", (input, host) => {
    expect(normalizeCanvasHost(input)).toBe(host);
  });

  it.each([[""], ["   "], ["localhost"], ["https://127.0.0.1/"], ["https://[::1]/"], ["https://u:p@x.edu/"], ["not a host"]])(
    "%s → null",
    (input) => {
      expect(normalizeCanvasHost(input)).toBeNull();
    },
  );
});
