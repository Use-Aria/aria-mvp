import Link from "next/link";
import { HeroThread } from "@/app/_components/HeroThread";
import { SignupForm } from "@/app/_components/SignupForm";
import { optionalEnv } from "@/server/env";
import { toE164 } from "@/server/phone";

export default function Home() {
  const number = optionalEnv("SENDBLUE_FROM_NUMBER");
  const ariaNumber = number ? toE164(number) : null;

  return (
    <main className="mx-auto grid min-h-dvh max-w-5xl grid-cols-[minmax(0,1fr)] content-start gap-12 px-6 pb-[max(3rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))] md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] md:content-center md:items-center md:gap-16 md:py-16">
      <section className="flex max-w-md flex-col gap-8">
        <div className="flex flex-col gap-4">
          <p className="text-xl font-bold tracking-tight text-aria">aria</p>
          <h1 className="text-[2.75rem] font-bold leading-[1.02] tracking-[-0.03em] md:text-6xl">
            Texts you what&apos;s due, before it&apos;s due.
          </h1>
          <p className="text-lg leading-relaxed text-ink-soft">
            Aria is an assistant for college students that lives in iMessage. It reads your
            Canvas calendar, Gmail, and Google Calendar, then texts you the parts that matter.
          </p>
        </div>
        <SignupForm ariaNumber={ariaNumber} />
        <p className="flex gap-4 text-sm text-ink-soft">
          <Link href="/privacy" className="underline underline-offset-4 hover:text-ink">
            Privacy
          </Link>
          <Link href="/terms" className="underline underline-offset-4 hover:text-ink">
            Terms
          </Link>
        </p>
      </section>
      <section className="flex justify-center md:justify-end" aria-label="Example">
        <HeroThread />
      </section>
    </main>
  );
}
