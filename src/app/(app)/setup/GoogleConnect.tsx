// OWNER: 4.5 (placeholder by 1.6 with final props; 4.5 replaces the body per web plan §7.4)

/**
 * Google section of /setup: disclosure, unverified-app warning, connect `<a href="/api/google/oauth">`
 * (only when `canChange`), callback banner, connected capabilities. Server component.
 * Placeholder: status, banner, and the fresh-link notice until 4.5 lands.
 */
import { FreshLinkNotice } from "@/app/_components/FreshLinkNotice";
import { Banner } from "@/app/_components/ui/Banner";
import { Section } from "@/app/_components/ui/Section";
import type { GoogleConnectStatus, GoogleStatusView } from "@/server/integrations/google";
import { ACTION_ERROR_COPY, GOOGLE_STATUS_COPY, SETUP_COPY } from "@/shared/copy";

/**
 * @param props Google status, whether this session may connect, and the `?google=` callback code
 * @returns the Google section (`#google`)
 */
export async function GoogleConnect({
  status,
  canChange,
  banner,
}: {
  status: GoogleStatusView;
  canChange: boolean;
  banner: GoogleConnectStatus | null;
}) {
  const copy = SETUP_COPY.google;
  const bannerCopy = banner ? GOOGLE_STATUS_COPY[banner] : null;
  return (
    <Section
      id="google"
      title={copy.title}
      status={status.connected ? copy.connectedAs(status.email) : copy.notConnected}
      statusTone={status.connected ? "ok" : "neutral"}
    >
      {bannerCopy && (
        <Banner tone={bannerCopy.tone}>
          {bannerCopy.text
            .replace("{email}", status.connected ? status.email : "your account")
            .replace("{missing}", "do everything")}
        </Banner>
      )}
      <p className="text-base leading-relaxed text-ink-soft">{copy.intro}</p>
      {canChange ? (
        <p className="text-base text-ink-soft">{ACTION_ERROR_COPY.unavailable}</p>
      ) : (
        <FreshLinkNotice keyword="setup" reason="view_only" />
      )}
    </Section>
  );
}
