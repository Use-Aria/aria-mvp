/**
 * POST /api/session/redeem — consume a magic-link token, start a session.
 *
 * Called by a navigational form POST from /m (the token was in the URL
 * fragment). Responds 303 to the link's target with the session cookie, or
 * 303 to /link-expired. GET is intentionally not handled: preview fetchers
 * must never be able to burn a token (spec §3.6).
 */
import { NextResponse, type NextRequest } from "next/server";
import { appBaseUrl, appOrigin } from "@/server/env";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { redeemMagicLink } from "@/server/security/magic-links";
import { SESSION_COOKIE, createSession, readSession } from "@/server/security/sessions";

function redirect(path: string): NextResponse {
  const res = NextResponse.redirect(`${appBaseUrl()}${path}`, 303);
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get("origin") !== appOrigin()) {
    return new NextResponse("Bad origin", { status: 403 });
  }
  if (!(await rateLimit(`redeem:${clientIp(req.headers)}`, 20, 60))) {
    return new NextResponse("Too many requests", { status: 429 });
  }

  let token = "";
  try {
    const form = await req.formData();
    const value = form.get("t");
    token = typeof value === "string" ? value : "";
  } catch {
    return redirect("/link-expired");
  }

  try {
    const existing = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
    const result = await redeemMagicLink(token);

    if (result.ok) {
      const res = redirect(result.target);
      const cookie = await createSession(result.userId, result.scope);
      res.cookies.set(cookie.name, cookie.value, cookie.options);
      return res;
    }
    // Re-opening an old link from a browser already signed in as that user
    // still works: the session grants access, the link only routes.
    if (existing && result.userId === existing.userId && result.target) {
      return redirect(result.target);
    }
    return redirect("/link-expired");
  } catch (err) {
    console.error("[redeem] failed:", err);
    return redirect("/link-expired");
  }
}
