import "server-only";
// OWNER: 2.1

/**
 * Webhook core shared by `/api/channels/sendblue`, `/api/channels/dev` and the dev-chat REPL
 * (V2-03 §2.3, §2.7, §2.8, §2.12).
 *
 * `ingestEvents` does only fast DB work (target < 1s):
 * - **message** → `ingest_inbound_message` RPC (one transaction, advisory-locked per handle):
 *   channel/user find-or-create, unexpired signup match (name + timezone + consent), reply-to
 *   mapping, idempotent insert, provider opt-out mirror. Then, in order:
 *   duplicate → no side effects; deleted user → stored only; keyword command → state change now,
 *   confirmation later; opted out → stored (and closed, so it never gets a late reply);
 *   over the inbound rate limit → stored only (the next allowed inbound picks up the backlog);
 *   otherwise the debounced `conversation_turn` job is upserted.
 * - **typing** (user is typing) → pushes a pending turn's `run_at` (still capped at 8s).
 * - **reaction** (user tapback on an Aria message) → `reactions` row + debounced turn (V2-03 Q10).
 * - **status** → outbound row status; a provider `OPTED_OUT` is mirrored.
 *
 * `afterIngest` (in `after()`): typing indicator, command confirmations, then the fast-path kick
 * (sleep until `run_at`, claim that job id). The turn handler itself is `conversation_turn` (3.1).
 */
import { detectCommand, type Command } from "@/server/channels/commands";
import * as repo from "@/server/channels/repo";
import type { ChannelProvider, InboundEvent, OutboundTarget, WebhookParse } from "@/server/channels/types";
import { db } from "@/server/db";
import type { Database, Json } from "@/server/db/types";
import { errorText } from "@/server/jobs/runner";
import { maskHandle } from "@/server/phone";
import { rateLimit } from "@/server/ratelimit";
import { confirmCommand, recordCommand } from "@/server/pipeline/commands-handler";
import { PIPELINE } from "@/server/pipeline/config";
import { enqueueTurn, kickDelayMs, kickJob, turnDedupeKey } from "@/server/pipeline/kick";
import { safeTimeZone } from "@/shared/time/tz";

/** Every Sendblue/dev handle is one iMessage-kind channel; transport lives in `service` (V2-03 §2.7). */
export const INBOUND_CHANNEL_KIND = "imessage";
/** Typing indicator duration requested while a turn is pending. */
export const TYPING_MAX_MS = 120_000;

/** What ingest did with one event. */
export type IngestOutcome =
  | {
      kind: "turn";
      userId: string;
      channelId: string;
      /** Inbound message that caused it (null for typing/reaction pushes). */
      messageId: string | null;
      jobId: string;
      runAt: Date;
      dbNow: Date;
      target: OutboundTarget;
      /** Show our typing indicator (true for a new inbound message). */
      showTyping: boolean;
    }
  | {
      kind: "command";
      userId: string;
      channelId: string;
      messageId: string;
      runId: string;
      command: Command;
      tz: string;
      now: Date;
      /** False when the provider already opted the contact out (it sends its own confirmation). */
      confirm: boolean;
    }
  | {
      kind: "stored_only";
      reason: "opted_out" | "rate_limited" | "deleted" | "reaction";
      userId: string;
      messageId: string | null;
    }
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string };

type IngestArgs = Database["public"]["Functions"]["ingest_inbound_message"]["Args"];
type IngestRow = Database["public"]["Functions"]["ingest_inbound_message"]["Returns"][number];
type MessageEvent = Extract<InboundEvent, { type: "message" }>;

/** `ingest_inbound_message` args; nullable where the SQL accepts null (generated types say string). */
type NullableIngestArgs = Omit<IngestArgs, "p_reply_to_provider_id" | "p_provider_line" | "p_body"> & {
  p_reply_to_provider_id: string | null;
  p_provider_line: string | null;
  p_body: string | null;
};

async function ingestMessageRow(provider: ChannelProvider, ev: MessageEvent): Promise<IngestRow> {
  const args: NullableIngestArgs = {
    p_provider: provider.name,
    p_provider_line: ev.line,
    p_kind: INBOUND_CHANNEL_KIND,
    p_handle: ev.handle,
    p_handle_kind: ev.handleKind,
    p_service: ev.service,
    p_provider_message_id: ev.providerMessageId,
    p_body: ev.text.length > 0 ? ev.text : null,
    p_media: ev.media as unknown as Json,
    p_reply_to_provider_id: ev.replyToProviderId ?? null,
    p_sent_at: ev.sentAt.toISOString(),
    p_provider_opted_out: ev.providerOptedOut,
  };
  const { data, error } = await db().rpc("ingest_inbound_message", args as IngestArgs);
  if (error) throw new Error(`ingest_inbound_message: ${error.message}`);
  const row = data?.[0];
  if (!row) throw new Error("ingest_inbound_message returned no row");
  return row;
}

async function ingestMessage(provider: ChannelProvider, ev: MessageEvent): Promise<IngestOutcome> {
  const row = await ingestMessageRow(provider, ev);
  if (row.duplicate || !row.message_id) return { kind: "duplicate" };
  const userId = row.user_id;
  const channelId = row.channel_id;
  const messageId = row.message_id;
  const dbNow = new Date(row.db_now);
  const tz = safeTimeZone(row.timezone);
  const optedOut = row.opted_out_at !== null;

  if (await repo.isUserDeleted(userId)) {
    return { kind: "stored_only", reason: "deleted", userId, messageId };
  }

  const command = ev.text ? detectCommand(ev.text, dbNow, tz) : null;
  if (command && (!optedOut || command.kind === "opt_in" || command.kind === "opt_out")) {
    const { runId } = await recordCommand(command, { userId, channelId, messageId, now: dbNow, tz });
    // Opted out already (provider keyword or a repeat STOP): record it, but stay silent.
    const confirm = !(optedOut && command.kind === "opt_out");
    return { kind: "command", userId, channelId, messageId, runId, command, tz, now: dbNow, confirm };
  }

  if (optedOut) {
    // Stored, never answered — not even later when they text START.
    await repo.closeWithoutAgent({ userId, channelId, messageIds: [messageId], note: "ignored: opted out" });
    return { kind: "stored_only", reason: "opted_out", userId, messageId };
  }

  if (!(await rateLimit(`inbound:${channelId}`, PIPELINE.inboundRatePerMin, 60))) {
    console.warn(`[pipeline] inbound rate limit hit for ${maskHandle(ev.handle)}; stored without a turn`);
    return { kind: "stored_only", reason: "rate_limited", userId, messageId };
  }

  const job = await enqueueTurn(userId, dbNow);
  return {
    kind: "turn",
    userId,
    channelId,
    messageId,
    jobId: job.id,
    runAt: job.runAt,
    dbNow: job.dbNow,
    target: { handle: ev.handle, line: ev.line, service: ev.service },
    showTyping: true,
  };
}

async function pendingTurnExists(userId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("jobs")
    .select("id")
    .eq("dedupe_key", turnDedupeKey(userId))
    .eq("status", "pending")
    .limit(1);
  if (error) throw new Error(`pending turn lookup: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

async function ingestTyping(ev: Extract<InboundEvent, { type: "typing" }>): Promise<IngestOutcome> {
  if (!ev.isTyping) return { kind: "ignored", reason: "typing_stopped" };
  const channel = await repo.findChannelByHandle(INBOUND_CHANNEL_KIND, ev.handle);
  if (!channel || channel.opted_out_at) return { kind: "ignored", reason: "typing_no_turn" };
  if (!(await pendingTurnExists(channel.user_id))) return { kind: "ignored", reason: "typing_no_turn" };
  // Debounce mode: run_at = least(greatest(old, now + 2.5s), created_at + 8s). Racing a claim
  // can create a fresh job; that turn just finds nothing unconsumed.
  const job = await enqueueTurn(channel.user_id);
  return {
    kind: "turn",
    userId: channel.user_id,
    channelId: channel.id,
    messageId: null,
    jobId: job.id,
    runAt: job.runAt,
    dbNow: job.dbNow,
    target: { handle: channel.handle, line: channel.provider_line, service: serviceOf(channel) },
    showTyping: false,
  };
}

async function ingestReaction(
  provider: ChannelProvider,
  ev: Extract<InboundEvent, { type: "reaction" }>,
): Promise<IngestOutcome> {
  const channel = await repo.findChannelByHandle(INBOUND_CHANNEL_KIND, ev.handle);
  if (!channel) return { kind: "ignored", reason: "reaction_unknown_handle" };
  const target = ev.targetProviderId ? await repo.findMessageByProviderId(provider.name, ev.targetProviderId) : null;
  if (!target || target.userId !== channel.user_id || target.direction !== "out") {
    return { kind: "ignored", reason: "reaction_target_unknown" };
  }
  await repo.recordReaction({ messageId: target.id, actor: "user", type: ev.reaction, removed: ev.removed });
  if (ev.removed || channel.opted_out_at || (await repo.isUserDeleted(channel.user_id))) {
    return { kind: "stored_only", reason: "reaction", userId: channel.user_id, messageId: null };
  }
  const job = await enqueueTurn(channel.user_id);
  return {
    kind: "turn",
    userId: channel.user_id,
    channelId: channel.id,
    messageId: null,
    jobId: job.id,
    runAt: job.runAt,
    dbNow: job.dbNow,
    target: { handle: channel.handle, line: channel.provider_line, service: serviceOf(channel) },
    showTyping: false,
  };
}

async function ingestStatus(
  provider: ChannelProvider,
  ev: Extract<InboundEvent, { type: "status" }>,
): Promise<IngestOutcome> {
  const status = ev.errorKey ? `${ev.status}:${ev.errorKey}` : ev.status;
  const channelId = await repo.updateOutboundStatus(provider.name, ev.providerMessageId, status);
  if (channelId && ev.errorKey && /opt/i.test(ev.errorKey)) await repo.setOptOut(channelId, new Date(), "provider");
  return { kind: "ignored", reason: "status" };
}

function serviceOf(channel: repo.ChannelRow): OutboundTarget["service"] {
  return channel.last_service === "sms" || channel.last_service === "rcs" ? channel.last_service : "imessage";
}

/**
 * Ingests verified webhook events (sequentially, in order). Fast DB work only.
 * @param provider the provider that parsed the events (its name is stored on rows)
 * @param events parsed, verified events
 * @returns one outcome per event, in order
 * @throws on a DB error before the inbound row is stored (the route answers 500 → provider retry)
 */
export async function ingestEvents(provider: ChannelProvider, events: InboundEvent[]): Promise<IngestOutcome[]> {
  const out: IngestOutcome[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case "message":
        out.push(await ingestMessage(provider, ev));
        break;
      case "typing":
        out.push(await ingestTyping(ev));
        break;
      case "reaction":
        out.push(await ingestReaction(provider, ev));
        break;
      case "status":
        out.push(await ingestStatus(provider, ev));
        break;
      case "ignored":
        out.push({ kind: "ignored", reason: ev.reason });
        break;
    }
  }
  return out;
}

/**
 * Post-response work for one webhook (run inside `after()`): command confirmations, our typing
 * indicator for new inbound, then the fast-path kick per turn job (sleep until `run_at`, claim
 * that job). Never throws.
 * @param outcomes `ingestEvents` result
 * @param provider provider for the typing indicator
 */
export async function afterIngest(outcomes: IngestOutcome[], provider: ChannelProvider): Promise<void> {
  const work: Promise<unknown>[] = [];
  for (const o of outcomes) {
    if (o.kind !== "command" || !o.confirm) continue;
    work.push(
      confirmCommand(o.command, {
        userId: o.userId,
        channelId: o.channelId,
        messageId: o.messageId,
        runId: o.runId,
        now: o.now,
        tz: o.tz,
      })
        .then((r) => {
          if (r.status === "failed") console.warn(`[pipeline] ${o.command.kind} confirmation failed: ${r.error}`);
        })
        .catch((e: unknown) => console.error(`[pipeline] ${o.command.kind} confirmation threw: ${errorText(e)}`)),
    );
  }

  // One kick per job (a webhook rarely carries more than one event); latest run_at wins.
  const turns = new Map<string, Extract<IngestOutcome, { kind: "turn" }>>();
  for (const o of outcomes) {
    if (o.kind !== "turn") continue;
    const prev = turns.get(o.jobId);
    turns.set(o.jobId, prev && prev.runAt >= o.runAt ? { ...prev, showTyping: prev.showTyping || o.showTyping } : o);
  }
  for (const t of turns.values()) {
    work.push(
      (async () => {
        if (t.showTyping) {
          try {
            await provider.typing(t.target, "start", TYPING_MAX_MS);
          } catch {
            // best-effort
          }
        }
        await kickJob(t.jobId, kickDelayMs(t.runAt, t.dbNow));
      })(),
    );
  }
  await Promise.allSettled(work);
}

/**
 * Shared route body for channel webhooks: parse result → ingest → schedule `afterIngest` →
 * respond. 401/400 from the parser are passed through with no DB access; a DB failure before the
 * inbound row is stored answers 500 so the provider retries (the insert is idempotent).
 * @param provider provider that parsed the request
 * @param parsed `provider.parseWebhook(...)` result
 * @param schedule `after` from `next/server` (injected for tests)
 * @param startedAt request start (epoch ms) for the timing log
 * @returns the HTTP response
 */
export async function respondToWebhook(
  provider: ChannelProvider,
  parsed: WebhookParse,
  schedule: (task: () => Promise<void>) => void,
  startedAt: number = Date.now(),
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!parsed.ok) {
    return Response.json({ error: parsed.status === 401 ? "unauthorized" : "bad_request" }, { status: parsed.status, headers });
  }
  let outcomes: IngestOutcome[];
  try {
    outcomes = await ingestEvents(provider, parsed.events);
  } catch (e) {
    console.error(`[pipeline] ${provider.name} webhook ingest failed: ${errorText(e)}`);
    return Response.json({ error: "ingest_failed" }, { status: 500, headers });
  }
  if (outcomes.some((o) => o.kind === "turn" || (o.kind === "command" && o.confirm))) {
    schedule(() => afterIngest(outcomes, provider));
  }
  const kinds = outcomes.map((o) => o.kind);
  console.info(`[pipeline] ${provider.name} webhook: ${kinds.join(",") || "no events"} in ${Date.now() - startedAt}ms`);
  return Response.json({ ok: true, outcomes: kinds }, { status: 200, headers });
}

/**
 * Whether `/api/channels/dev` answers in this environment (pure): never in production; otherwise
 * when `CHANNEL_PROVIDER=dev` or a `DEV_CHANNEL_SECRET` is configured.
 * @param env production flag, `CHANNEL_PROVIDER`, `DEV_CHANNEL_SECRET`
 * @returns true when the route should answer
 */
export function devRouteEnabled(env: { production: boolean; channelProvider?: string; devSecret?: string }): boolean {
  if (env.production) return false;
  return env.channelProvider?.trim().toLowerCase() === "dev" || !!env.devSecret;
}
