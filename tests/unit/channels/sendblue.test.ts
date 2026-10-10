/**
 * channels/providers/sendblue.ts — secret verification, webhook parsing against the documented
 * payload fixtures, and the fetch adapter (retry policy, declines, capability narrowing).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPLY_REJECTED } from "@/server/channels/execute";
import {
  createSendblueProvider,
  inboundMediaFromUrl,
  mapService,
  parseSendblueWebhook,
  parseSigningSecrets,
  verifySendblueSecret,
} from "@/server/channels/providers/sendblue";
import { parseTapbackText } from "@/server/channels/providers/sendblue-schema";
import type { InboundEvent, OutboundTarget } from "@/server/channels/types";

const FIX = path.join(process.cwd(), "tests/fixtures/sendblue");
const raw = (name: string) => readFileSync(path.join(FIX, name), "utf8");
const parse1 = (name: string, parseTapbacks = false): InboundEvent => {
  const events = parseSendblueWebhook(raw(name), { now: new Date("2026-10-10T00:00:00Z"), parseTapbacks });
  expect(events).toHaveLength(1);
  return events[0];
};
const headers = (secret?: string) => new Headers(secret === undefined ? {} : { "sb-signing-secret": secret });

describe("verifySendblueSecret", () => {
  it("match", () => expect(verifySendblueSecret(headers("s3cret"), ["s3cret"])).toBe(true));
  it("mismatch", () => expect(verifySendblueSecret(headers("nope!!"), ["s3cret"])).toBe(false));
  it("missing header", () => expect(verifySendblueSecret(headers(), ["s3cret"])).toBe(false));
  it("empty header", () => expect(verifySendblueSecret(headers(""), ["s3cret"])).toBe(false));
  it("length mismatch", () => expect(verifySendblueSecret(headers("s3cret-longer"), ["s3cret"])).toBe(false));
  it("rotation list: old and new both accepted", () => {
    const secrets = parseSigningSecrets(" old-secret , new-secret ,");
    expect(secrets).toEqual(["old-secret", "new-secret"]);
    expect(verifySendblueSecret(headers("old-secret"), secrets)).toBe(true);
    expect(verifySendblueSecret(headers("new-secret"), secrets)).toBe(true);
    expect(verifySendblueSecret(headers("other"), secrets)).toBe(false);
  });
  it("no configured secrets → reject", () => {
    expect(verifySendblueSecret(headers("anything"), [])).toBe(false);
    expect(verifySendblueSecret(headers(""), [""])).toBe(false);
  });
});

describe("parseSendblueWebhook fixtures", () => {
  it("receive (iMessage)", () => {
    expect(parse1("receive-imessage.json")).toEqual({
      type: "message",
      providerMessageId: "11111111-2222-3333-4444-555555555501",
      handle: "+15550100001",
      handleKind: "phone",
      line: "+15550109999",
      service: "imessage",
      text: "hey whats due tmrw",
      media: [],
      sentAt: new Date("2026-10-10T14:03:21.512Z"),
      providerOptedOut: false,
    });
  });
  it("inline reply maps reply_to.message_handle", () => {
    const e = parse1("receive-inline-reply.json");
    expect(e).toMatchObject({ type: "message", replyToProviderId: "aaaaaaaa-0000-0000-0000-000000000001" });
  });
  it("SMS service", () => {
    expect(parse1("receive-sms.json")).toMatchObject({ type: "message", service: "sms", handle: "+15550100002" });
  });
  it("Apple ID email handle (lowercased) [verify field]", () => {
    expect(parse1("receive-email-handle.json")).toMatchObject({
      type: "message",
      handle: "student.name@icloud.com",
      handleKind: "email",
    });
  });
  it("media: .pdf → pdf with filename", () => {
    const e = parse1("receive-media-pdf.json");
    expect(e).toMatchObject({ type: "message", text: "" });
    if (e.type !== "message") throw new Error("expected message");
    expect(e.media).toEqual([
      {
        url: "https://cdn.example-sendblue.test/inbound/abc123/CPSC%20223%20Syllabus.pdf",
        kind: "pdf",
        filename: "CPSC 223 Syllabus.pdf",
      },
    ]);
  });
  it("media: .HEIC → image", () => {
    const e = parse1("receive-media-heic.json");
    if (e.type !== "message") throw new Error("expected message");
    expect(e.media[0].kind).toBe("image");
  });
  it("group ignored", () => expect(parse1("receive-group.json")).toEqual({ type: "ignored", reason: "group" }));
  it("is_outbound echo ignored", () =>
    expect(parse1("outbound-echo.json")).toEqual({ type: "ignored", reason: "outbound_echo" }));
  it("outbound DECLINED → status event (opt-out mirroring)", () => {
    expect(parse1("outbound-declined.json")).toEqual({
      type: "status",
      providerMessageId: "22222222-2222-3333-4444-555555555502",
      status: "DECLINED",
      errorKey: "OPTED_OUT",
      service: "imessage",
    });
  });
  it("opted_out flag mirrored", () => {
    expect(parse1("receive-stop.json")).toMatchObject({ type: "message", text: "STOP", providerOptedOut: true });
  });
  it("typing payload", () => {
    expect(parse1("typing.json")).toEqual({ type: "typing", handle: "+15550100001", isTyping: true });
  });
  it("other webhook types → unsupported", () => {
    expect(parse1("line-blocked.json")).toEqual({ type: "ignored", reason: "unsupported" });
  });
  it("garbage → unparseable", () => {
    expect(parseSendblueWebhook("not json")).toEqual([{ type: "ignored", reason: "unparseable" }]);
    expect(parseSendblueWebhook("42")).toEqual([{ type: "ignored", reason: "unparseable" }]);
    expect(parseSendblueWebhook("[]")).toEqual([{ type: "ignored", reason: "unparseable" }]);
    expect(parseSendblueWebhook(JSON.stringify({ message_handle: 5 }))).toEqual([{ type: "ignored", reason: "unparseable" }]);
    expect(parseSendblueWebhook(JSON.stringify({ message_handle: "x", from_number: "not a phone" }))).toEqual([
      { type: "ignored", reason: "unparseable" },
    ]);
  });
  it("missing date_sent falls back to now", () => {
    const body = JSON.parse(raw("receive-imessage.json")) as Record<string, unknown>;
    delete body.date_sent;
    delete body.date_updated;
    const [e] = parseSendblueWebhook(JSON.stringify(body), { now: new Date("2026-01-01T00:00:00Z") });
    expect(e).toMatchObject({ sentAt: new Date("2026-01-01T00:00:00Z") });
  });
  it("tapback text stays a message unless parseTapbacks is on [verify]", () => {
    expect(parse1("receive-tapback.json")).toMatchObject({ type: "message", text: "Loved “see you at 5”" });
    expect(parse1("receive-tapback.json", true)).toEqual({
      type: "reaction",
      handle: "+15550100001",
      targetSnippet: "see you at 5",
      reaction: "love",
      removed: false,
      sentAt: new Date("2026-10-10T14:03:21.512Z"),
    });
  });
});

describe("parseTapbackText", () => {
  it.each([
    ["Loved “see you at 5”", { reaction: "love", snippet: "see you at 5", removed: false }],
    ["Liked \"ok\"", { reaction: "like", snippet: "ok", removed: false }],
    ["Laughed at “lmao”", { reaction: "laugh", snippet: "lmao", removed: false }],
    ["Emphasized “due friday”", { reaction: "emphasize", snippet: "due friday", removed: false }],
    ["Questioned “3pm?”", { reaction: "question", snippet: "3pm?", removed: false }],
    ["Disliked “nope”", { reaction: "dislike", snippet: "nope", removed: false }],
    ["Removed a heart from “see you at 5”", { reaction: "love", snippet: "see you at 5", removed: true }],
    ["Removed a question mark from “x”", { reaction: "question", snippet: "x", removed: true }],
    ["Reacted 😂 to “lol”", { reaction: "😂", snippet: "lol", removed: false }],
    ["Removed 😂 from “lol”", { reaction: "😂", snippet: "lol", removed: true }],
  ])("%p", (text, expected) => expect(parseTapbackText(text)).toEqual(expected));
  it.each(["I loved “that movie”", "Loved it", "loved “x” and more", "hello"])("not a tapback: %p", (t) =>
    expect(parseTapbackText(t)).toBeNull(),
  );
});

describe("helpers", () => {
  it("mapService", () => {
    expect(mapService("iMessage")).toBe("imessage");
    expect(mapService("SMS")).toBe("sms");
    expect(mapService("RCS")).toBe("rcs");
    expect(mapService("iMessage", true)).toBe("sms");
    expect(mapService(null)).toBe("imessage");
  });
  it("inboundMediaFromUrl kinds", () => {
    expect(inboundMediaFromUrl("https://x.test/a/voice.m4a").kind).toBe("audio");
    expect(inboundMediaFromUrl("https://x.test/a/clip.MOV").kind).toBe("video");
    expect(inboundMediaFromUrl("https://x.test/a/card.vcf").kind).toBe("vcard");
    expect(inboundMediaFromUrl("https://x.test/a/file.zip").kind).toBe("other");
    expect(inboundMediaFromUrl("not a url")).toEqual({ url: "not a url", kind: "other" });
  });
});

// ── adapter ─────────────────────────────────────────────────────────────────

const TARGET: OutboundTarget = { handle: "+15550100001", line: "+15550109999", service: "imessage" };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error | "hang";

function harness(replies: Reply[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), init: init ?? {}, body });
    const r = replies.shift() ?? { status: 200, body: {} };
    if (r === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const provider = createSendblueProvider({
    apiKey: "key-id",
    apiSecret: "key-secret",
    base: "https://api.sendblue.test/",
    signingSecrets: ["whsec"],
    fromNumber: "+15550109999",
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    timeoutMs: 20,
  });
  return { provider, calls, sleeps };
}

function connError(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

describe("createSendblueProvider: send", () => {
  it("posts send-message with auth headers and maps the response", async () => {
    const h = harness([{ status: 202, body: { message_handle: "mh-1", status: "QUEUED", service: "iMessage" } }]);
    const r = await h.provider.send(TARGET, { text: "hi", replyToProviderId: "in-1" });
    expect(r).toEqual({ providerMessageId: "mh-1", status: "queued", service: "imessage" });
    expect(h.calls[0].url).toBe("https://api.sendblue.test/api/send-message");
    const hdrs = h.calls[0].init.headers as Record<string, string>;
    expect(hdrs["sb-api-key-id"]).toBe("key-id");
    expect(hdrs["sb-api-secret-key"]).toBe("key-secret");
    expect(h.calls[0].body).toEqual({
      number: "+15550100001",
      from_number: "+15550109999",
      content: "hi",
      reply_to: { message_handle: "in-1" },
    });
  });
  it("media send uses media_url; target without a line uses the default from_number", async () => {
    const h = harness([{ status: 200, body: { message_handle: "mh-2", status: "SENT" } }]);
    const r = await h.provider.send({ ...TARGET, line: null }, { mediaUrl: "https://aria.test/aria.vcf" });
    expect(r.status).toBe("sent");
    expect(h.calls[0].body).toEqual({ number: "+15550100001", from_number: "+15550109999", media_url: "https://aria.test/aria.vcf" });
  });
  it("parses the documented send response fixture", async () => {
    const h = harness([{ status: 202, body: JSON.parse(raw("send-response-queued.json")) }]);
    expect(await h.provider.send(TARGET, { text: "hi" })).toEqual({
      providerMessageId: "33333333-0000-0000-0000-000000000001",
      status: "queued",
      service: "imessage",
    });
  });
  it("retries once on 429 (honouring Retry-After, capped) then succeeds", async () => {
    const h = harness([
      { status: 429, body: {}, headers: { "retry-after": "2" } },
      { status: 200, body: { message_handle: "mh", status: "SENT" } },
    ]);
    expect((await h.provider.send(TARGET, { text: "x" })).status).toBe("sent");
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([2000]);
  });
  it("503 twice → failed after exactly one retry", async () => {
    const h = harness([{ status: 503 }, { status: 503 }]);
    expect(await h.provider.send(TARGET, { text: "x" })).toMatchObject({ status: "failed", errorKey: "http_503" });
    expect(h.calls).toHaveLength(2);
  });
  it("500 is not retried", async () => {
    const h = harness([{ status: 500, body: { error: "x" } }]);
    expect(await h.provider.send(TARGET, { text: "x" })).toMatchObject({ status: "failed", errorKey: "http_500" });
    expect(h.calls).toHaveLength(1);
  });
  it("timeout → failed, never resent", async () => {
    const h = harness(["hang", { status: 200, body: { status: "SENT" } }]);
    expect(await h.provider.send(TARGET, { text: "x" })).toEqual({ providerMessageId: null, status: "failed", errorKey: "timeout" });
    expect(h.calls).toHaveLength(1);
  });
  it("pre-write connection error (ECONNREFUSED) is retried once", async () => {
    const h = harness([connError("ECONNREFUSED"), { status: 200, body: { message_handle: "mh", status: "SENT" } }]);
    expect((await h.provider.send(TARGET, { text: "x" })).status).toBe("sent");
    expect(h.calls).toHaveLength(2);
  });
  it("ambiguous connection error (ECONNRESET) is not retried", async () => {
    const h = harness([connError("ECONNRESET"), { status: 200, body: {} }]);
    expect(await h.provider.send(TARGET, { text: "x" })).toMatchObject({ status: "failed", errorKey: "connection_error" });
    expect(h.calls).toHaveLength(1);
  });
  it("400 DECLINED OPTED_OUT → declined", async () => {
    const h = harness([{ status: 400, body: { status: "DECLINED", error_key: "OPTED_OUT", message_handle: "mh" } }]);
    expect(await h.provider.send(TARGET, { text: "x" })).toEqual({ providerMessageId: "mh", status: "declined", errorKey: "OPTED_OUT" });
  });
  it("400 on an inline reply → reply_to_rejected and inline replies disabled", async () => {
    const h = harness([{ status: 400, body: { error_message: "reply not supported" } }]);
    expect(h.provider.capabilities("imessage", "phone").inlineReplies).toBe(true);
    expect(await h.provider.send(TARGET, { text: "x", replyToProviderId: "in" })).toMatchObject({ status: "failed", errorKey: REPLY_REJECTED });
    expect(h.provider.capabilities("imessage", "phone").inlineReplies).toBe(false);
  });
  it("200 with status ERROR → failed", async () => {
    const h = harness([{ status: 200, body: { status: "ERROR", message_handle: "mh" } }]);
    expect(await h.provider.send(TARGET, { text: "x" })).toMatchObject({ status: "failed", errorKey: "ERROR" });
  });
});

describe("createSendblueProvider: reactions, typing, webhook", () => {
  it("react posts send-reaction and returns true on 2xx", async () => {
    const h = harness([{ status: 200, body: { status: "OK" } }]);
    expect(await h.provider.react(TARGET, "mh-in", "love")).toBe(true);
    expect(h.calls[0].url).toBe("https://api.sendblue.test/api/send-reaction");
    expect(h.calls[0].body).toEqual({ message_handle: "mh-in", reaction: "love", from_number: "+15550109999" });
  });
  it("422 unsupported_on_this_line disables reactions for the instance", async () => {
    const h = harness([{ status: 422, body: { error: "unsupported_on_this_line" } }]);
    expect(await h.provider.react(TARGET, "mh", "like")).toBe(false);
    expect(h.provider.capabilities("imessage", "phone").reactions).toBe(false);
    expect(await h.provider.react(TARGET, "mh", "like")).toBe(false);
    expect(h.calls).toHaveLength(1);
  });
  it("422 unsupported_target fails without disabling", async () => {
    const h = harness([{ status: 422, body: { error: "unsupported_target" } }]);
    expect(await h.provider.react(TARGET, "mh", "like")).toBe(false);
    expect(h.provider.capabilities("imessage", "phone").reactions).toBe(true);
  });
  it("typing posts send-typing-indicator on iMessage only", async () => {
    const h = harness([{ status: 200, body: {} }]);
    await h.provider.typing(TARGET, "start", 60_000);
    await h.provider.typing({ ...TARGET, service: "sms" }, "start");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body).toEqual({ number: "+15550100001", state: "start", from_number: "+15550109999", max_duration_ms: 60_000 });
  });
  it("SMS capabilities: no reactions, typing or inline replies", () => {
    const h = harness([]);
    expect(h.provider.capabilities("sms", "phone")).toEqual({
      reactions: false,
      typing: false,
      inlineReplies: false,
      media: true,
      maxBubbleChars: 1200,
    });
  });
  it("parseWebhook: 401 on bad secret, 400 on invalid JSON, events otherwise", () => {
    const h = harness([]);
    const body = raw("receive-imessage.json");
    expect(h.provider.parseWebhook({ headers: headers("wrong"), rawBody: body })).toEqual({ ok: false, status: 401 });
    expect(h.provider.parseWebhook({ headers: headers(), rawBody: body })).toEqual({ ok: false, status: 401 });
    expect(h.provider.parseWebhook({ headers: headers("whsec"), rawBody: "{nope" })).toEqual({ ok: false, status: 400 });
    const ok = h.provider.parseWebhook({ headers: headers("whsec"), rawBody: body });
    expect(ok.ok && ok.events[0].type).toBe("message");
  });
});
