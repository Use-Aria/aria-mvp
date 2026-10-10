/**
 * "Text Aria" button: an `sms:` link with a prefilled body that opens the Aria thread in
 * Messages. Server component (reads the user agent for the iOS/Android `sms:` syntax).
 * Renders nothing when Aria's number isn't configured.
 */
import { headers } from "next/headers";
import { Button, type ButtonVariant } from "@/app/_components/ui/Button";
import { optionalEnv } from "@/server/env";
import { toE164 } from "@/server/phone";
import { detectPlatform, formatNumber, smsLink } from "@/shared/sms-link";

/**
 * @param props prefilled message body ("" just opens the thread), button label, and variant
 * @returns the button, or null without `SENDBLUE_FROM_NUMBER`
 */
export async function TextAriaButton({
  body,
  label,
  variant = "primary",
}: {
  body: string;
  label: string;
  variant?: ButtonVariant;
}) {
  const raw = optionalEnv("SENDBLUE_FROM_NUMBER");
  const number = raw ? toE164(raw) : null;
  if (!number) return null;
  const platform = detectPlatform((await headers()).get("user-agent") ?? "");
  if (platform === "desktop") {
    return (
      <p className="text-base text-ink-soft">
        {body ? (
          <>
            From your phone, text <strong className="text-ink">{formatNumber(number)}</strong> &ldquo;{body}&rdquo;.
          </>
        ) : (
          <>
            Aria&apos;s number is <strong className="text-ink">{formatNumber(number)}</strong>.
          </>
        )}
      </p>
    );
  }
  return (
    <Button as="a" href={smsLink(number, body, platform)} variant={variant} className="self-start">
      {label}
    </Button>
  );
}
