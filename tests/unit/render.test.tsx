/**
 * Static render checks for the /week pieces (web plan §10 render.test, W7): load bar labels,
 * external links only for safe URLs, hostile titles escaped, all-day items on the right day.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalLink } from "@/app/_components/ExternalLink";
import { DayGroup } from "@/app/(app)/week/DayGroup";
import { LoadBar } from "@/app/(app)/week/LoadBar";
import { groupWeek, type WeekDay, type WeekItem } from "@/shared/week";

// The toggle imports the server action module; rendering never calls it.
jest.mock("@/app/(app)/week/actions", () => ({ setItemStatusAction: jest.fn() }));

const TZ = "America/New_York";
const HOSTS = ["*.instructure.com", "calendar.google.com", "www.google.com"];
const HOSTILE = `<img src=x onerror=alert(1)>`;

function item(over: Partial<WeekItem>): WeekItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source: "canvas",
    kind: "assignment",
    title: "Pset 3",
    course: "CPSC 323",
    startsAt: null,
    endsAt: null,
    dueAt: "2026-10-14T03:59:00.000Z",
    allDay: false,
    allDayDate: null,
    url: null,
    status: "upcoming",
    ...over,
  };
}

function day(over: Partial<WeekDay>): WeekDay {
  return { key: "2026-10-13", label: "Tue, Oct 13", load: "light", points: 0, deadlines: [], schedule: [], ...over };
}

describe("LoadBar", () => {
  it("shows the text label and exposes it as the accessible name", () => {
    const html = renderToStaticMarkup(<LoadBar level="busy" points={2} label="Busy day: 2 things due" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Busy day: 2 things due"');
    expect(html).toContain(">Busy day: 2 things due<");
    expect(html).toContain('data-level="busy"');
    expect((html.match(/bg-load-busy/g) ?? []).length).toBe(2);
  });

  it("fills one segment for light and three for heavy", () => {
    expect((renderToStaticMarkup(<LoadBar level="light" points={0} label="Light day" />).match(/bg-load-light/g) ?? []).length).toBe(1);
    expect((renderToStaticMarkup(<LoadBar level="heavy" points={4} label="Heavy day: 3 things due" />).match(/bg-load-heavy/g) ?? []).length).toBe(3);
  });
});

describe("ExternalLink", () => {
  it("renders no <a> for an unsafe URL", () => {
    for (const href of ["javascript:alert(1)", "http://yale.instructure.com/x", "https://evil.example/x", "data:text/html,x"]) {
      const html = renderToStaticMarkup(
        <ExternalLink href={href} allowHosts={HOSTS}>
          Open
        </ExternalLink>,
      );
      expect(html).not.toContain("<a");
      expect(html).toContain("Open");
    }
  });

  it("renders a new-tab, noopener link for an allowed host", () => {
    const html = renderToStaticMarkup(
      <ExternalLink href="https://yale.instructure.com/courses/1/assignments/2" allowHosts={HOSTS}>
        Open
      </ExternalLink>,
    );
    expect(html).toContain('href="https://yale.instructure.com/courses/1/assignments/2"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});

describe("DayGroup", () => {
  it("escapes a hostile title and course (no tag injected)", () => {
    const html = renderToStaticMarkup(
      <DayGroup
        day={day({ deadlines: [item({ title: HOSTILE, course: `<script>x</script>` })], load: "light", points: 1 })}
        timeZone={TZ}
        allowHosts={HOSTS}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain(`aria-label="Mark &quot;&lt;img src=x onerror=alert(1)&gt;&quot; done"`);
  });

  it("links only safe Canvas URLs and never a bad one", () => {
    const safe = renderToStaticMarkup(
      <DayGroup
        day={day({ deadlines: [item({ url: "https://yale.instructure.com/courses/1/assignments/2" })] })}
        timeZone={TZ}
        allowHosts={HOSTS}
      />,
    );
    expect(safe).toContain('href="https://yale.instructure.com/courses/1/assignments/2"');
    expect(safe).toContain("Open in Canvas");

    const bad = renderToStaticMarkup(
      <DayGroup day={day({ deadlines: [item({ url: "javascript:alert(1)" })] })} timeZone={TZ} allowHosts={HOSTS} />,
    );
    expect(bad).not.toContain("<a");
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain("Open in Canvas");
  });

  it("renders the due line, day load label, done state, and schedule rows", () => {
    const html = renderToStaticMarkup(
      <DayGroup
        day={day({
          load: "busy",
          points: 2,
          deadlines: [
            item({ id: "00000000-0000-4000-8000-0000000000a1" }),
            item({ id: "00000000-0000-4000-8000-0000000000a2", title: "Essay", kind: "assignment", status: "done" }),
          ],
          schedule: [
            item({
              id: "00000000-0000-4000-8000-0000000000b1",
              source: "gcal",
              kind: "class",
              title: "Lecture",
              dueAt: null,
              startsAt: "2026-10-13T14:30:00.000Z",
              endsAt: "2026-10-13T15:45:00.000Z",
            }),
          ],
        })}
        timeZone={TZ}
        allowHosts={HOSTS}
      />,
    );
    expect(html).toContain("Due 11:59 PM");
    expect(html).toContain('aria-label="Busy day: 1 thing due"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Mark &quot;Essay&quot; not done"');
    expect(html).toContain("Undo");
    expect(html).toContain("10:30–11:45 AM · </span>Lecture");
  });

  it("puts an all-day item on its floating date and says so", () => {
    // All-day Canvas item for Oct 14, stored at a UTC instant that is Oct 13 evening in Honolulu.
    const allDay = item({ allDay: true, allDayDate: "2026-10-14", dueAt: "2026-10-14T04:00:00.000Z", title: "Quiz" });
    const week = groupWeek([allDay], { timeZone: "Pacific/Honolulu", now: new Date("2026-10-12T20:00:00Z"), offsetWeeks: 0 });
    const target = week.days.find((d) => d.deadlines.length > 0);
    expect(target?.key).toBe("2026-10-14");
    const html = renderToStaticMarkup(<DayGroup day={target as WeekDay} timeZone="Pacific/Honolulu" allowHosts={HOSTS} />);
    expect(html).toContain("Due (all day)");
    expect(html).toContain('data-day="2026-10-14"');
  });

  it("says nothing is due on an empty day", () => {
    const html = renderToStaticMarkup(<DayGroup day={day({})} timeZone={TZ} allowHosts={HOSTS} />);
    expect(html).toContain("Nothing due.");
    expect(html).toContain('aria-label="Light day"');
  });
});
