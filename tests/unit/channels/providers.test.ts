/**
 * channels/providers/dev.ts + channels/index.ts — dev provider transcript and webhook auth,
 * provider selection (dev refused in production), channel context.
 */
import { channelContext, resolveProviderName } from "@/server/channels";
import { createDevProvider, parseDevBody } from "@/server/channels/providers/dev";
import type { Tables } from "@/server/db/types";

const NOW = new Date("2026-10-10T16:00:00Z");
const devHeaders = (secret?: string) => new Headers(secret ? { "x-dev-secret": secret } : {});

describe("dev provider", () => {
  it("records sends, reactions, typing in the transcript", async () => {
    const p = createDevProvider({ secret: "s", now: () => NOW });
    const target = { handle: "+15550100001", line: "dev", service: "imessage" as const };
    const r = await p.send(target, { text: "hi" });
    expect(r.status).toBe("sent");
    expect(r.providerMessageId).toMatch(/^dev-out-/);
    expect(await p.react(target, "dev-in-1", "love")).toBe(true);
    await p.typing(target, "start");
    expect(p.transcript().map((e) => e.op)).toEqual(["send", "react", "typing"]);
    p.reset();
    expect(p.transcript()).toEqual([]);
  });

  it("webhook requires the dev secret (unset secret rejects everything)", () => {
    const body = JSON.stringify({ handle: "+1 (555) 010-0001", text: "hey" });
    expect(createDevProvider({ secret: "s" }).parseWebhook({ headers: devHeaders("x"), rawBody: body })).toEqual({ ok: false, status: 401 });
    expect(createDevProvider({ secret: null }).parseWebhook({ headers: devHeaders("s"), rawBody: body })).toEqual({ ok: false, status: 401 });
    expect(createDevProvider({ secret: "s" }).parseWebhook({ headers: devHeaders("s"), rawBody: "{" })).toEqual({ ok: false, status: 400 });
    const ok = createDevProvider({ secret: "s", now: () => NOW }).parseWebhook({ headers: devHeaders("s"), rawBody: body });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.events[0]).toMatchObject({
      type: "message",
      handle: "+15550100001",
      handleKind: "phone",
      line: "dev",
      service: "imessage",
      text: "hey",
      media: [],
      sentAt: NOW,
      providerOptedOut: false,
    });
  });

  it("dev body: media, reply, typing, reaction, invalid", () => {
    expect(
      parseDevBody({ handle: "+15550100001", mediaUrl: "http://localhost:3000/f/syllabus.pdf", providerMessageId: "m1", replyToProviderId: "dev-out-1" }, NOW),
    ).toMatchObject({
      providerMessageId: "m1",
      replyToProviderId: "dev-out-1",
      media: [{ url: "http://localhost:3000/f/syllabus.pdf", kind: "pdf", filename: "syllabus.pdf" }],
    });
    expect(parseDevBody({ type: "typing", handle: "+15550100001", isTyping: true }, NOW)).toEqual({
      type: "typing",
      handle: "+15550100001",
      isTyping: true,
    });
    expect(parseDevBody({ type: "reaction", handle: "+15550100001", reaction: "love", targetProviderId: "dev-out-1" }, NOW)).toEqual({
      type: "reaction",
      handle: "+15550100001",
      targetProviderId: "dev-out-1",
      reaction: "love",
      removed: false,
      sentAt: NOW,
    });
    expect(parseDevBody({ type: "reaction", handle: "+15550100001", reaction: "heart" }, NOW)).toBeNull();
    expect(parseDevBody({ handle: "nope" }, NOW)).toBeNull();
    expect(parseDevBody({ text: "no handle" }, NOW)).toBeNull();
  });
});

describe("resolveProviderName", () => {
  it("defaults: dev outside production, sendblue in production", () => {
    expect(resolveProviderName({ production: false })).toBe("dev");
    expect(resolveProviderName({ production: true })).toBe("sendblue");
  });
  it("env and explicit names", () => {
    expect(resolveProviderName({ production: false, channelProvider: "sendblue" })).toBe("sendblue");
    expect(resolveProviderName({ production: false, channelProvider: "sendblue" }, "dev")).toBe("dev");
  });
  it("dev in production throws; unknown names throw", () => {
    expect(() => resolveProviderName({ production: true, channelProvider: "dev" })).toThrow(/production/);
    expect(() => resolveProviderName({ production: true }, "dev")).toThrow(/production/);
    expect(() => resolveProviderName({ production: false, channelProvider: "twilio" })).toThrow(/Unknown/);
  });
});

describe("channelContext", () => {
  const row: Tables<"channels"> = {
    id: "ch-1",
    user_id: "u-1",
    kind: "imessage",
    handle: "+15550100001",
    handle_kind: "phone",
    provider: "dev",
    provider_line: "dev",
    last_service: "sms",
    last_inbound_at: "2026-10-10T10:00:00Z",
    opted_out_at: null,
    paused_until: null,
    is_primary: true,
    verified_at: null,
    created_at: "2026-10-01T00:00:00Z",
  };
  it("never exposes the handle; derives service, caps and window", () => {
    const ctx = channelContext(row, { now: NOW });
    expect(ctx).toEqual({
      channelId: "ch-1",
      provider: "dev",
      kind: "imessage",
      service: "sms",
      handleKind: "phone",
      capabilities: { reactions: false, typing: false, inlineReplies: false, media: true, maxBubbleChars: 1200 },
      windowOpen: true,
    });
    expect(JSON.stringify(ctx)).not.toContain("5550100001");
  });
  it("defaults service to imessage and closes the window after 24h", () => {
    const ctx = channelContext({ ...row, last_service: null, last_inbound_at: "2026-10-09T15:00:00Z" }, { now: NOW });
    expect(ctx.service).toBe("imessage");
    expect(ctx.capabilities.reactions).toBe(true);
    expect(ctx.windowOpen).toBe(false);
  });
  it("reads live capabilities from a passed provider instance", () => {
    const live = createDevProvider();
    live.capabilities = () => ({ reactions: false, typing: true, inlineReplies: false, media: true, maxBubbleChars: 1200 });
    expect(channelContext({ ...row, last_service: "imessage" }, { now: NOW, provider: live }).capabilities.reactions).toBe(false);
  });
});
