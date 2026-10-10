/**
 * POST /api/syllabus/upload — `/setup` syllabus upload (V2-08 §7.2, §2.13; master plan §1.18).
 *
 * A Route Handler, not a Server Action: actions default to a 1 MB body, route handlers get the
 * platform's 4.5 MB. Multipart fields: `file` (PDF, ≤ SYLLABUS_UPLOAD_MAX_BYTES), `courseHint?`,
 * `replace?` ("1" after the user confirmed replacing the saved syllabus of the hinted course).
 *
 * Order: Origin + session (`requireActionViewer("any")`) → declared size (before reading) →
 * multipart → size + `%PDF-` → `runSyllabusIntake({source: "upload"})` synchronously (shares the
 * daily parse limit with chat) → JSON `{ok, status, code?, bubbles}`. Successful parses are also
 * posted into the chat thread (`deliver`, non-proactive) after the response.
 * Never logs the file name, bytes or syllabus text.
 */
import { after } from "next/server";
import { deliver, textPlan } from "@/server/channels";
import { syllabusSettings } from "@/server/integrations/syllabus/config";
import { renderSyllabusConfirmation } from "@/server/integrations/syllabus/confirm";
import { runSyllabusIntake } from "@/server/integrations/syllabus/intake";
import { looksLikePdf } from "@/server/integrations/syllabus/pdf";
import type { IntakeOutcome } from "@/server/integrations/syllabus/types";
import { requireActionViewer } from "@/server/web/guard";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Multipart overhead allowed on top of the file cap when checking `Content-Length`. */
const MULTIPART_SLACK = 64 * 1024;
/** Stop starting parser work this long after the request began (maxDuration 300s). */
const BUDGET_MS = 285_000;

/** Response body of the upload route (the client component renders it). */
export type SyllabusUploadResponse =
  | { ok: true; status: IntakeOutcome["status"]; bubbles: string[]; canReplace?: boolean }
  | { ok: false; code: string; status?: IntakeOutcome["status"]; bubbles?: string[] };

function reply(body: SyllabusUploadResponse, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Upload one syllabus PDF and parse it now.
 * @param req multipart request from `/setup`
 * @returns JSON result (200 for every intake outcome except the rate limit, 4xx for request errors)
 */
export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  const guard = await requireActionViewer("any");
  if (!guard.ok) return reply({ ok: false, code: guard.code }, guard.code === "bad_origin" ? 403 : 401);
  const viewer = guard.viewer;

  const settings = syllabusSettings();
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > settings.uploadMaxBytes + MULTIPART_SLACK) {
    return reply({ ok: false, code: "too_large" }, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reply({ ok: false, code: "invalid" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return reply({ ok: false, code: "invalid" }, 400);
  if (file.size > settings.uploadMaxBytes) return reply({ ok: false, code: "too_large" }, 413);
  const hintRaw = form.get("courseHint");
  const courseHint = typeof hintRaw === "string" ? hintRaw.trim().slice(0, 80) : "";
  const replace = form.get("replace") === "1";

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!looksLikePdf(bytes)) return reply({ ok: false, code: "not_pdf" }, 400);

  let outcome: IntakeOutcome;
  try {
    outcome = await runSyllabusIntake({
      userId: viewer.userId,
      bytes,
      source: "upload",
      ...(file.name ? { filename: file.name } : {}),
      ...(courseHint ? { courseHint } : {}),
      replace,
      deadline: started + BUDGET_MS,
      signal: req.signal,
    });
  } catch (e) {
    console.error(`[syllabus] upload intake failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    return reply({ ok: false, code: "server" }, 500);
  }

  const bubbles = renderSyllabusConfirmation(outcome, viewer.timezone);
  if (outcome.status === "rate_limited") return reply({ ok: false, code: "rate_limited", status: outcome.status, bubbles }, 429);
  if (outcome.status === "ok" || outcome.status === "needs_review") {
    const userId = viewer.userId;
    const key = `syl_up:${outcome.syllabusId}:${started}`;
    after(async () => {
      try {
        const r = await deliver(userId, textPlan(bubbles), { proactive: false, reason: "syllabus_parsed", dedupeKey: key });
        if (r.status === "failed") console.warn("[syllabus] upload confirmation not delivered to chat");
      } catch {
        console.warn("[syllabus] upload confirmation delivery threw");
      }
    });
  }
  if (outcome.status === "failed") return reply({ ok: false, code: outcome.code, status: outcome.status, bubbles }, 200);
  const canReplace = outcome.status === "exists" && outcome.reason === "same_course";
  return reply({ ok: true, status: outcome.status, bubbles, ...(canReplace ? { canReplace } : {}) }, 200);
}
