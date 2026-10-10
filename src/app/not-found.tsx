import type { Metadata } from "next";
import Link from "next/link";
import { PlainPage } from "@/app/_components/PlainPage";
import { TextAriaButton } from "@/app/_components/TextAriaButton";
import { SHARED_COPY } from "@/shared/copy";

export const metadata: Metadata = { title: "Nothing here", robots: { index: false, follow: false } };

/** 404 for unknown URLs and `notFound()` (copy deck §9.1). */
export default function NotFound() {
  const copy = SHARED_COPY.notFound;
  return (
    <PlainPage>
      <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{copy.title}</h1>
      <p className="max-w-prose text-lg leading-relaxed text-ink-soft">{copy.body}</p>
      <div className="flex flex-wrap items-center gap-4">
        <TextAriaButton body="new link" label={copy.button} />
        <Link href="/" className="inline-flex min-h-11 items-center text-aria underline underline-offset-4">
          {copy.home}
        </Link>
      </div>
    </PlainPage>
  );
}
