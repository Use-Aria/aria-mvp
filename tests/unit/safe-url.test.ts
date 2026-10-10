/** Display-safety helpers (web plan §10 safe-url.test). */
import { cleanText, gmailPermalink, safeExternalUrl } from "@/shared/safe-url";

const ALLOW = ["*.instructure.com", "canvas.myschool.edu", "calendar.google.com"];

describe("safeExternalUrl", () => {
  it("accepts https on allowed hosts", () => {
    expect(safeExternalUrl("https://yale.instructure.com/courses/1/assignments/2", ALLOW)).toBe(
      "https://yale.instructure.com/courses/1/assignments/2",
    );
    expect(safeExternalUrl("https://canvas.myschool.edu/calendar", ALLOW)).toBe("https://canvas.myschool.edu/calendar");
    expect(safeExternalUrl("  https://CALENDAR.google.com/x  ", ALLOW)).toBe("https://calendar.google.com/x");
  });

  it("rejects dangerous schemes and http", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "http://yale.instructure.com/x",
    ]) {
      expect(safeExternalUrl(bad, ALLOW)).toBeNull();
    }
  });

  it("rejects userinfo, ports, lookalikes, bare wildcard base, and long URLs", () => {
    expect(safeExternalUrl("https://a@evil.com", ALLOW)).toBeNull();
    expect(safeExternalUrl("https://yale.instructure.com@evil.com/", ALLOW)).toBeNull();
    expect(safeExternalUrl("https://user:pw@yale.instructure.com/", ALLOW)).toBeNull();
    expect(safeExternalUrl("https://yale.instructure.com:8443/", ALLOW)).toBeNull();
    expect(safeExternalUrl("https://instructure.com.evil.io/", ALLOW)).toBeNull();
    expect(safeExternalUrl("https://evilinstructure.com/", ALLOW)).toBeNull();
    expect(safeExternalUrl("https://instructure.com/", ALLOW)).toBeNull();
    expect(safeExternalUrl(`https://yale.instructure.com/${"a".repeat(2050)}`, ALLOW)).toBeNull();
    expect(safeExternalUrl("not a url", ALLOW)).toBeNull();
    expect(safeExternalUrl(null, ALLOW)).toBeNull();
    expect(safeExternalUrl(undefined, ALLOW)).toBeNull();
    expect(safeExternalUrl("https://yale.instructure.com/", [])).toBeNull();
  });
});

describe("cleanText", () => {
  it("strips bidi controls and zero-width characters", () => {
    expect(cleanText("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(cleanText("a⁦b⁩c​d‍e﻿f")).toBe("abcdef");
    expect(cleanText("  hi\u0007 there \n")).toBe("hi there");
  });

  it("truncates by code point with an ellipsis", () => {
    expect(cleanText("abcdefghij", 5)).toBe("abcd…");
    expect(cleanText("😀😀😀😀😀😀", 3)).toBe("😀😀…");
    expect(cleanText("short", 5)).toBe("short");
  });
});

describe("gmailPermalink", () => {
  it("encodes the Message-ID", () => {
    const url = gmailPermalink("<CAF=abc+1@mail.gmail.com>");
    expect(url).toBe("https://mail.google.com/mail/#search/rfc822msgid%3A%3CCAF%3Dabc%2B1%40mail.gmail.com%3E");
    expect(url).not.toMatch(/[<>]/);
  });
});
