/**
 * Unit tests for src/server/integrations/google/gmail/headers.ts (V2-07 §10 `headers.test.ts`).
 * Pure: no network, no DB. Run: npm test -- tests/unit/google/headers.test.ts
 */
import {
  decodeEncodedWords,
  decodePushData,
  extractPlainText,
  gmailPermalink,
  htmlToText,
  metaFromGmail,
  parseAddressList,
  stripQuotedHistory,
} from "@/server/integrations/google/gmail/headers";
import {
  GmailMessageFull,
  GmailMessageMeta,
  type GmailMessageFullT,
  type GmailMessagePartT,
} from "@/server/integrations/google/gmail/schemas";

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function leaf(mimeType: string, text: string | Buffer, extraHeaders: { name: string; value: string }[] = [], filename = ""): GmailMessagePartT {
  return {
    mimeType,
    filename,
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }, ...extraHeaders],
    body: { size: text.length, data: b64url(text) },
  };
}

function full(payload: GmailMessagePartT): GmailMessageFullT {
  return GmailMessageFull.parse({ id: "18c1f2a3b4c5d6e7", threadId: "18c1f2a3b4c5d6e7", payload });
}

describe("parseAddressList", () => {
  it("parses bare addresses and lower-cases them", () => {
    expect(parseAddressList("Prof@Yale.EDU")).toEqual([{ name: null, email: "prof@yale.edu" }]);
  });

  it("handles quoted display names containing commas", () => {
    expect(parseAddressList('"Lee, Daniel" <daniel@example.com>, other@example.com')).toEqual([
      { name: "Lee, Daniel", email: "daniel@example.com" },
      { name: null, email: "other@example.com" },
    ]);
  });

  it("decodes RFC 2047 encoded display names (B and Q)", () => {
    expect(parseAddressList("=?UTF-8?B?Sm9zw6kgR2FyY8OtYQ==?= <jose@example.com>")).toEqual([
      { name: "José García", email: "jose@example.com" },
    ]);
    expect(parseAddressList("=?ISO-8859-1?Q?Andr=E9_M=FCller?= <andre@example.de>")).toEqual([
      { name: "André Müller", email: "andre@example.de" },
    ]);
  });

  it("expands groups and drops the group name", () => {
    expect(parseAddressList("Team: a@x.com, B <b@y.org>;, c@z.net")).toEqual([
      { name: null, email: "a@x.com" },
      { name: "B", email: "b@y.org" },
      { name: null, email: "c@z.net" },
    ]);
  });

  it("uses a trailing comment as the name and ignores junk entries", () => {
    expect(parseAddressList("ta@example.com (Teaching Assistant), not-an-address, <>")).toEqual([
      { name: "Teaching Assistant", email: "ta@example.com" },
    ]);
  });

  it("handles unquoted names and angle brackets inside quotes", () => {
    expect(parseAddressList('Canvas <notifications@instructure.com>, "a <b>" <c@d.io>')).toEqual([
      { name: "Canvas", email: "notifications@instructure.com" },
      { name: "a <b>", email: "c@d.io" },
    ]);
  });

  it("returns [] for an empty header", () => {
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("decodeEncodedWords", () => {
  it("joins adjacent encoded words (whitespace between them is dropped)", () => {
    expect(decodeEncodedWords("=?UTF-8?B?w6k=?= =?UTF-8?B?w6k=?= ok")).toBe("éé ok");
  });

  it("leaves plain text and malformed words alone", () => {
    expect(decodeEncodedWords("Re: hello =?bad")).toBe("Re: hello =?bad");
  });
});

describe("metaFromGmail", () => {
  const raw = GmailMessageMeta.parse({
    id: "18c1f2a3b4c5d6e7",
    threadId: "18c1f2a3b4c5d6e0",
    labelIds: ["INBOX", "CATEGORY_UPDATES", "UNREAD"],
    snippet: "Your exam was moved to Friday &amp; it&#39;s in room 101",
    internalDate: "1791633600000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: '"Prof. Smith" <Smith@Yale.edu>' },
        { name: "To", value: "me@gmail.com" },
        { name: "Cc", value: "ta1@yale.edu, ta2@yale.edu" },
        { name: "Reply-To", value: "course@yale.edu" },
        { name: "Subject", value: "=?UTF-8?Q?CPSC_323:_exam_moved_=E2=80=94_read?=" },
        { name: "Message-ID", value: "<abc123@mail.yale.edu>" },
        { name: "References", value: "<a@x> <b@y>" },
        { name: "list-unsubscribe", value: "<mailto:u@x.com>" },
        { name: "Auto-Submitted", value: "Auto-Generated" },
        { name: "Precedence", value: "Bulk" },
      ],
    },
  });

  it("maps headers, labels, dates and flags", () => {
    const m = metaFromGmail(raw);
    expect(m.id).toBe("18c1f2a3b4c5d6e7");
    expect(m.threadId).toBe("18c1f2a3b4c5d6e0");
    expect(m.labels).toEqual(["INBOX", "CATEGORY_UPDATES", "UNREAD"]);
    expect(m.snippet).toBe("Your exam was moved to Friday & it's in room 101");
    expect(m.internalDate.toISOString()).toBe(new Date(1791633600000).toISOString());
    expect(m.from).toEqual({ name: "Prof. Smith", email: "smith@yale.edu" });
    expect(m.to).toEqual([{ name: null, email: "me@gmail.com" }]);
    expect(m.cc.map((a) => a.email)).toEqual(["ta1@yale.edu", "ta2@yale.edu"]);
    expect(m.replyTo).toEqual([{ name: null, email: "course@yale.edu" }]);
    expect(m.subject).toBe("CPSC 323: exam moved — read");
    expect(m.messageId).toBe("<abc123@mail.yale.edu>");
    expect(m.references).toBe("<a@x> <b@y>");
    expect(m.listUnsubscribe).toBe(true);
    expect(m.autoSubmitted).toBe("auto-generated");
    expect(m.precedence).toBe("bulk");
  });

  it("falls back to the Date header, and handles missing headers", () => {
    const m = metaFromGmail(
      GmailMessageMeta.parse({
        id: "18c1f2a3b4c5d6e8",
        threadId: "18c1f2a3b4c5d6e8",
        payload: { headers: [{ name: "Date", value: "Fri, 09 Oct 2026 14:00:00 -0400" }] },
      }),
    );
    expect(m.internalDate.toISOString()).toBe("2026-10-09T18:00:00.000Z");
    expect(m.from).toBeNull();
    expect(m.subject).toBe("");
    expect(m.messageId).toBeNull();
    expect(m.listUnsubscribe).toBe(false);
    expect(m.labels).toEqual([]);
  });
});

describe("extractPlainText", () => {
  it("prefers text/plain inside multipart/alternative", () => {
    const m = full({
      mimeType: "multipart/alternative",
      parts: [leaf("text/plain", "Plain body"), leaf("text/html", "<p>HTML body</p>")],
    });
    expect(extractPlainText(m, 1000)).toBe("Plain body");
  });

  it("converts HTML-only mail: scripts/styles removed, entities decoded, blocks → newlines", () => {
    const html =
      "<html><head><style>p{color:red}</style><title>t</title></head><body><script>alert(1)</script>" +
      "<p>Hi&nbsp;there &amp; welcome</p><div>Line&#8212;two</div><ul><li>one</li><li>two</li></ul></body></html>";
    const m = full(leaf("text/html", html));
    expect(extractPlainText(m, 1000)).toBe("Hi there & welcome\nLine—two\n• one\n• two");
  });

  it("decodes base64url bodies with non-ASCII (emoji, accents)", () => {
    const m = full(leaf("text/plain", "Café ☕ — see you 🎉"));
    expect(extractPlainText(m, 1000)).toBe("Café ☕ — see you 🎉");
  });

  it("decodes quoted-printable bodies that Gmail left encoded", () => {
    const qp = "Caf=C3=A9 is open until 9=\r\npm =3D late";
    const m = full(leaf("text/plain", qp, [{ name: "Content-Transfer-Encoding", value: "quoted-printable" }]));
    expect(extractPlainText(m, 1000)).toBe("Café is open until 9pm = late");
  });

  it("decodes a non-UTF-8 charset", () => {
    const part: GmailMessagePartT = {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }],
      body: { data: b64url(Buffer.from([0x43, 0x61, 0x66, 0xe9])) },
    };
    expect(extractPlainText(full(part), 100)).toBe("Café");
  });

  it("walks nested multipart/mixed and ignores attachments", () => {
    const m = full({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [leaf("text/plain", "The real text"), leaf("text/html", "<b>x</b>")] },
        leaf("text/plain", "ATTACHED NOTES", [{ name: "Content-Disposition", value: "attachment; filename=n.txt" }], "n.txt"),
        { mimeType: "application/pdf", filename: "syllabus.pdf", body: { attachmentId: "ANGjdJ", size: 1000 } },
      ],
    });
    expect(extractPlainText(m, 1000)).toBe("The real text");
  });

  it("strips quoted history (attribution line, > quotes, Outlook header block)", () => {
    const text = "Sounds good, see you then.\n\nOn Tue, Oct 6, 2026 at 3:00 PM Prof <p@yale.edu> wrote:\n> Can we meet?\n> Thanks";
    expect(extractPlainText(full(leaf("text/plain", text)), 1000)).toBe("Sounds good, see you then.");
    const outlook = "Yes.\r\n\r\nFrom: Someone <s@x.com>\r\nSent: Monday\r\nTo: me\r\nOld stuff";
    expect(extractPlainText(full(leaf("text/plain", outlook)), 1000)).toBe("Yes.");
    const wrapped = "Ok!\nOn Tue, Oct 6, 2026 at 3:00 PM Prof Smith <p@yale.edu>\nwrote:\n> old";
    expect(stripQuotedHistory(wrapped)).toBe("Ok!");
  });

  it("drops Gmail's HTML quote block", () => {
    const html = '<div>New reply</div><div class="gmail_quote"><div>On ... wrote:</div><blockquote>old</blockquote></div>';
    expect(htmlToText(html)).toBe("New reply");
  });

  it("caps at maxChars with an ellipsis", () => {
    const out = extractPlainText(full(leaf("text/plain", "abcdefghijklmnopqrstuvwxyz")), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns '' for a message without a readable body", () => {
    expect(extractPlainText(full({ mimeType: "image/png", body: { attachmentId: "x" } }), 100)).toBe("");
    expect(extractPlainText(GmailMessageFull.parse({ id: "18c1f2a3b4c5d6e7", threadId: "18c1f2a3b4c5d6e7" }), 100)).toBe("");
  });
});

describe("gmailPermalink", () => {
  it("encodes the Message-ID and selects the account", () => {
    expect(gmailPermalink("<CAF+x=y@mail.gmail.com>", "Me@Gmail.com")).toBe(
      "https://mail.google.com/mail/u/me%40gmail.com/#search/rfc822msgid%3ACAF%2Bx%3Dy%40mail.gmail.com",
    );
  });

  it("accepts an id without angle brackets", () => {
    expect(gmailPermalink("abc@x.org", "a@b.co")).toBe("https://mail.google.com/mail/u/a%40b.co/#search/rfc822msgid%3Aabc%40x.org");
  });
});

describe("decodePushData", () => {
  const payload = JSON.stringify({ emailAddress: "User@Gmail.com", historyId: 9876543210 });

  it("decodes standard base64", () => {
    expect(decodePushData(Buffer.from(payload).toString("base64"))).toEqual({
      emailAddress: "user@gmail.com",
      historyId: "9876543210",
    });
  });

  it("decodes padding-less base64url", () => {
    const s = Buffer.from(JSON.stringify({ emailAddress: "a@b.co", historyId: "12345" }) + "??>").toString("base64url");
    // trailing junk makes the JSON invalid → null; the clean payload decodes
    expect(decodePushData(s)).toBeNull();
    const clean = Buffer.from(JSON.stringify({ emailAddress: "a@b.co", historyId: "12345" })).toString("base64url");
    expect(clean.endsWith("=")).toBe(false);
    expect(decodePushData(clean)).toEqual({ emailAddress: "a@b.co", historyId: "12345" });
  });

  it("returns null for garbage", () => {
    expect(decodePushData("")).toBeNull();
    expect(decodePushData("!!!not base64")).toBeNull();
    expect(decodePushData(Buffer.from("not json").toString("base64"))).toBeNull();
    expect(decodePushData(Buffer.from("[1,2]").toString("base64"))).toBeNull();
    expect(decodePushData(Buffer.from(JSON.stringify({ emailAddress: "nope", historyId: "1" })).toString("base64"))).toBeNull();
    expect(decodePushData(Buffer.from(JSON.stringify({ emailAddress: "a@b.co", historyId: "12a" })).toString("base64"))).toBeNull();
    expect(decodePushData(Buffer.from(JSON.stringify({ emailAddress: "a@b.co" })).toString("base64"))).toBeNull();
  });
});
