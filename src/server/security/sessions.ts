import "server-only";
/**
 * Server-side web sessions (spec §3.6). Server-only. OWNER: 1.6 (master plan §1.15).
 *
 * The cookie holds a random 256-bit id; the DB stores only its SHA-256.
 * Cookie: `__Host-aria` in production (HttpOnly; Secure; SameSite=Lax; Path=/).
 * Local dev over plain http can't set `__Host-` cookies, so it uses `aria`.
 */
import { cookies } from "next/headers";
import { db } from "@/server/db";
import { isProduction } from "@/server/env";
import { randomToken, sha256Hex } from "@/server/security/crypto";
import {
  SESSION_TTL_MS,
  SETUP_FRESH_MS,
  type SessionScope,
} from "@/server/security/link-policy";

export const SESSION_COOKIE = isProduction ? "__Host-aria" : "aria";

export interface WebSession {
  userId: string;
  scope: SessionScope;
  createdAt: Date;
}

export interface SessionCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    expires: Date;
  };
}

/** Create a session row and return the cookie to set on the response. */
export async function createSession(
  userId: string,
  scope: SessionScope,
): Promise<SessionCookie> {
  const id = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const { error } = await db().from("web_sessions").insert({
    session_hash: sha256Hex(id),
    user_id: userId,
    scope,
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw new Error(`createSession failed: ${error.message}`);
  return {
    name: SESSION_COOKIE,
    value: id,
    options: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    },
  };
}

/** Look up a live session by its raw cookie value (null if absent/expired/revoked). */
export async function readSession(rawId: string | undefined): Promise<WebSession | null> {
  if (!rawId) return null;
  const { data, error } = await db()
    .from("web_sessions")
    .select("user_id, scope, created_at, expires_at, revoked_at, users!inner(deleted_at)")
    .eq("session_hash", sha256Hex(rawId))
    .maybeSingle();
  if (error) {
    console.error("[session] lookup failed:", error.message);
    return null;
  }
  if (!data || data.revoked_at || data.users.deleted_at) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  return {
    userId: data.user_id,
    scope: data.scope === "setup" ? "setup" : "view",
    createdAt: new Date(data.created_at),
  };
}

/**
 * The raw session id from the current request's cookie (never log it).
 * @returns the cookie value, or undefined when absent
 */
export async function currentSessionRaw(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value || undefined;
}

/** The current request's session, from the cookie store. */
export async function currentSession(): Promise<WebSession | null> {
  return readSession(await currentSessionRaw());
}

/**
 * Revoke one session by its raw cookie value ("sign out on this phone"). Idempotent.
 * @param rawId the cookie value
 */
export async function revokeSession(rawId: string): Promise<void> {
  if (!rawId) return;
  const { error } = await db()
    .from("web_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("session_hash", sha256Hex(rawId))
    .is("revoked_at", null);
  if (error) throw new Error(`revokeSession failed: ${error.message}`);
}

/**
 * A cookie that deletes the session cookie (same name, path, and flags; expired).
 * @returns cookie to set on the response
 */
export function clearedSessionCookie(): {
  name: string;
  value: "";
  options: SessionCookie["options"];
} {
  return {
    name: SESSION_COOKIE,
    value: "",
    options: { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", expires: new Date(0) },
  };
}

/** Setup-scope sessions may connect/disconnect integrations for 15 minutes. */
export function canChangeIntegrations(session: WebSession): boolean {
  return (
    session.scope === "setup" &&
    Date.now() - session.createdAt.getTime() < SETUP_FRESH_MS
  );
}

/** Revoke every session for a user ("sign me out everywhere"). */
export async function revokeAllSessions(userId: string): Promise<void> {
  const { error } = await db()
    .from("web_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeAllSessions failed: ${error.message}`);
}
