import type { Metadata } from "next";
import { SignedOut } from "@/app/_components/SignedOut";
import { Button } from "@/app/_components/ui/Button";
import { requireViewer } from "@/server/web/guard";
import { WEEK_COPY } from "@/shared/copy";

export const metadata: Metadata = { title: "Your week", robots: { index: false, follow: false } };

type Search = Promise<{ w?: string; src?: string }>;

// Placeholder shell until task 4.4 builds the real /week (timeline groups, load bars, mark done).
export default async function WeekPage({ searchParams }: { searchParams: Search }) {
  const { src } = await searchParams;
  const viewer = await requireViewer();
  if (!viewer) return <SignedOut pwa={src === "pwa"} />;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{WEEK_COPY.title(viewer.name)}</h1>
      <div className="flex flex-col gap-4 rounded-3xl bg-bubble p-5">
        <p className="text-lg font-semibold">{WEEK_COPY.emptyNoCanvas.title}</p>
        <p className="text-base text-ink-soft">{WEEK_COPY.emptyNoCanvas.body}</p>
        <Button as="a" href="/setup#canvas" className="self-start">
          {WEEK_COPY.emptyNoCanvas.button}
        </Button>
      </div>
    </div>
  );
}
