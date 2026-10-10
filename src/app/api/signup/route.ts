/**
 * POST /api/signup — landing-page form (spec §3.1).
 *
 * Stores a `signups` row (name, E.164 phone, browser timezone, 24h expiry).
 * It is NOT identity: when the person texts Aria, the inbound handle is
 * matched against unexpired signups to greet them by name (§3.2).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { appOrigin } from "@/server/env";
import { toE164 } from "@/server/phone";
import { clientIp, rateLimit } from "@/server/ratelimit";

/** Bump when the disclosure copy on the landing page changes. */
const CONSENT_VERSION = "private-test-2026-10";

const Body = z.object({
  name: z.string().trim().min(1).max(40),
  phone: z.string().trim().min(7).max(25),
  timezone: z.string().max(64).optional(),
});

function validTimezone(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get("origin") !== appOrigin()) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const ip = clientIp(req.headers);
  if (!(await rateLimit(`signup:${ip}`, 5, 600))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const phone = toE164(parsed.data.phone);
  if (!phone) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }

  const { error } = await db().from("signups").insert({
    name: parsed.data.name,
    phone_e164: phone,
    timezone: validTimezone(parsed.data.timezone),
    consent_version: CONSENT_VERSION,
    ip: ip === "unknown" ? null : ip,
    user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
  });
  if (error) {
    console.error("[signup] insert failed:", error.message);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
