"use client";
// OWNER: 4.5 (placeholder by 1.6 with final props; 4.5 replaces the body per web plan §7.4)

/**
 * Canvas section of /setup: school picker, Calendar Feed guide, paste + connect, status.
 * Placeholder: shows status and points to chat until 4.5 lands.
 */
import { Section } from "@/app/_components/ui/Section";
import type { CanvasStatusView } from "@/server/integrations/canvas";
import { ACTION_ERROR_COPY, SETUP_COPY } from "@/shared/copy";

/**
 * @param props the user's school (picker default), Canvas status, and whether this session may connect
 * @returns the Canvas section (`#canvas`)
 */
export function CanvasConnect({
  school,
  status,
  canChange,
}: {
  school: string | null;
  status: CanvasStatusView;
  canChange: boolean;
}) {
  const copy = SETUP_COPY.canvas;
  return (
    <Section
      id="canvas"
      title={copy.title}
      status={status.connected ? copy.connected : copy.notConnected}
      statusTone={status.connected ? (status.health === "ok" ? "ok" : "warn") : "neutral"}
    >
      <p className="text-base leading-relaxed text-ink-soft">{copy.intro}</p>
      {status.connected && <p className="text-base">Connected to {status.host}.</p>}
      <p className="text-base text-ink-soft" data-school={school ?? ""} data-can-change={canChange}>
        {ACTION_ERROR_COPY.unavailable} {copy.guideAlt}
      </p>
    </Section>
  );
}
