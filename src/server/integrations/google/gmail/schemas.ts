import "server-only";
// OWNER: 2.5

/**
 * zod schemas for the Gmail REST responses Aria reads (V2-07 §7.3 `gmail/schemas.ts`).
 *
 * Every Gmail response goes through `googleFetch(..., schema)`, so a shape change fails loudly
 * instead of silently producing `undefined`. Unknown keys are stripped. Only the fields Aria
 * uses are declared; everything is optional unless Gmail documents it as always present.
 */
import { z } from "zod";

/** One RFC 5322 header as Gmail returns it. */
export const GmailHeader = z.object({ name: z.string(), value: z.string() });
export type GmailHeaderT = z.infer<typeof GmailHeader>;

/** `MessagePartBody`: `data` is base64url of the (transfer-decoded) part bytes. */
export const GmailPartBody = z.object({
  size: z.number().int().optional(),
  data: z.string().optional(),
  attachmentId: z.string().optional(),
});

/** A MIME part (recursive payload tree of `format=full`). */
export interface GmailMessagePartT {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeaderT[];
  body?: z.infer<typeof GmailPartBody>;
  parts?: GmailMessagePartT[];
}
export const GmailMessagePart: z.ZodType<GmailMessagePartT> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(GmailHeader).optional(),
    body: GmailPartBody.optional(),
    parts: z.array(GmailMessagePart).optional(),
  }),
);

/** `users.messages.get?format=metadata` (headers only; no body data). */
export const GmailMessageMeta = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  /** Epoch milliseconds, as a decimal string. */
  internalDate: z.string().optional(),
  sizeEstimate: z.number().int().optional(),
  payload: z
    .object({
      mimeType: z.string().optional(),
      headers: z.array(GmailHeader).optional(),
    })
    .optional(),
});
export type GmailMessageMetaT = z.infer<typeof GmailMessageMeta>;

/** `users.messages.get?format=full` (payload tree with body data). */
export const GmailMessageFull = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  sizeEstimate: z.number().int().optional(),
  payload: GmailMessagePart.optional(),
});
export type GmailMessageFullT = z.infer<typeof GmailMessageFull>;

const MessageRef = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

/** `users.history.list` page. `historyId` is the mailbox's current history id. */
export const HistoryList = z.object({
  history: z
    .array(
      z.object({
        id: z.string(),
        messagesAdded: z.array(z.object({ message: MessageRef })).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
});
export type HistoryListT = z.infer<typeof HistoryList>;

/** `users.messages.list` page. */
export const MessagesList = z.object({
  messages: z.array(MessageRef).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().optional(),
});
export type MessagesListT = z.infer<typeof MessagesList>;

/** `users.watch` response. `expiration` is epoch ms (int64, serialized as a string). */
export const WatchResponse = z.object({
  historyId: z.string(),
  expiration: z.union([z.string(), z.number()]),
});
export type WatchResponseT = z.infer<typeof WatchResponse>;

/** `users.getProfile` response. */
export const Profile = z.object({
  emailAddress: z.string(),
  messagesTotal: z.number().int().optional(),
  threadsTotal: z.number().int().optional(),
  historyId: z.string(),
});
export type ProfileT = z.infer<typeof Profile>;

/** `users.messages.send` response. */
export const SendResponse = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
});
export type SendResponseT = z.infer<typeof SendResponse>;

/** Pub/Sub push envelope (`POST /api/google/gmail-push` body). */
export const PubSubPushBody = z.object({
  message: z.object({
    data: z.string().optional(),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});
export type PubSubPushBodyT = z.infer<typeof PubSubPushBody>;
