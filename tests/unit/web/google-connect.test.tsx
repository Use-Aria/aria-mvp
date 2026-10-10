/**
 * /setup Google section (task 4.5, web plan §11 W6; master plan §1.12 C20): every `?google=`
 * code has a banner, `missing_scopes` is disambiguated by the current status, the connect
 * control is a plain GET `<a href="/api/google/oauth">` shown only for a fresh session, and the
 * disclosure renders before it.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoogleStatusView } from "@/server/integrations/google";
import { GOOGLE_CONNECT_CODES, GOOGLE_STATUS_COPY } from "@/shared/copy";

jest.mock("@/app/_components/FreshLinkNotice", () => ({
  FreshLinkNotice: ({ keyword }: { keyword: string }): ReactNode => <p data-testid="fresh">fresh-link:{keyword}</p>,
}));
jest.mock("@/app/(app)/setup/integration-actions", () => ({
  connectCanvasAction: jest.fn(),
  disconnectCanvasAction: jest.fn(),
  disconnectGoogleAction: jest.fn(),
  disconnectGoogleFormAction: jest.fn(),
}));

import {
  GOOGLE_OAUTH_START,
  GoogleConnect,
  NOTHING_GRANTED_TEXT,
  SAFARI_NOTE,
  googleBanner,
  joinOr,
  missingCapabilities,
} from "@/app/(app)/setup/GoogleConnect";

const NONE: GoogleStatusView = { connected: false, reason: "none" };
const FULL: GoogleStatusView = {
  connected: true,
  email: "dan@gmail.com",
  features: ["calendar_read", "calendar_write", "gmail_read", "gmail_send"],
  canReadMail: true,
  canSendMail: true,
  canReadCalendar: true,
  canWriteAriaCalendar: true,
  connectedAt: new Date("2026-10-10T12:00:00Z"),
};
const PARTIAL: GoogleStatusView = {
  ...FULL,
  features: ["calendar_read", "gmail_read"],
  canSendMail: false,
  canWriteAriaCalendar: false,
};

describe("googleBanner", () => {
  it("has a non-empty message for every code, connected or not", () => {
    for (const code of GOOGLE_CONNECT_CODES) {
      for (const status of [NONE, FULL, PARTIAL]) {
        const b = googleBanner(code, status);
        expect(b?.text.length).toBeGreaterThan(10);
        expect(b?.text).not.toMatch(/\{(email|missing)\}/);
      }
    }
    expect(googleBanner(null, FULL)).toBeNull();
  });

  it("connected: names the account; falls back to the error copy if the status disagrees", () => {
    expect(googleBanner("connected", FULL)).toEqual({ tone: "ok", text: "Google connected as dan@gmail.com." });
    expect(googleBanner("connected", NONE)).toEqual(GOOGLE_STATUS_COPY.error);
  });

  it("missing_scopes: lists exactly what's missing for a partial grant", () => {
    expect(googleBanner("missing_scopes", PARTIAL)?.text).toBe(
      "Google connected, but some boxes were unchecked, so Aria can't send email for you or add study blocks. Tap Connect Google again and check every box.",
    );
  });

  it("missing_scopes: nothing granted (not connected) gets its own message", () => {
    expect(googleBanner("missing_scopes", NONE)).toEqual({ tone: "warn", text: NOTHING_GRANTED_TEXT });
    expect(googleBanner("missing_scopes", { connected: false, reason: "revoked" })?.text).toBe(NOTHING_GRANTED_TEXT);
  });

  it("missing_scopes: a full grant since then reads as connected", () => {
    expect(googleBanner("missing_scopes", FULL)?.tone).toBe("ok");
  });

  it("other codes use the copy deck as is", () => {
    for (const code of ["denied", "admin_blocked", "stale", "expired", "account_in_use", "error"] as const) {
      expect(googleBanner(code, NONE)).toEqual(GOOGLE_STATUS_COPY[code]);
    }
  });

  it("strips spoofing characters from the account email", () => {
    expect(googleBanner("connected", { ...FULL, email: "dan‮@gmail.com" })?.text).toBe("Google connected as dan@gmail.com.");
  });
});

describe("missingCapabilities / joinOr", () => {
  it("lists missing capabilities in display order", () => {
    expect(missingCapabilities(PARTIAL)).toEqual(["sendMail", "writeAriaCalendar"]);
    expect(missingCapabilities(FULL)).toEqual([]);
    expect(missingCapabilities(NONE)).toEqual([]);
  });

  it("joins with or", () => {
    expect(joinOr([])).toBe("");
    expect(joinOr(["a"])).toBe("a");
    expect(joinOr(["a", "b"])).toBe("a or b");
    expect(joinOr(["a", "b", "c"])).toBe("a, b, or c");
  });
});

describe("GoogleConnect render", () => {
  const render = (status: GoogleStatusView, canChange: boolean, banner: Parameters<typeof GoogleConnect>[0]["banner"] = null) =>
    renderToStaticMarkup(<GoogleConnect status={status} canChange={canChange} banner={banner} />);

  it("fresh session, not connected: disclosure, then a plain GET <a> to the OAuth start, plus the Safari note", () => {
    const html = render(NONE, true);
    const link = `<a href="${GOOGLE_OAUTH_START}"`;
    expect(html).toContain(link);
    expect(html).not.toMatch(/<form[^>]*action="\/api\/google/);
    expect(html.indexOf("What Aria reads:")).toBeGreaterThan(-1);
    expect(html.indexOf("What Aria reads:")).toBeLessThan(html.indexOf(link));
    expect(html.indexOf("Google will show a warning.")).toBeLessThan(html.indexOf(link));
    expect(html).toContain(SAFARI_NOTE);
    expect(html).not.toContain("fresh-link");
  });

  it("stale or view session: no connect link, the fresh-link notice instead", () => {
    const html = render(NONE, false);
    expect(html).not.toContain(GOOGLE_OAUTH_START);
    expect(html).toContain("fresh-link:setup");
  });

  it("connected: capabilities with ✓/✗, disconnect dialog, reconnect link only when scopes are missing", () => {
    const full = render(FULL, true);
    expect(full).toContain("Connected as dan@gmail.com");
    expect(full).toContain("Disconnect Google?");
    expect(full).not.toContain(GOOGLE_OAUTH_START);
    const partial = render(PARTIAL, true);
    expect(partial).toContain(GOOGLE_OAUTH_START);
    expect(partial).toContain("(not allowed)");
  });

  it("revoked/error status shows the needs-reconnect message", () => {
    expect(render({ connected: false, reason: "revoked" }, true)).toContain("Google stopped working for Aria.");
    expect(render(NONE, true)).not.toContain("Google stopped working for Aria.");
  });

  it("renders the callback banner", () => {
    expect(render(PARTIAL, true, "missing_scopes")).toContain("so Aria can&#x27;t send email for you or add study blocks");
    expect(render(NONE, true, "denied")).toContain("You canceled Google sign-in");
  });
});
