import "server-only";
// OWNER: 3.4

/**
 * Agent tool `connect_canvas` (master plan §1.4 #6; V2-05 §2.9, §9.2 (+ evidence)).
 *
 * Friend-protection #2: the feed URL is taken ONLY from the student's own inbound messages (this
 * run's batch plus the evidence message, falling back to their inbound messages from the last
 * 30 minutes). The model never transcribes the secret; an optional `url` argument must match one
 * of those links, otherwise `not_user_authored` (so a link quoted from an email, a Canvas
 * description or any other tool output can't be connected). After a successful connect the link is
 * scrubbed from the stored inbound bodies (`redactInboundBodies`), so it never reappears in history
 * or later prompts. The summary contains Canvas titles, so it is returned wrapped untrusted.
 */
import { z } from "zod";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { wrapUntrusted } from "@/server/agent/untrusted";
import { redactInboundBodies } from "@/server/channels/repo";
import { db } from "@/server/db";
import { connectCanvas, type CanvasConnectError, type ConnectResult } from "@/server/integrations/canvas/connect";
import { CANVAS_ERROR_COPY } from "@/shared/canvas-guide";
import { findCanvasFeedUrls, normalizeCanvasFeedUrl, redactCanvasFeedUrls, type CanvasFeedUrl } from "@/shared/canvas-url";

const input = z.strictObject({
  url: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .describe("Optional. Must be exactly a link the student sent; omit to auto-detect."),
  evidence: EV,
});

/** How far back the fallback scan of the student's own messages reaches. */
export const RECENT_INBOUND_WINDOW_MS = 30 * 60_000;
/** Placeholder written over the feed link in stored inbound bodies after a connect. */
export const REDACTED_FEED_PLACEHOLDER = "[Canvas feed link saved]";
const RECENT_LIMIT = 50;

/** One stored inbound (user-authored) message. */
export interface InboundCandidate {
  id: string;
  body: string | null;
}

/** Reads the student's own inbound messages (direction 'in' only). Injectable for tests. */
export interface InboundMessageReader {
  /** messages consumed by this agent run */
  runInbound(userId: string, runId: string): Promise<InboundCandidate[]>;
  /** specific inbound messages (the evidence message) */
  byIds(userId: string, ids: string[]): Promise<InboundCandidate[]>;
  /** inbound messages created at or after `since`, newest first */
  recentInbound(userId: string, since: Date): Promise<InboundCandidate[]>;
}

/** Dependencies of {@link runConnectCanvas}. */
export interface ConnectCanvasToolDeps {
  reader: InboundMessageReader;
  connect: typeof connectCanvas;
  redact: typeof redactInboundBodies;
}

/** Result of {@link selectUserAuthoredFeedUrl}. */
export type FeedUrlSelection =
  | { ok: true; url: CanvasFeedUrl; messageIds: string[] }
  | { ok: false; code: "no_url_found" | "multiple_urls" | "not_user_authored" };

/**
 * Picks the feed URL to connect from the student's own messages (pure).
 * @param messages user-authored inbound messages
 * @param requested the model's optional `url` argument
 * @returns the URL plus every message id containing it; `not_user_authored` when `requested`
 *   doesn't match a link the student sent; `no_url_found` / `multiple_urls` when auto-detecting
 */
export function selectUserAuthoredFeedUrl(messages: readonly InboundCandidate[], requested?: string): FeedUrlSelection {
  const found = new Map<string, { url: CanvasFeedUrl; ids: string[] }>();
  for (const m of messages) {
    if (!m.body) continue;
    for (const url of findCanvasFeedUrls(m.body)) {
      const entry = found.get(url.href) ?? { url, ids: [] };
      if (!entry.ids.includes(m.id)) entry.ids.push(m.id);
      found.set(url.href, entry);
    }
  }
  const want = requested?.trim();
  if (want) {
    const n = normalizeCanvasFeedUrl(want);
    const hit = n.ok ? found.get(n.url.href) : undefined;
    return hit ? { ok: true, url: hit.url, messageIds: hit.ids } : { ok: false, code: "not_user_authored" };
  }
  if (found.size === 0) return { ok: false, code: "no_url_found" };
  if (found.size > 1) return { ok: false, code: "multiple_urls" };
  const [only] = found.values();
  return { ok: true, url: only.url, messageIds: only.ids };
}

function mergeById(...lists: InboundCandidate[][]): InboundCandidate[] {
  const seen = new Map<string, InboundCandidate>();
  for (const list of lists) for (const m of list) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()];
}

function fail(op: string, message: string): never {
  throw new Error(`[connect_canvas] ${op}: ${message}`);
}

/** Production reader over `messages` (service role; always scoped to the user and direction 'in'). */
export const dbInboundReader: InboundMessageReader = {
  async runInbound(userId, runId) {
    const { data, error } = await db()
      .from("messages")
      .select("id, body")
      .eq("user_id", userId)
      .eq("direction", "in")
      .eq("consumed_by_run", runId);
    if (error) fail("runInbound", error.message);
    return data ?? [];
  },
  async byIds(userId, ids) {
    if (ids.length === 0) return [];
    const { data, error } = await db()
      .from("messages")
      .select("id, body")
      .eq("user_id", userId)
      .eq("direction", "in")
      .in("id", ids);
    if (error) fail("byIds", error.message);
    return data ?? [];
  },
  async recentInbound(userId, since) {
    const { data, error } = await db()
      .from("messages")
      .select("id, body")
      .eq("user_id", userId)
      .eq("direction", "in")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT);
    if (error) fail("recentInbound", error.message);
    return data ?? [];
  },
};

const DEFAULT_DEPS: ConnectCanvasToolDeps = {
  reader: dbInboundReader,
  connect: connectCanvas,
  redact: redactInboundBodies,
};

const RETRYABLE: ReadonlySet<CanvasConnectError> = new Set(["timeout", "unreachable", "internal", "forbidden"]);

function toolError(code: CanvasConnectError, text?: string): ToolResult {
  return { ok: false, error: `${code}: ${text ?? CANVAS_ERROR_COPY[code]}`, ...(RETRYABLE.has(code) ? { retryable: true } : {}) };
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @param deps message reader, connect function, redactor (defaults: DB, `connectCanvas`, `redactInboundBodies`)
 * @returns `{connected, host, upcoming_deadlines, summary}` (summary wrapped untrusted) or an error code + copy
 */
export async function runConnectCanvas(
  ctx: ToolCtx,
  i: z.output<typeof input>,
  deps: ConnectCanvasToolDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;

  let selection: FeedUrlSelection;
  let candidates: InboundCandidate[];
  try {
    const evidenceId = i.evidence.startsWith("m_") ? ctx.aliases.resolve(i.evidence, "m") : null;
    const [run, evidence] = await Promise.all([
      deps.reader.runInbound(ctx.userId, ctx.runId),
      evidenceId ? deps.reader.byIds(ctx.userId, [evidenceId]) : Promise.resolve([]),
    ]);
    candidates = mergeById(run, evidence);
    selection = selectUserAuthoredFeedUrl(candidates, i.url);
    if (!selection.ok && selection.code !== "multiple_urls") {
      const recent = await deps.reader.recentInbound(ctx.userId, new Date(ctx.now.getTime() - RECENT_INBOUND_WINDOW_MS));
      candidates = mergeById(candidates, recent);
      selection = selectUserAuthoredFeedUrl(candidates, i.url);
    }
  } catch (e) {
    ctx.log("connect_canvas_read_failed", { error: e instanceof Error ? e.name : "unknown" });
    return toolError("internal");
  }
  if (!selection.ok) {
    ctx.log("connect_canvas_no_url", { code: selection.code });
    return toolError(selection.code);
  }

  let result: ConnectResult;
  try {
    result = await deps.connect({ userId: ctx.userId, rawUrl: selection.url.href, via: "chat", now: ctx.now });
  } catch (e) {
    ctx.log("connect_canvas_failed", { error: e instanceof Error ? e.name : "unknown" });
    return toolError("internal");
  }
  if (!result.ok) {
    ctx.log("connect_canvas_error", { code: result.code });
    return toolError(result.code, result.text);
  }

  let redacted = 0;
  try {
    redacted = await deps.redact(ctx.userId, selection.messageIds, (body) => redactCanvasFeedUrls(body, REDACTED_FEED_PLACEHOLDER));
  } catch (e) {
    ctx.log("connect_canvas_redact_failed", { error: e instanceof Error ? e.name : "unknown" });
  }
  ctx.log("connect_canvas_ok", { host: result.host, upcoming: result.upcomingCount, redacted });

  return {
    ok: true,
    data: {
      connected: true,
      host: result.host,
      upcoming_deadlines: result.upcomingCount,
      summary: wrapUntrusted({ source: "canvas", body: result.text }),
      note: "Tell the student it's connected using the summary (in your own words). Their link is saved; don't repeat it.",
    },
  };
}

/** `connect_canvas` tool. */
export const connectCanvasTool = defineTool({
  name: "connect_canvas",
  description:
    "Connect the student's Canvas calendar feed. Use ONLY when the student themselves pasted a Canvas calendar feed link (…/feeds/calendars/user_….ics). You don't need to repeat the link; the tool finds it in their message. Returns a short summary to tell them.",
  input,
  mutates: true,
  untrustedOutput: true,
  slow: true,
  run: (ctx, i) => runConnectCanvas(ctx, i),
});
