import "server-only";
// OWNER: 2.5

/**
 * Gmail ingest, shared by history sync (push/periodic), 404 resync and inbox triage
 * (V2-07 §2.9 steps 4–5, §2.10; AUD-19).
 *
 * 1. `INSERT … ON CONFLICT (user_id, gmail_message_id) DO NOTHING RETURNING` — only rows THIS
 *    call inserted proceed, so duplicate pushes, overlapping push/periodic runs and triage never
 *    process (or alert) the same email twice.
 * 2. Fetch metadata (concurrency 8, deadline-aware), prefilter, store metadata only — never a
 *    body or snippet. Skipped rows get `importance='skipped'` + `classified_at`.
 * 3. `classifyIngested` (task 4.3; persists the classification), then `alertHighImportance`
 *    for alert-eligible sources (push: <24h old; resync: <2h old; triage: never).
 *
 * Failure semantics: a metadata failure throws after the batch (the caller then does not advance
 * the cursor). Rows still `classified_at IS NULL AND importance IS NULL` and younger than a day
 * are picked up again by `listPendingEmailItems` on the next sync. Rows not reached before the
 * deadline stay pending the same way (`deferred`).
 */
import { db } from "@/server/db";
import { getProfile } from "@/server/memory";
import { UNIVERSITIES } from "@/shared/universities";
import { getGoogleIntegration } from "@/server/integrations/google/store";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getMessageMeta, GMAIL_ID_RE, type GmailApiDeps } from "@/server/integrations/google/gmail/api";
import { formatAddress } from "@/server/integrations/google/gmail/headers";
import { prefilterEmail, type PrefilterContext } from "@/server/integrations/google/gmail/prefilter";
import { classifyIngested } from "@/server/integrations/google/gmail/classify";
import { alertHighImportance } from "@/server/integrations/google/gmail/alerts";
import type { ClassifiedEmail, EmailMeta, PrefilterHint } from "@/server/integrations/google/gmail/types";

/** Where an `email_items` row came from (`email_items.source` check constraint). */
export type IngestSource = "push" | "triage" | "resync";

/** A row this pipeline still has to process. */
export interface PendingEmailItem {
  id: string;
  gmail_message_id: string;
  source: IngestSource;
}

/** Ingest knobs (tests / job budget). */
export interface IngestDeps extends GmailApiDeps {
  /** Epoch ms after which no new metadata fetch starts (job `ctx.deadline`). */
  deadline?: number;
  /** Max rows processed in one call (the rest stay pending). Default 200. */
  maxProcess?: number;
  now?: () => Date;
}

/** Result of one ingest call. */
export interface IngestResult {
  /** Rows this call inserted (new to Aria). */
  inserted: number;
  /** Rows that passed the prefilter and went to the classifier. */
  candidates: number;
  classified: ClassifiedEmail[];
  /** Alerts sent by `alertHighImportance`. */
  alerted: number;
  /** Inserted rows left pending (deadline / cap) for the next sync. */
  deferred: number;
}

const META_CONCURRENCY = 8;
const DEFAULT_MAX_PROCESS = 200;
/** Stop starting metadata fetches this long before the job deadline. */
const DEADLINE_MARGIN_MS = 8_000;
const PENDING_MAX_AGE_MS = 24 * 60 * 60_000;
const PUSH_ALERT_MAX_AGE_MS = 24 * 60 * 60_000;
const RESYNC_ALERT_MAX_AGE_MS = 2 * 60 * 60_000;
const INSERT_CHUNK = 500;
const SUBJECT_MAX = 500;
const FROM_MAX = 320;

function isSource(v: string): v is IngestSource {
  return v === "push" || v === "triage" || v === "resync";
}

function toPending(rows: { id: string; gmail_message_id: string; source: string }[]): PendingEmailItem[] {
  return rows.map((r) => ({ id: r.id, gmail_message_id: r.gmail_message_id, source: isSource(r.source) ? r.source : "push" }));
}

/**
 * Insert one row per new Gmail id (`ON CONFLICT DO NOTHING`); returns only the rows this call created.
 * @param userId owner
 * @param ids Gmail message ids (invalid / duplicate ids are dropped)
 * @param source row source
 * @returns inserted rows (empty when every id already existed)
 */
export async function insertEmailItems(userId: string, ids: readonly string[], source: IngestSource): Promise<PendingEmailItem[]> {
  const uniq = [...new Set(ids.filter((id) => GMAIL_ID_RE.test(id)))];
  const out: PendingEmailItem[] = [];
  for (let i = 0; i < uniq.length; i += INSERT_CHUNK) {
    const chunk = uniq.slice(i, i + INSERT_CHUNK);
    const { data, error } = await db()
      .from("email_items")
      .upsert(
        chunk.map((gmail_message_id) => ({ user_id: userId, gmail_message_id, source })),
        { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true },
      )
      .select("id, gmail_message_id, source");
    if (error) throw new Error(`insertEmailItems: ${error.message}`);
    out.push(...toPending(data ?? []));
  }
  return out;
}

/**
 * Rows a previous run inserted but never finished (metadata/classification failed or deferred),
 * younger than a day, oldest first.
 * @param userId owner
 * @param now logical now
 * @param limit max rows
 * @returns pending rows
 */
export async function listPendingEmailItems(userId: string, now: Date, limit: number): Promise<PendingEmailItem[]> {
  const { data, error } = await db()
    .from("email_items")
    .select("id, gmail_message_id, source")
    .eq("user_id", userId)
    .is("classified_at", null)
    .is("importance", null)
    .gt("created_at", new Date(now.getTime() - PENDING_MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listPendingEmailItems: ${error.message}`);
  return toPending(data ?? []);
}

/** Gmail's tab for a message, from its CATEGORY_* label. */
function categoryOf(labels: readonly string[]): string | null {
  const c = labels.find((l) => l.startsWith("CATEGORY_"));
  return c ? c.slice("CATEGORY_".length).toLowerCase() : null;
}

/** School email domains derived from the profile's school (non-.edu schools need this). */
function schoolDomainsFor(school: string | null): string[] {
  if (!school) return [];
  const u = UNIVERSITIES.find((x) => x.name.toLowerCase() === school.toLowerCase());
  if (!u || u.canvasDomain.endsWith("instructure.com")) return [];
  return [u.canvasDomain.split(".").slice(-2).join(".")];
}

/**
 * Prefilter context for a user: the connected address, profile courses, school domains.
 * @param userId owner
 * @returns context, or null when the user has no Google integration
 */
export async function loadPrefilterContext(userId: string): Promise<PrefilterContext | null> {
  const [integ, profile] = await Promise.all([getGoogleIntegration(userId), getProfile(userId)]);
  if (!integ) return null;
  return {
    selfEmail: (integ.account_email ?? "").toLowerCase(),
    courses: profile.courses,
    schoolDomains: schoolDomainsFor(profile.school),
  };
}

/** Run `fn` over `items` with bounded concurrency; `shouldStart` gates each new task. */
async function mapPool<T>(items: readonly T[], limit: number, shouldStart: () => boolean, fn: (t: T) => Promise<void>): Promise<number> {
  let next = 0;
  let started = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && shouldStart()) {
      const item = items[next++];
      started++;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return started;
}

async function updateRow(userId: string, id: string, patch: Record<string, string | string[] | null>): Promise<void> {
  const { error } = await db().from("email_items").update(patch).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(`email_items update: ${error.message}`);
}

/** Alert-eligible per source (V2-07 §2.10 alert rule; resync only very recent mail; triage never). */
function alertEligible(source: IngestSource, receivedAt: Date, now: Date): boolean {
  const age = now.getTime() - receivedAt.getTime();
  if (source === "push") return age <= PUSH_ALERT_MAX_AGE_MS;
  if (source === "resync") return age <= RESYNC_ALERT_MAX_AGE_MS;
  return false;
}

/**
 * Fetch metadata → prefilter → store metadata → classify → alert, for rows already inserted.
 * @param userId owner
 * @param rows pending rows (from `insertEmailItems` or `listPendingEmailItems`)
 * @param deps HTTP seam, deadline, cap
 * @returns counts + classifications; `deferred` rows were not reached (still pending)
 * @throws the first metadata/DB error after the batch (rows done so far stay updated)
 */
export async function processEmailItems(
  userId: string,
  rows: readonly PendingEmailItem[],
  deps: IngestDeps = {},
): Promise<Omit<IngestResult, "inserted">> {
  const now = deps.now?.() ?? new Date();
  if (rows.length === 0) return { candidates: 0, classified: [], alerted: 0, deferred: 0 };
  const ctx = await loadPrefilterContext(userId);
  if (!ctx) return { candidates: 0, classified: [], alerted: 0, deferred: rows.length };

  const work = rows.slice(0, deps.maxProcess ?? DEFAULT_MAX_PROCESS);
  const deadline = deps.deadline ?? Number.POSITIVE_INFINITY;
  const candidates: { id: string; meta: EmailMeta; hint: PrefilterHint; source: IngestSource }[] = [];
  let firstError: unknown = null;

  const started = await mapPool(
    work,
    META_CONCURRENCY,
    () => firstError === null && Date.now() < deadline - DEADLINE_MARGIN_MS,
    async (row) => {
      try {
        let meta: EmailMeta;
        try {
          meta = await getMessageMeta(userId, row.gmail_message_id, deps);
        } catch (e) {
          if (e instanceof GoogleApiError && e.status === 404) {
            // Deleted between history and fetch: nothing to classify.
            await updateRow(userId, row.id, {
              importance: "skipped",
              prefilter_reason: "skip:gone",
              classified_at: new Date().toISOString(),
            });
            return;
          }
          throw e;
        }
        const decision = prefilterEmail(meta, ctx);
        await updateRow(userId, row.id, {
          thread_id: meta.threadId,
          from_addr: meta.from ? formatAddress(meta.from).slice(0, FROM_MAX) : null,
          subject: meta.subject.slice(0, SUBJECT_MAX),
          category: categoryOf(meta.labels),
          labels: meta.labels,
          received_at: meta.internalDate.toISOString(),
          rfc822_message_id: meta.messageId,
          prefilter_reason: decision.reason,
          ...(decision.decision === "skip" ? { importance: "skipped", classified_at: new Date().toISOString() } : {}),
        });
        if (decision.decision === "classify") candidates.push({ id: row.id, meta, hint: decision.hint, source: row.source });
      } catch (e) {
        firstError ??= e;
      }
    },
  );
  if (firstError !== null) throw firstError;
  const deferred = rows.length - started;

  if (candidates.length === 0) return { candidates: 0, classified: [], alerted: 0, deferred };
  const classified = await classifyIngested(
    userId,
    candidates.map(({ id, meta, hint }) => ({ id, meta, hint })),
  );
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const eligible = classified.filter((c) => {
    const src = byId.get(c.id);
    return src !== undefined && alertEligible(src.source, src.meta.internalDate, now);
  });
  const alerted = await alertHighImportance(userId, eligible);
  return { candidates: candidates.length, classified, alerted, deferred };
}

/**
 * Ingest Gmail message ids for a user: insert-dedupe, then process only the rows this call inserted.
 * @param userId owner
 * @param ids Gmail message ids
 * @param source `push` (history sync), `resync` (404 recovery) or `triage`
 * @param deps HTTP seam, deadline, cap (tests / job budget)
 * @returns counts + classifications (see `IngestResult`)
 */
export async function ingestMessages(
  userId: string,
  ids: string[],
  source: IngestSource,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const rows = await insertEmailItems(userId, ids, source);
  const r = await processEmailItems(userId, rows, deps);
  return { inserted: rows.length, ...r };
}
