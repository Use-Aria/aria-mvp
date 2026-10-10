import "server-only";
// OWNER: 3.6
/**
 * `GET /api/google/oauth` — start Google sign-in (master plan §1.12, §2 C20; V2-07 §2.3).
 *
 * `/setup` links here with a plain `<a>` (CSP `form-action 'self'` rules out a form POST that
 * redirects to Google). Guards, in order:
 * 1. `Sec-Fetch-Site` must be `same-origin` (the `/setup` link) or `none` (typed / bookmarked).
 *    Anything else, or a missing header, → 403. A cross-site GET could at most start a consent
 *    flow for the victim's own account; the callback is bound to this browser and session anyway.
 * 2. A `fresh_setup` session (setup scope, < 15 min). Otherwise → 303 `/setup?google=stale`.
 * Then: encrypted PKCE/nonce cookie + HMAC state (`beginGoogleOAuth`), 303 to Google with
 * `Cache-Control: no-store`. Other methods get Next's automatic 405.
 */
import { NextResponse, type NextRequest } from "next/server";
import { appBaseUrl } from "@/server/env";
import type { GoogleConnectStatus } from "@/server/integrations/google";
import { beginGoogleOAuth } from "@/server/integrations/google/oauth/flow";
import { readSession, SESSION_COOKIE } from "@/server/security/sessions";
import { sessionFailsNeed } from "@/server/web/guard";

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function toSetup(code: GoogleConnectStatus): NextResponse {
  return noStore(NextResponse.redirect(`${appBaseUrl()}/setup?google=${code}`, 303));
}

/**
 * Start the OAuth flow.
 * @param req incoming request (cookies + `Sec-Fetch-Site`)
 * @returns 303 to Google (with the OAuth cookie), 303 to `/setup?google=stale|error`, or 403
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const site = req.headers.get("sec-fetch-site");
  if (!site || !ALLOWED_FETCH_SITES.has(site.toLowerCase())) {
    return noStore(new NextResponse("Forbidden", { status: 403 }));
  }

  const rawSessionId = req.cookies.get(SESSION_COOKIE)?.value;
  const session = rawSessionId ? await readSession(rawSessionId) : null;
  if (!rawSessionId || !session || sessionFailsNeed(session, "fresh_setup") !== null) return toSetup("stale");

  try {
    const { url, cookie } = beginGoogleOAuth({ userId: session.userId, rawSessionId });
    const res = noStore(NextResponse.redirect(url, 303));
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (e) {
    // e.g. GOOGLE_CLIENT_ID unset. Never log the state or cookie.
    console.error(`[google] oauth start failed user=${session.userId}: ${e instanceof Error ? e.message : "error"}`);
    return toSetup("error");
  }
}
