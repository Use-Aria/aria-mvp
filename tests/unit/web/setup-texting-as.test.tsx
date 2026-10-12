/**
 * /setup "Texting as ••• ••• 1234" (5.5 #13): a forwarded setup link signs the reader in as the
 * sender, so the Google section shows the account's masked handle before anyone connects.
 * `textingAsView` masks through `maskHandle` (never more than the logs show); the line renders
 * only with a fresh session, next to the connect control, with screen-reader text instead of bullets.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoogleStatusView } from "@/server/integrations/google";
import { textingAsView } from "@/server/web/setup-data";
import { SETUP_COPY } from "@/shared/copy";

jest.mock("@/server/db", () => ({ db: () => ({}) }));
jest.mock("@/server/integrations/canvas", () => ({ getCanvasStatus: jest.fn() }));
jest.mock("@/server/integrations/google", () => ({ getGoogleStatus: jest.fn() }));
jest.mock("@/app/_components/FreshLinkNotice", () => ({
  FreshLinkNotice: ({ keyword }: { keyword: string }): ReactNode => <p data-testid="fresh">fresh-link:{keyword}</p>,
}));
jest.mock("@/app/(app)/setup/integration-actions", () => ({
  connectCanvasAction: jest.fn(),
  disconnectCanvasAction: jest.fn(),
  disconnectGoogleAction: jest.fn(),
  disconnectGoogleFormAction: jest.fn(),
}));

import { GOOGLE_OAUTH_START, GoogleConnect } from "@/app/(app)/setup/GoogleConnect";

const NONE: GoogleStatusView = { connected: false, reason: "none" };

describe("textingAsView", () => {
  it("phone → last 4 digits only", () => {
    expect(textingAsView("+12035550142")).toEqual({ kind: "phone", last4: "0142" });
  });
  it("Apple ID email → domain only", () => {
    expect(textingAsView("sam.lee@icloud.com")).toEqual({ kind: "email", domain: "icloud.com" });
  });
  it("nothing known → null", () => {
    expect(textingAsView(null)).toBeNull();
    expect(textingAsView("")).toBeNull();
    expect(textingAsView("wa_abc")).toBeNull();
  });
});

describe("copy", () => {
  it("masks a phone as ••• ••• 1234 and speaks it as words", () => {
    const c = SETUP_COPY.google.textingAs;
    expect(c.phoneMasked("1234")).toBe("••• ••• 1234");
    expect(c.phoneSpoken("1234")).toBe("the number ending in 1234");
    expect(c.emailMasked("icloud.com")).toBe("•••@icloud.com");
    expect(c.notYou).toMatch(/setup/);
  });
});

describe("GoogleConnect texting-as line", () => {
  const html = (canChange: boolean, textingAs: ReturnType<typeof textingAsView>) =>
    renderToStaticMarkup(<GoogleConnect status={NONE} canChange={canChange} banner={null} textingAs={textingAs} />);

  it("fresh session: shows the masked phone before the Connect Google link, bullets hidden from screen readers", () => {
    const out = html(true, { kind: "phone", last4: "0142" });
    expect(out).toContain('data-testid="texting-as"');
    expect(out).toContain('<span aria-hidden="true" class="whitespace-nowrap">••• ••• 0142</span>');
    expect(out).toContain('<span class="sr-only">the number ending in 0142</span>');
    expect(out).toContain("Texting as");
    expect(out.indexOf("texting-as")).toBeLessThan(out.indexOf(`href="${GOOGLE_OAUTH_START}"`));
    expect(out).not.toContain("+1203");
  });

  it("view-only session or unknown handle: no line", () => {
    expect(html(false, { kind: "phone", last4: "0142" })).not.toContain("texting-as");
    expect(html(true, null)).not.toContain("texting-as");
  });
});
