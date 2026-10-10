import type { Metadata } from "next";
import { headers } from "next/headers";
import { PlainPage } from "@/app/_components/PlainPage";
import { optionalEnv } from "@/server/env";
import { toE164 } from "@/server/phone";
import { detectPlatform, smsLink } from "@/shared/sms-link";

export const metadata: Metadata = {
  title: "Link expired",
  robots: { index: false, follow: false },
};

export default async function LinkExpiredPage() {
  const number = optionalEnv("SENDBLUE_FROM_NUMBER");
  const ariaNumber = number ? toE164(number) : null;
  const platform = detectPlatform((await headers()).get("user-agent") ?? "");

  return (
    <PlainPage>
      <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">That link expired.</h1>
      <p className="text-lg leading-relaxed text-ink-soft">
        Links from Aria work once and expire after a few minutes, so nobody else can open them.
        Text Aria for a new one.
      </p>
      {ariaNumber && (
        <a
          href={smsLink(ariaNumber, "new link", platform)}
          className="inline-flex h-14 items-center justify-center self-start rounded-full bg-aria px-8 text-lg font-semibold text-aria-ink"
        >
          Text Aria for a new link
        </a>
      )}
    </PlainPage>
  );
}
