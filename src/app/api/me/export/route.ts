/**
 * POST /api/me/export — "Download my data" on /settings (web plan §7.6, §2.2 exception 1, §2.6;
 * master plan §1.18). A Route Handler because a Server Action can't answer with an attachment.
 *
 * Posted by a plain same-origin `<form method="post">`. Order: Origin === appOrigin() and a
 * `fresh_setup` session (`requireActionViewer`) → 3 exports per user per hour → JSON attachment
 * `aria-export-YYYY-MM-DD.json` with `Cache-Control: no-store`. Refusals other than a bad Origin
 * 303 back to `/settings?export=<code>` (an allow-listed code the page turns into copy), so a
 * stale tab never lands on a bare error body. The export never contains tokens, encrypted
 * secrets, hashes, the Canvas feed URL, sessions, links, jobs, or LLM logs (`shapeExport`).
 */
import type { NextRequest } from "next/server";
import { collectAccountExport } from "@/server/account/export";
import { appBaseUrl } from "@/server/env";
import { rateLimit } from "@/server/ratelimit";
import { requireActionViewer } from "@/server/web/guard";
import type { ExportRefusal } from "@/server/web/settings-data";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Exports allowed per user per hour (web §2.6). */
const EXPORT_LIMIT = 3;
const EXPORT_WINDOW_SEC = 3600;

function backToSettings(code: ExportRefusal): Response {
  return new Response(null, {
    status: 303,
    headers: { location: new URL(`/settings?export=${code}`, appBaseUrl()).toString(), "cache-control": "no-store" },
  });
}

function localDate(timeZone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Download everything Aria stores about the signed-in user.
 * @param req the form POST (the guard reads its Origin and cookie through `next/headers`)
 * @returns the JSON attachment, a 303 back to /settings with a code, or 403 for a foreign Origin
 */
export async function POST(req: NextRequest): Promise<Response> {
  void req;
  const guard = await requireActionViewer("fresh_setup");
  if (!guard.ok) {
    if (guard.code === "bad_origin") {
      return new Response("That request didn't come from Aria.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return backToSettings(guard.code === "needs_recent_link" ? "needs_fresh_link" : guard.code);
  }
  const { viewer } = guard;
  if (!(await rateLimit(`export:${viewer.userId}`, EXPORT_LIMIT, EXPORT_WINDOW_SEC))) return backToSettings("rate_limited");

  let body: string;
  try {
    body = JSON.stringify(await collectAccountExport(viewer.userId), null, 2);
  } catch (e) {
    console.error(`[export] failed: ${e instanceof Error ? e.message.slice(0, 160) : "unknown"}`);
    return backToSettings("server");
  }
  const filename = `aria-export-${localDate(viewer.timezone, new Date())}.json`;
  console.info("[export] account export downloaded");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
