import "server-only";
// OWNER: 2.5

/**
 * Thin Gmail REST wrappers over `googleFetch` (V2-07 §7.3 `gmail/api.ts`). Every response is
 * zod-validated (`gmail/schemas.ts`). The optional trailing `deps` is the HTTP seam
 * (`googleFetch`'s injected `fetch`), used by tests; production callers omit it.
 *
 * ⚠ SEND RESTRICTION — `sendRaw` may be imported ONLY by `src/server/integrations/google/gmail/send.ts`
 * (task 4.3, the confirmed-pending-action executor). No other module may import it: email is sent
 * only by deterministic code after the user confirms a `pending_actions` row (friend-protection 1).
 * Enforced by `tests/unit/google/mime.test.ts` ("sendRaw import guard"), which scans `src/` and
 * fails on any other importer; the equivalent ESLint rule is in the 2.5 hand-off.
 *
 * Quota (F13): `messages.get` 20 units, `messages.list` 5, `history.list` 2, `messages.send` 100,
 * `watch` 100, `getProfile` 1; 6,000 units/min/user.
 */
import { googleFetch, googleFetchNoContent } from "@/server/integrations/google/http";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { METADATA_HEADERS, metaFromGmail } from "@/server/integrations/google/gmail/headers";
import {
  GmailMessageFull,
  GmailMessageMeta,
  HistoryList,
  MessagesList,
  Profile,
  SendResponse,
  WatchResponse,
  type GmailMessageFullT,
} from "@/server/integrations/google/gmail/schemas";
import type { EmailMeta } from "@/server/integrations/google/gmail/types";

/** Gmail REST base for the authenticated user. */
export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** HTTP seam forwarded to `googleFetch` (tests inject `fetch`; production omits it). */
export interface GmailApiDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Gmail message/thread ids are lowercase hex. */
export const GMAIL_ID_RE = /^[0-9a-f]{8,32}$/;
/** History ids are unsigned 64-bit decimals. */
export const HISTORY_ID_RE = /^[0-9]{1,20}$/;

/** `history.list` pages read per sync before handing back a partial cursor (500 records each). */
export const MAX_HISTORY_PAGES = 10;

function assertMessageId(id: string): void {
  if (!GMAIL_ID_RE.test(id)) throw new Error("gmail: invalid message id");
}

/** Only the HTTP seams reach `googleFetch` (callers may pass a wider deps object). */
function fetchDeps(deps?: GmailApiDeps): GmailApiDeps | undefined {
  if (!deps || (!deps.fetch && !deps.sleep)) return undefined;
  const out: GmailApiDeps = {};
  if (deps.fetch) out.fetch = deps.fetch;
  if (deps.sleep) out.sleep = deps.sleep;
  return out;
}

/**
 * `users.watch` on the Pub/Sub topic, INBOX only.
 * @param userId owner
 * @param topic `projects/<p>/topics/<t>`
 * @param deps HTTP seam (tests)
 * @returns current mailbox historyId and the watch expiry (epoch ms)
 */
export async function gmailWatch(
  userId: string,
  topic: string,
  deps?: GmailApiDeps,
): Promise<{ historyId: string; expiration: number }> {
  const r = await googleFetch(
    userId,
    {
      method: "POST",
      url: `${GMAIL_BASE}/watch`,
      body: { topicName: topic, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
    },
    WatchResponse,
    fetchDeps(deps),
  );
  const expiration = Number(r.expiration);
  if (!HISTORY_ID_RE.test(r.historyId) || !Number.isFinite(expiration)) {
    throw new GoogleApiError("gmail watch: malformed response", { status: 200, retryable: false });
  }
  return { historyId: r.historyId, expiration };
}

/**
 * `users.stop` (ends push notifications for the mailbox).
 * @param userId owner
 * @param deps HTTP seam (tests)
 */
export async function gmailStop(userId: string, deps?: GmailApiDeps): Promise<void> {
  await googleFetchNoContent(userId, { method: "POST", url: `${GMAIL_BASE}/stop` }, fetchDeps(deps));
}

/**
 * `users.getProfile`.
 * @param userId owner
 * @param deps HTTP seam (tests)
 * @returns mailbox address (lower-cased) and current historyId
 */
export async function gmailProfile(userId: string, deps?: GmailApiDeps): Promise<{ emailAddress: string; historyId: string }> {
  const p = await googleFetch(userId, { url: `${GMAIL_BASE}/profile` }, Profile, fetchDeps(deps));
  if (!HISTORY_ID_RE.test(p.historyId)) {
    throw new GoogleApiError("gmail profile: malformed historyId", { status: 200, retryable: false });
  }
  return { emailAddress: p.emailAddress.trim().toLowerCase(), historyId: p.historyId };
}

/** `listHistory` result: new INBOX message ids since the cursor, and the cursor to store next. */
export type HistoryResult =
  | {
      messageIds: string[];
      /** Cursor to store after the rows are durable. */
      historyId: string;
      /** True when the page cap was hit; `historyId` is then the last record read (resume point). */
      truncated?: boolean;
    }
  | { notFound: true };

/**
 * `users.history.list` (messageAdded, INBOX) from `startHistoryId`, following `nextPageToken`.
 * A 404 (cursor too old / invalid, F11) returns `{notFound: true}` → the caller resyncs.
 * @param userId owner
 * @param startHistoryId stored cursor
 * @param deps HTTP seam (tests)
 * @returns de-duplicated message ids (oldest first) and the next cursor
 */
export async function listHistory(userId: string, startHistoryId: string, deps?: GmailApiDeps): Promise<HistoryResult> {
  if (!HISTORY_ID_RE.test(startHistoryId)) return { notFound: true };
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let lastRecordId: string | null = null;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    let r;
    try {
      r = await googleFetch(
        userId,
        {
          url: `${GMAIL_BASE}/history`,
          query: {
            startHistoryId,
            historyTypes: "messageAdded",
            labelId: "INBOX",
            maxResults: 500,
            pageToken,
          },
        },
        HistoryList,
        fetchDeps(deps),
      );
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 404) return { notFound: true };
      throw e;
    }
    for (const h of r.history ?? []) {
      lastRecordId = h.id;
      for (const a of h.messagesAdded ?? []) {
        const id = a.message.id;
        if (GMAIL_ID_RE.test(id) && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    if (!r.nextPageToken) {
      if (!HISTORY_ID_RE.test(r.historyId)) {
        throw new GoogleApiError("gmail history: malformed historyId", { status: 200, retryable: false });
      }
      return { messageIds: ids, historyId: r.historyId };
    }
    pageToken = r.nextPageToken;
  }
  // Page cap hit: resume after the last record we actually read (records after it come next time).
  if (!lastRecordId || !HISTORY_ID_RE.test(lastRecordId)) return { messageIds: ids, historyId: startHistoryId, truncated: true };
  return { messageIds: ids, historyId: lastRecordId, truncated: true };
}

/**
 * `users.messages.list` with a Gmail search query.
 * @param userId owner
 * @param q Gmail search syntax
 * @param opts max ids to return (≤ 2000)
 * @param deps HTTP seam (tests)
 * @returns message ids, newest first (Gmail order)
 */
export async function listMessageIds(userId: string, q: string, opts: { max: number }, deps?: GmailApiDeps): Promise<string[]> {
  const max = Math.max(0, Math.min(2000, Math.floor(opts.max)));
  const out: string[] = [];
  let pageToken: string | undefined;
  while (out.length < max) {
    const r = await googleFetch(
      userId,
      { url: `${GMAIL_BASE}/messages`, query: { q, maxResults: Math.min(500, max - out.length), pageToken } },
      MessagesList,
      fetchDeps(deps),
    );
    for (const m of r.messages ?? []) if (GMAIL_ID_RE.test(m.id) && out.length < max) out.push(m.id);
    if (!r.nextPageToken || (r.messages ?? []).length === 0) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

/**
 * `users.messages.get?format=metadata` (the §2.9 header set; no body).
 * @param userId owner
 * @param id Gmail message id
 * @param deps HTTP seam (tests)
 * @returns normalized metadata
 */
export async function getMessageMeta(userId: string, id: string, deps?: GmailApiDeps): Promise<EmailMeta> {
  assertMessageId(id);
  const m = await googleFetch(
    userId,
    {
      url: `${GMAIL_BASE}/messages/${id}`,
      query: { format: "metadata", metadataHeaders: [...METADATA_HEADERS] },
    },
    GmailMessageMeta,
    fetchDeps(deps),
  );
  return metaFromGmail(m);
}

/**
 * `users.messages.get?format=full` (payload tree with bodies; for `read_email` only, never stored).
 * @param userId owner
 * @param id Gmail message id
 * @param deps HTTP seam (tests)
 * @returns the validated message
 */
export async function getMessageFull(userId: string, id: string, deps?: GmailApiDeps): Promise<GmailMessageFullT> {
  assertMessageId(id);
  return googleFetch(userId, { url: `${GMAIL_BASE}/messages/${id}`, query: { format: "full" } }, GmailMessageFull, fetchDeps(deps));
}

/**
 * `users.messages.send`. ⚠ Import ONLY from `gmail/send.ts` (see the module header).
 * @param userId owner
 * @param raw base64url RFC 5322 message (`buildRawMessage`)
 * @param threadId Gmail thread to reply into (threading also needs In-Reply-To/References + Re: subject)
 * @param deps HTTP seam (tests)
 * @returns the sent message id and thread id
 */
export async function sendRaw(
  userId: string,
  raw: string,
  threadId?: string,
  deps?: GmailApiDeps,
): Promise<{ id: string; threadId: string }> {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("gmail send: raw must be base64url");
  if (threadId !== undefined && !GMAIL_ID_RE.test(threadId)) throw new Error("gmail send: invalid thread id");
  const r = await googleFetch(
    userId,
    { method: "POST", url: `${GMAIL_BASE}/messages/send`, body: threadId ? { raw, threadId } : { raw } },
    SendResponse,
    fetchDeps(deps),
  );
  return { id: r.id, threadId: r.threadId };
}
