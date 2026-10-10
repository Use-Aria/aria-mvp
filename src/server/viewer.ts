import "server-only";
/**
 * The signed-in person viewing a web page. Server-only. OWNER: 1.6.
 * `currentViewer` is wrapped in React `cache()`, so `generateMetadata`, layouts, and the
 * page share one DB round trip per request.
 */
import { cache } from "react";
import { db } from "@/server/db";
import { currentSession, type WebSession } from "@/server/security/sessions";
import { safeTimeZone } from "@/shared/time/tz";

export interface Viewer {
  session: WebSession;
  userId: string;
  name: string | null;
  /** Always a valid IANA zone (falls back to the default zone). */
  timezone: string;
  /** `user_profile.school`, when known. */
  school: string | null;
}

/**
 * Current viewer, or null when the browser has no valid session (or the user is gone).
 * Cached per request.
 */
export const currentViewer: () => Promise<Viewer | null> = cache(async (): Promise<Viewer | null> => {
  const session = await currentSession();
  if (!session) return null;
  const [user, profile] = await Promise.all([
    db().from("users").select("name, timezone, deleted_at").eq("id", session.userId).maybeSingle(),
    db().from("user_profile").select("school").eq("user_id", session.userId).maybeSingle(),
  ]);
  if (user.error || !user.data || user.data.deleted_at) {
    if (user.error) console.error("[viewer] user lookup failed:", user.error.message);
    return null;
  }
  if (profile.error) console.error("[viewer] profile lookup failed:", profile.error.message);
  return {
    session,
    userId: session.userId,
    name: user.data.name,
    timezone: safeTimeZone(user.data.timezone),
    school: profile.data?.school ?? null,
  };
});
