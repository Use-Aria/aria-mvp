"use server";

/**
 * Sign-out server actions (web plan §2.1 G1). Both clear this browser's cookie and land on
 * /signed-out. Signing out is allowed from any session; a cross-site POST is refused.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { appOrigin } from "@/server/env";
import {
  clearedSessionCookie,
  currentSessionRaw,
  revokeAllSessions,
  revokeSession,
} from "@/server/security/sessions";
import { originMatches, requireActionViewer } from "@/server/web/guard";

async function clearCookie(): Promise<void> {
  const c = clearedSessionCookie();
  (await cookies()).set(c.name, c.value, c.options);
}

/**
 * Sign out on this device: revoke the current session row, clear the cookie.
 * @returns never (redirects to /signed-out)
 */
export async function signOut(): Promise<never> {
  if (!originMatches((await headers()).get("origin"), appOrigin())) redirect("/signed-out");
  const raw = await currentSessionRaw();
  if (raw) {
    try {
      await revokeSession(raw);
    } catch (err) {
      console.error("[signOut] revoke failed:", err instanceof Error ? err.message : "unknown");
    }
  }
  await clearCookie();
  redirect("/signed-out");
}

/**
 * Sign out every browser that opened an Aria link for this user.
 * @returns never (redirects to /signed-out)
 */
export async function signOutEverywhere(): Promise<never> {
  const guard = await requireActionViewer("any");
  if (guard.ok) {
    await revokeAllSessions(guard.viewer.userId);
    await clearCookie();
  } else if (guard.code === "signed_out") {
    await clearCookie();
  }
  redirect("/signed-out");
}
