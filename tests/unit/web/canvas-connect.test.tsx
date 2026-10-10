/**
 * /setup Canvas section (task 4.5, web plan §11 W5): school → guide host, field vs. banner error
 * placement, success copy, and the static render for fresh / stale / connected sessions.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { CanvasStatusView } from "@/server/integrations/canvas";
import { ACTION_ERROR_CODES, CANVAS_CONNECT_ERROR_CODES } from "@/shared/action-result";
import { SHARED_COPY } from "@/shared/copy";
import { OTHER_UNIVERSITY } from "@/shared/universities";

jest.mock("@/app/(app)/setup/integration-actions", () => ({
  connectCanvasAction: jest.fn(),
  disconnectCanvasAction: jest.fn(),
}));

import { CanvasConnect, connectedNotice, guideHost, initialSchool, isFieldError } from "@/app/(app)/setup/CanvasConnect";

const NONE: CanvasStatusView = { connected: false };
const OK: CanvasStatusView = {
  connected: true,
  host: "yale.instructure.com",
  urlHint: "yale.instructure.com/feeds/…a1b2",
  syncedAt: new Date("2026-10-10T20:10:00Z"),
  nextSyncAt: null,
  health: "ok",
  lastError: null,
  upcomingCount: 4,
};

describe("initialSchool / guideHost", () => {
  it("starts on the listed profile school, else the connected host's school, else Other/none", () => {
    expect(initialSchool("Yale University", NONE)).toBe("Yale University");
    expect(initialSchool("yale university ", NONE)).toBe("Yale University");
    expect(initialSchool("Some College", NONE)).toBe("");
    expect(initialSchool(null, OK)).toBe("Yale University");
    expect(initialSchool(null, { ...OK, host: "canvas.someschool.edu" })).toBe(OTHER_UNIVERSITY);
  });

  it("resolves the guide host from the picker or the typed Canvas address", () => {
    expect(guideHost("Yale University", "")).toBe("yale.instructure.com");
    expect(guideHost(OTHER_UNIVERSITY, "https://Canvas.MySchool.edu/calendar")).toBe("canvas.myschool.edu");
    expect(guideHost(OTHER_UNIVERSITY, "javascript:alert(1)")).toBeNull();
    expect(guideHost(OTHER_UNIVERSITY, "")).toBeNull();
    expect(guideHost("", "")).toBeNull();
  });
});

describe("isFieldError / connectedNotice", () => {
  it("puts URL/feed problems on the field and everything else in a banner", () => {
    for (const code of CANVAS_CONNECT_ERROR_CODES) {
      expect(isFieldError(code)).toBe(code !== "internal" && code !== "rate_limited");
    }
    for (const code of ["needs_fresh_link", "signed_out", "bad_origin", "server"] as const) expect(isFieldError(code)).toBe(false);
    expect(ACTION_ERROR_CODES.length).toBeGreaterThan(CANVAS_CONNECT_ERROR_CODES.length);
  });

  it("success copy counts upcoming deadlines", () => {
    expect(connectedNotice({ host: "h", itemCount: 9, upcomingCount: 3 })).toEqual({
      tone: "ok",
      text: "Canvas connected. Aria found 3 things due in the next two weeks.",
      seeWeek: true,
    });
    expect(connectedNotice({ host: "h", itemCount: 0, upcomingCount: 0 }).text).toMatch(/Nothing's due/);
  });
});

describe("CanvasConnect render", () => {
  it("fresh session, not connected: picker, guide link for the school, and the paste form", () => {
    const html = renderToStaticMarkup(<CanvasConnect school="Yale University" status={NONE} canChange />);
    expect(html).toContain('href="https://yale.instructure.com/calendar"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('name="url"');
    expect(html).toMatch(/name="url"[^>]*autoComplete="off"|autoComplete="off"[^>]*name="url"/);
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('name="school" value="Yale University"');
    expect(html).toContain("Connect Canvas");
    expect(html).not.toContain(SHARED_COPY.freshLinkNeeded);
  });

  it("stale session: guide but no paste form, plus the fresh-link notice", () => {
    const html = renderToStaticMarkup(<CanvasConnect school={null} status={NONE} canChange={false} />);
    expect(html).not.toContain('name="url"');
    expect(html).toContain("Get your Canvas calendar link");
    expect(html).toContain("For your security, connecting or removing accounts needs a fresh link.");
  });

  it("stale session with a freshNotice slot: renders the slot instead of the text-only notice", () => {
    const html = renderToStaticMarkup(
      <CanvasConnect school={null} status={NONE} canChange={false} freshNotice={<div data-testid="slot">server notice</div>} />,
    );
    expect(html).toContain('data-testid="slot"');
    expect(html).toContain("server notice");
    expect(html).not.toContain(SHARED_COPY.freshLinkNeeded);
    expect(html).not.toContain('name="url"');
  });

  it("fresh session ignores the freshNotice slot", () => {
    const html = renderToStaticMarkup(
      <CanvasConnect school="Yale University" status={NONE} canChange freshNotice={<div data-testid="slot" />} />,
    );
    expect(html).not.toContain('data-testid="slot"');
    expect(html).toContain('name="url"');
  });

  it("connected and healthy: status, URL hint, 'Use a different link' and Disconnect; no form until asked", () => {
    const html = renderToStaticMarkup(<CanvasConnect school={null} status={OK} canChange />);
    expect(html).toContain("Connected to yale.instructure.com");
    expect(html).toContain("yale.instructure.com/feeds/…a1b2");
    expect(html).toContain("Use a different link");
    expect(html).toContain("Disconnect Canvas?");
    expect(html).not.toContain('name="url"');
  });

  it("failing feed: warning with the last error and the paste form", () => {
    const html = renderToStaticMarkup(
      <CanvasConnect school={null} status={{ ...OK, health: "failing", lastError: "feed_not_found" }} canChange />,
    );
    expect(html).toContain("Aria couldn&#x27;t read your Canvas feed since");
    expect(html).toContain("Canvas says that feed doesn&#x27;t exist.");
    expect(html).toContain('name="url"');
  });
});
