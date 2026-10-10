// OWNER: 1.2
/**
 * GET /aria.vcf — Aria's contact card (V2-03 §7 Routes; Sendblue contact-card guide).
 * The path ends in `.vcf` because Sendblue's `media_url` must carry the right extension. Public,
 * no user data. TEL is the Sendblue line (`SENDBLUE_FROM_NUMBER`); omitted when unset (dev).
 */
import { buildVCard } from "@/server/channels/vcard";
import { appBaseUrl, optionalEnv } from "@/server/env";
import { toE164 } from "@/server/phone";

/**
 * Serves the vCard.
 * @returns `text/vcard` response, cacheable for an hour
 */
export async function GET(): Promise<Response> {
  const line = optionalEnv("SENDBLUE_FROM_NUMBER");
  const body = buildVCard({
    name: "Aria",
    phoneE164: line ? toE164(line) : null,
    url: appBaseUrl(),
    note: "Aria — your AI assistant for school. Deadlines, calendar and reminders, over text.",
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'inline; filename="aria.vcf"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}
