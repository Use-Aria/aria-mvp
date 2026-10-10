/**
 * Unit tests for src/server/integrations/google/gmail/mime.ts (V2-07 §10 `mime.test.ts`), plus the
 * `sendRaw` import guard (task 2.5: `sendRaw` may only be imported by `gmail/send.ts`).
 * Run: npm test -- tests/unit/google/mime.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  buildRawMessage,
  encodeHeaderWord,
  isValidEmail,
  newMessageId,
  replyReferences,
  replySubject,
  type OutgoingEmail,
} from "@/server/integrations/google/gmail/mime";
import { decodeEncodedWords, parseAddressList } from "@/server/integrations/google/gmail/headers";

/** Decode a raw message into headers (unfolded, by lower-cased name) + decoded UTF-8 body. */
function parseRaw(raw: string): { text: string; headers: Map<string, string>; headerBlock: string; body: string } {
  expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  expect(split).toBeGreaterThan(0);
  const headerBlock = text.slice(0, split);
  const headers = new Map<string, string>();
  for (const line of headerBlock.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  const b64 = text.slice(split + 4);
  const body = Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8");
  return { text, headers, headerBlock, body };
}

const base: OutgoingEmail = {
  from: "Daniel Lee <daniel@example.com>",
  to: ["prof@yale.edu"],
  cc: [],
  subject: "Question about the midterm",
  bodyText: "Hi Professor,\nCould we meet Thursday?\n\nBest,\nDaniel",
  messageId: "<11111111-2222-3333-4444-555555555555@example.com>",
  date: new Date("2026-10-10T15:04:05Z"),
};

describe("buildRawMessage", () => {
  it("round-trips: headers + base64 body decode to the original UTF-8 text", () => {
    const body = "Café ☕ naïve — 🎉 done\nsecond line";
    const { headers, body: decoded, text } = parseRaw(buildRawMessage({ ...base, bodyText: body }));
    expect(decoded).toBe(body.replace(/\n/g, "\r\n"));
    expect(headers.get("from")).toBe("Daniel Lee <daniel@example.com>");
    expect(headers.get("to")).toBe("prof@yale.edu");
    expect(headers.has("cc")).toBe(false);
    expect(headers.get("subject")).toBe("Question about the midterm");
    expect(headers.get("date")).toBe("Sat, 10 Oct 2026 15:04:05 +0000");
    expect(headers.get("message-id")).toBe(base.messageId);
    expect(headers.get("mime-version")).toBe("1.0");
    expect(headers.get("content-type")).toBe('text/plain; charset="UTF-8"');
    expect(headers.get("content-transfer-encoding")).toBe("base64");
    // CRLF everywhere, no bare LF.
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("encodes a non-ASCII subject as RFC 2047 UTF-8 B words that decode back", () => {
    const subject = "Réunion — 📅 demain à 10h, très important pour le cours CPSC 323 (encore une fois)";
    const { headers, headerBlock } = parseRaw(buildRawMessage({ ...base, subject }));
    const enc = headers.get("subject") ?? "";
    expect(enc).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeEncodedWords(enc)).toBe(subject);
    for (const line of headerBlock.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
  });

  it("encodes non-ASCII display names and quotes special ones", () => {
    const { headers } = parseRaw(
      buildRawMessage({ ...base, from: "José García <jose@example.com>", to: ['"Lee, Daniel" <d@example.com>'], cc: ["a@b.co"] }),
    );
    expect(parseAddressList(headers.get("from") ?? "")).toEqual([{ name: "José García", email: "jose@example.com" }]);
    expect(headers.get("to")).toBe('"Lee, Daniel" <d@example.com>');
    expect(headers.get("cc")).toBe("a@b.co");
  });

  it("adds In-Reply-To and References for replies", () => {
    const refs = replyReferences("<root@x.com> <mid@x.com>", "<parent@x.com>");
    const { headers } = parseRaw(
      buildRawMessage({ ...base, subject: replySubject("Re: Office hours"), inReplyTo: "<parent@x.com>", references: refs }),
    );
    expect(headers.get("in-reply-to")).toBe("<parent@x.com>");
    expect(headers.get("references")).toBe("<root@x.com> <mid@x.com> <parent@x.com>");
    expect(headers.get("subject")).toBe("Re: Office hours");
  });

  it("omits threading headers for a new message", () => {
    const { headers } = parseRaw(buildRawMessage(base));
    expect(headers.has("in-reply-to")).toBe(false);
    expect(headers.has("references")).toBe(false);
  });

  it("wraps the base64 body at 76 columns", () => {
    const { text } = parseRaw(buildRawMessage({ ...base, bodyText: "x".repeat(1000) }));
    const bodyLines = text.slice(text.indexOf("\r\n\r\n") + 4).split("\r\n").filter(Boolean);
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const l of bodyLines) expect(l.length).toBeLessThanOrEqual(76);
  });

  it("folds a long References header", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `<message-${i}-abcdefghij@mail.example.com>`).join(" ");
    const { headerBlock, headers } = parseRaw(buildRawMessage({ ...base, inReplyTo: "<message-11-abcdefghij@mail.example.com>", references: ids }));
    expect(headers.get("references")).toBe(ids);
    for (const line of headerBlock.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
  });

  it.each([
    ["subject", { subject: "Hello\r\nBcc: victim@evil.com" }],
    ["subject (LF)", { subject: "Hello\nBcc: victim@evil.com" }],
    ["to", { to: ["prof@yale.edu\r\nBcc: victim@evil.com"] }],
    ["cc", { cc: ["a@b.co\nX: y"] }],
    ["from", { from: "me@x.com\r\nBcc: v@e.com" }],
    ["inReplyTo", { inReplyTo: "<a@b>\r\nBcc: v@e.com" }],
    ["references", { references: "<a@b>\nBcc: v@e.com" }],
    ["messageId", { messageId: "<a@b.com>\r\nX: y" }],
  ])("throws on CR/LF injection in %s", (_label, patch) => {
    expect(() => buildRawMessage({ ...base, ...(patch as Partial<OutgoingEmail>) })).toThrow();
  });

  it.each([
    ["invalid to", { to: ["not-an-email"] }],
    ["two addresses in one to entry", { to: ["a@b.co, c@d.co"] }],
    ["invalid cc", { cc: ["x@"] }],
    ["invalid from", { from: "Daniel" }],
    ["no recipients", { to: [] }],
    ["bad Message-ID", { messageId: "no-brackets@x.com" }],
    ["bad In-Reply-To", { inReplyTo: "plain" }],
  ])("throws on %s", (_label, patch) => {
    expect(() => buildRawMessage({ ...base, ...(patch as Partial<OutgoingEmail>) })).toThrow();
  });
});

describe("encodeHeaderWord", () => {
  it("leaves printable ASCII untouched", () => {
    expect(encodeHeaderWord("Plain subject: 100% ok")).toBe("Plain subject: 100% ok");
  });

  it("never splits a multi-byte character and keeps every word ≤ 75 chars", () => {
    const v = "日本語のテキスト🎉".repeat(10);
    const enc = encodeHeaderWord(v);
    for (const w of enc.split("\r\n ")) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      // Each word decodes on its own to valid UTF-8 (no replacement characters).
      expect(decodeEncodedWords(w)).not.toContain("�");
    }
    expect(decodeEncodedWords(enc)).toBe(v);
  });

  it("throws on CR/LF", () => {
    expect(() => encodeHeaderWord("a\r\nb")).toThrow();
  });
});

describe("replySubject", () => {
  it.each([
    ["Office hours", "Re: Office hours"],
    ["Re: Office hours", "Re: Office hours"],
    ["RE: re: Re: Office hours", "Re: Office hours"],
    ["Re[2]: Office hours", "Re: Office hours"],
    ["AW: Termin", "Re: Termin"],
    ["Fwd: notes", "Re: Fwd: notes"],
    ["", "Re:"],
  ])("%j → %j", (input, want) => {
    expect(replySubject(input)).toBe(want);
  });

  it("is idempotent (never Re: Re:)", () => {
    for (const s of ["x", "Re: x", "RE: RE: x", "Re[3]: x"]) {
      expect(replySubject(replySubject(s))).toBe(replySubject(s));
      expect(replySubject(replySubject(s))).not.toMatch(/^Re: Re:/i);
    }
  });
});

describe("replyReferences / newMessageId / isValidEmail", () => {
  it("de-dupes and appends the parent id", () => {
    expect(replyReferences("<a@x> <b@x>", "<b@x>")).toBe("<a@x> <b@x>");
    expect(replyReferences(null, "<p@x>")).toBe("<p@x>");
  });

  it("keeps the root and the newest ids when the chain is long", () => {
    const chain = Array.from({ length: 60 }, (_, i) => `<id-${i}-xxxxxxxx@example.com>`).join(" ");
    const out = replyReferences(chain, "<parent@example.com>");
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.startsWith("<id-0-")).toBe(true);
    expect(out.endsWith("<parent@example.com>")).toBe(true);
  });

  it("mints a valid Message-ID", () => {
    expect(newMessageId("Example.com")).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
    expect(() => newMessageId("not a domain")).toThrow();
  });

  it.each([
    ["a@b.co", true],
    ["first.last+tag@sub.example.edu", true],
    ["a@b", false],
    [".a@b.co", false],
    ["a..b@b.co", false],
    ["a@-b.co", false],
    ["a b@c.co", false],
    ["a@b.co\r\n", false],
    ["", false],
  ])("isValidEmail(%j) = %s", (v, ok) => {
    expect(isValidEmail(v)).toBe(ok);
  });
});

// ── sendRaw import guard ──────────────────────────────────────────────────────
// Friend-protection 1: email is sent only by the confirmed-pending-action executor. `sendRaw`
// lives in gmail/api.ts; only gmail/send.ts (task 4.3) may import it (or the module wholesale).

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");
const ALLOWED = new Set(["src/server/integrations/google/gmail/send.ts", "src/server/integrations/google/gmail/api.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Module specifiers that resolve to gmail/api.ts. */
const API_SPEC = /["'](@\/server\/integrations\/google\/gmail\/api|(\.{1,2}\/)+(gmail\/)?api|.*\/google\/gmail\/api)["']/;

describe("sendRaw import guard", () => {
  it("only gmail/send.ts imports sendRaw (or gmail/api wholesale)", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      const statements = src.match(/(import|export)[\s\S]*?from\s*["'][^"']+["']|import\(\s*["'][^"']+["']\s*\)|require\(\s*["'][^"']+["']\s*\)/g) ?? [];
      for (const st of statements) {
        if (!API_SPEC.test(st)) continue;
        // Relative "./api" only means gmail/api from inside the gmail directory.
        if (/["']\.\/api["']/.test(st) && !rel.startsWith("src/server/integrations/google/gmail/")) continue;
        if (/\bsendRaw\b/.test(st) || /\*\s*as\b/.test(st) || /export\s*\*/.test(st) || /import\(|require\(/.test(st)) {
          violations.push(`${rel}: ${st.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
