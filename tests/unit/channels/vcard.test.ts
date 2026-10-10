/**
 * channels/vcard.ts — vCard 3.0: CRLF line endings, escaping, folding, optional TEL.
 */
import { buildVCard, escapeVCardText } from "@/server/channels/vcard";

describe("buildVCard", () => {
  const card = buildVCard({
    name: "Aria",
    phoneE164: "+15550109999",
    url: "https://aria.test",
    note: "Your AI assistant; deadlines, calendar\nand reminders",
  });

  it("uses CRLF line endings everywhere (no bare LF)", () => {
    expect(card.endsWith("\r\n")).toBe(true);
    expect(card.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("has the required 3.0 structure", () => {
    const lines = card.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCARD");
    expect(lines[1]).toBe("VERSION:3.0");
    expect(lines).toContain("N:;Aria;;;");
    expect(lines).toContain("FN:Aria");
    expect(lines).toContain("TEL;TYPE=CELL,VOICE,pref:+15550109999");
    expect(lines).toContain("URL:https://aria.test");
    expect(lines[lines.length - 2]).toBe("END:VCARD");
  });

  it("escapes text values", () => {
    expect(card).toContain("NOTE:Your AI assistant\\; deadlines\\, calendar\\nand reminders");
    expect(escapeVCardText("a\\b,c;d\r\ne")).toBe("a\\\\b\\,c\\;d\\ne");
  });

  it("omits TEL when there is no (valid) line", () => {
    expect(buildVCard({ name: "Aria", phoneE164: null, url: "https://aria.test", note: "" })).not.toContain("TEL");
    expect(buildVCard({ name: "Aria", phoneE164: "5550109999", url: "https://aria.test", note: "" })).not.toContain("TEL");
  });

  it("folds lines longer than 75 octets and unfolds back to the original", () => {
    const note = "x".repeat(200) + " é".repeat(40);
    const out = buildVCard({ name: "Aria", phoneE164: null, url: "https://aria.test", note });
    for (const line of out.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    const unfolded = out.replace(/\r\n /g, "");
    expect(unfolded).toContain(`NOTE:${note}`);
  });

  it("blank name falls back to Aria", () => {
    expect(buildVCard({ name: "  ", phoneE164: null, url: "", note: "" })).toContain("FN:Aria");
  });
});
