import type { Metadata } from "next";
import { PlainPage } from "@/app/_components/PlainPage";
import { SHARED_COPY } from "@/shared/copy";

export const metadata: Metadata = { title: "Signed out", robots: { index: false, follow: false } };

/** Landing after sign out (this phone or everywhere). */
export default function SignedOutPage() {
  return (
    <PlainPage>
      <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{SHARED_COPY.signedOutPage.title}</h1>
      <p className="max-w-prose text-lg leading-relaxed text-ink-soft">{SHARED_COPY.signedOutPage.body}</p>
    </PlainPage>
  );
}
