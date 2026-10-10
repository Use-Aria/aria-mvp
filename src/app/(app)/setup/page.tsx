import type { Metadata } from "next";
import { SignedOut } from "@/app/_components/SignedOut";
import { TextAriaButton } from "@/app/_components/TextAriaButton";
import { optionalEnv } from "@/server/env";
import { requireViewer } from "@/server/web/guard";
import { getSetupView } from "@/server/web/setup-data";
import { SETUP_COPY, SHARED_COPY, parseGoogleConnectCode } from "@/shared/copy";
import { CanvasConnect } from "./CanvasConnect";
import { GoogleConnect } from "./GoogleConnect";
import { ScheduleForm } from "./ScheduleForm";
import { SyllabusUpload } from "./SyllabusUpload";
import { ToneForm } from "./ToneForm";

export const metadata: Metadata = { title: "Set up Aria", robots: { index: false, follow: false } };

type Search = Promise<{ google?: string | string[] }>;

/**
 * /setup (web plan §7.4). Each section is its own component at its final path and owns its
 * `<Section>`: Canvas + Google (4.5), Syllabus (3.5), Schedule + Tone (4.4).
 */
export default async function SetupPage({ searchParams }: { searchParams: Search }) {
  const viewer = await requireViewer();
  if (!viewer) return <SignedOut ask="setup" />;
  const { google } = await searchParams;
  const banner = parseGoogleConnectCode(Array.isArray(google) ? google[0] : google);
  const view = await getSetupView(viewer);

  return (
    <>
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{SETUP_COPY.title}</h1>
        <p className="max-w-prose text-lg leading-relaxed text-ink-soft">{SETUP_COPY.intro}</p>
        {view.freshUntilLabel && (
          <p role="status" className="text-base text-ink-soft">
            {SHARED_COPY.freshUntil(view.freshUntilLabel)}
          </p>
        )}
      </div>
      <CanvasConnect school={view.school} status={view.canvas} canChange={view.canChange} />
      <GoogleConnect status={view.google} canChange={view.canChange} banner={banner} />
      <SyllabusUpload />
      <ScheduleForm schedule={view.schedule} />
      <ToneForm tone={view.tone} />
      {optionalEnv("SENDBLUE_FROM_NUMBER") && (
        <div className="flex flex-col gap-3 border-t border-line pt-8">
          <p className="text-lg font-semibold">{SETUP_COPY.footer.prompt}</p>
          <TextAriaButton body="" label={SETUP_COPY.footer.button} variant="secondary" />
        </div>
      )}
    </>
  );
}
