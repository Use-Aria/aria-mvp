/**
 * POST /api/signup — landing-page form (spec §3.1).
 *
 * Stores a `signups` row (name, E.164 phone, browser timezone, 24h expiry).
 * It is NOT identity: when the person texts Aria, the inbound handle is
 * matched against unexpired signups to greet them by name (§3.2), and the
 * welcome asks them to confirm that name (`pipeline/welcome.ts`).
 *
 * Abuse limits (5.5 #7: anyone can type anyone's number):
 * - per IP: 5 per 10 min (Upstash; skipped in dev, fails closed in prod);
 * - per phone: at most {@link PHONE_SIGNUPS_PER_DAY} stored rows in a rolling
 *   24h, counted in the DB so the limit holds everywhere;
 * - a phone that already belongs to an Aria user (a channel exists) is never
 *   stored again, so a re-signup can't set that user's name or consent.
 * Both phone cases answer `{ok:true}` without storing, so the form never
 * reveals whether a number is already signed up or texting Aria.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { appOrigin } from "@/server/env";
import { maskHandle, toE164 } from "@/server/phone";
import { clientIp, rateLimit } from "@/server/ratelimit";

/** Bump when the disclosure copy on the landing page changes. */
const CONSENT_VERSION = "private-test-2026-10";

/** Signup rows stored per phone in a rolling window of {@link PHONE_WINDOW_MS}. */
const PHONE_SIGNUPS_PER_DAY = 3;
const PHONE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Every channel kind (`channels.kind` check), so the lookup uses the `(kind, handle)` unique index. */
const CHANNEL_KINDS = ["imessage", "sms", "whatsapp"];

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

/** `store`: insert the row. `known`: the phone already has an Aria user. `limited`: per-phone cap hit. */
type PhoneDecision = "store" | "known" | "limited";

/**
 * Decides whether a signup for this phone may be stored.
 * @param phone E.164 phone
 * @param now clock (ms)
 * @returns the decision
 * @throws on a DB error (the caller answers 500)
 */
async function phoneDecision(phone: string, now: number): Promise<PhoneDecision> {
  const [channel, recent] = await Promise.all([
    db().from("channels").select("id").in("kind", CHANNEL_KINDS).eq("handle", phone).limit(1),
    db()
      .from("signups")
      .select("id", { count: "exact", head: true })
      .eq("phone_e164", phone)
      .gte("created_at", new Date(now - PHONE_WINDOW_MS).toISOString()),
  ]);
  if (channel.error) throw new Error(`channel lookup: ${channel.error.message}`);
  if (recent.error) throw new Error(`signup count: ${recent.error.message}`);
  if ((channel.data ?? []).length > 0) return "known";
  return (recent.count ?? 0) >= PHONE_SIGNUPS_PER_DAY ? "limited" : "store";
}

/**
 * Landing-page signup.
 * @param req JSON `{name, phone, timezone?}` with `Origin` = the app origin
 * @returns `{ok:true}` (stored, or skipped by a per-phone rule), or `{error}` with 400/403/429/500
 */
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

  try {
    const decision = await phoneDecision(phone, Date.now());
    if (decision !== "store") {
      console.warn(`[signup] not stored (${decision}) for ${maskHandle(phone)}`);
      return NextResponse.json({ ok: true });
    }

    const { error } = await db().from("signups").insert({
      name: parsed.data.name,
      phone_e164: phone,
      timezone: validTimezone(parsed.data.timezone),
      consent_version: CONSENT_VERSION,
      ip: ip === "unknown" ? null : ip,
      user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    });
    if (error) throw new Error(`insert: ${error.message}`);
  } catch (err) {
    console.error("[signup] failed:", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
