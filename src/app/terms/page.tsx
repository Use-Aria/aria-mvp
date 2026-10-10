import type { Metadata } from "next";
import Link from "next/link";
import { LegalSection } from "@/app/_components/LegalSection";
import { PlainPage } from "@/app/_components/PlainPage";

export const metadata: Metadata = {
  title: "Terms",
  description: "The ground rules for Aria's private test.",
};

/** Minimal plain-language terms for the private test (master plan §6 D5). */
export default function TermsPage() {
  return (
    <PlainPage center={false}>
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">Terms</h1>
        <p className="text-lg leading-relaxed text-ink-soft">
          Aria is a free private test run by Daniel Lee. By texting Aria you agree to these ground rules.
          Last updated October 10, 2026.
        </p>
      </div>

      <LegalSection title="It's a test">
        <p>
          Aria is early software. It can be wrong, late, or down, and it can change or stop at any time.
          Don&apos;t rely on it alone for deadlines: Canvas and your professors are the source of truth.
          Aria is provided as is, with no warranty.
        </p>
      </LegalSection>

      <LegalSection title="Your accounts, your call">
        <p>
          Connect only your own Canvas and Google accounts. You&apos;re responsible for emails you tell
          Aria to send; it sends only after you confirm.
        </p>
      </LegalSection>

      <LegalSection title="Messages">
        <p>
          Aria texts you briefings, reminders, and alerts. Reply STOP anytime to stop, and START to
          resume. Message and data rates may apply.
        </p>
      </LegalSection>

      <LegalSection title="Fair use">
        <p>
          Don&apos;t use Aria to harass anyone, break the law, or try to break Aria. Daniel may pause an
          account that does.
        </p>
      </LegalSection>

      <LegalSection title="Privacy">
        <p>
          See the{" "}
          <Link href="/privacy" className="text-aria underline underline-offset-4">
            privacy page
          </Link>{" "}
          for what Aria keeps and how to delete it.
        </p>
      </LegalSection>
    </PlainPage>
  );
}
