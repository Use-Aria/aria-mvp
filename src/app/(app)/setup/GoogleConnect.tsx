// OWNER: 4.5

/**
 * Google section of /setup (web plan §7.4, copy deck §9.2; master plan §1.12, C20). Server component.
 *
 * - The disclosure (what Aria reads / does / never does, AI processing, the unverified-app
 *   warning) renders before the button.
 * - Connect is a plain `<a href="/api/google/oauth">` (GET; never `next/link`, which would
 *   prefetch, and never a form: CSP `form-action 'self'` would block the redirect to Google).
 *   It shows only for a fresh setup session; otherwise the fresh-link notice. The start route
 *   needs `Sec-Fetch-Site`, so Safari < 16.4 can't connect (noted under the button).
 * - `?google=<code>` banners come from an allow-listed code (never echoed query text).
 *   `missing_scopes` is ambiguous (partial grant vs. nothing granted), so the current status
 *   decides which message shows. The param is then stripped from the address bar.
 * - Disconnect is a server action (`disconnectGoogle`, no API route) behind a confirm dialog.
 * - Next to the buttons: "Texting as ••• ••• 1234" (5.5 #13), so someone who opened a forwarded
 *   setup link sees it isn't their account before connecting their Google to it.
 */
import { FreshLinkNotice } from "@/app/_components/FreshLinkNotice";
import { Banner } from "@/app/_components/ui/Banner";
import { Button } from "@/app/_components/ui/Button";
import { ConfirmDialog } from "@/app/_components/ui/ConfirmDialog";
import { Section } from "@/app/_components/ui/Section";
import type { GoogleConnectStatus, GoogleStatusView } from "@/server/integrations/google";
import type { TextingAsView } from "@/server/web/setup-data";
import { GOOGLE_STATUS_COPY, SETUP_COPY, type BannerTone } from "@/shared/copy";
import { cleanText } from "@/shared/safe-url";
import { StripSearchParam } from "./CanvasConnect";
import { disconnectGoogleFormAction } from "./integration-actions";

type Capability = keyof typeof SETUP_COPY.google.capabilities;

/** Google OAuth start (GET, master plan §1.12). */
export const GOOGLE_OAUTH_START = "/api/google/oauth";

/** `missing_scopes` with nothing granted at all (no Google row was kept). */
export const NOTHING_GRANTED_TEXT =
  "Google didn't give Aria access to anything because the boxes were unchecked. Tap Connect Google again and check every box.";

/** Shown under the connect button (the start route needs the `Sec-Fetch-Site` header). */
export const SAFARI_NOTE =
  "Connecting Google needs Safari 16.4 or newer (iOS 16.4 or later). On an older iPhone, update iOS or connect from a laptop.";

const TRIAGE_TEXT = "Aria is reading your recent inbox to learn which emails matter to you.";

function connectedAll(status: Extract<GoogleStatusView, { connected: true }>): Record<Capability, boolean> {
  return {
    readMail: status.canReadMail,
    sendMail: status.canSendMail,
    readCalendar: status.canReadCalendar,
    writeAriaCalendar: status.canWriteAriaCalendar,
  };
}

/**
 * Capabilities the grant lacks, in display order.
 * @param status Google status
 * @returns missing capability keys (empty when not connected or fully granted)
 */
export function missingCapabilities(status: GoogleStatusView): Capability[] {
  if (!status.connected) return [];
  const caps = connectedAll(status);
  return (Object.keys(caps) as Capability[]).filter((k) => !caps[k]);
}

/**
 * "a", "a or b", "a, b, or c".
 * @param items phrases
 * @returns joined phrase
 */
export function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * Banner for a `?google=` callback code, disambiguated by the current status.
 * @param code allow-listed callback code, or null
 * @param status current Google status
 * @returns tone + text, or null when there is no code
 */
export function googleBanner(
  code: GoogleConnectStatus | null,
  status: GoogleStatusView,
): { tone: BannerTone; text: string } | null {
  if (!code) return null;
  const email = status.connected ? cleanText(status.email, 320) || "your Google account" : "";
  const connectedText = (): { tone: BannerTone; text: string } => ({
    tone: "ok",
    text: GOOGLE_STATUS_COPY.connected.text.replace("{email}", email),
  });
  switch (code) {
    case "connected":
      return status.connected ? connectedText() : GOOGLE_STATUS_COPY.error;
    case "missing_scopes": {
      if (!status.connected) return { tone: "warn", text: NOTHING_GRANTED_TEXT };
      const missing = missingCapabilities(status).map((k) => SETUP_COPY.google.missing[k]);
      if (missing.length === 0) return connectedText();
      return { tone: "warn", text: GOOGLE_STATUS_COPY.missing_scopes.text.replace("{missing}", joinOr(missing)) };
    }
    default:
      return GOOGLE_STATUS_COPY[code];
  }
}

function Disclosure({ open }: { open: boolean }) {
  const copy = SETUP_COPY.google;
  return (
    <details open={open} className="rounded-3xl bg-bubble p-5">
      <summary className="min-h-11 cursor-pointer py-2 text-lg font-semibold">What Aria can see and do</summary>
      <div className="mt-3 flex flex-col gap-3 text-base leading-relaxed">
        <p>
          <strong>{copy.readsTitle}</strong> {copy.reads}
        </p>
        <p>
          <strong>{copy.doesTitle}</strong> {copy.does}
        </p>
        <p>
          <strong>{copy.neverTitle}</strong> {copy.never}
        </p>
        <p className="text-ink-soft">{copy.aiProcessing}</p>
      </div>
    </details>
  );
}

function Capabilities({ status }: { status: Extract<GoogleStatusView, { connected: true }> }) {
  const caps = connectedAll(status);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base font-medium">Aria can:</p>
      <ul className="flex flex-col gap-1 text-base">
        {(Object.keys(caps) as Capability[]).map((k) => (
          <li key={k} className={caps[k] ? "" : "text-ink-soft"}>
            <span aria-hidden="true" className="inline-block w-6">
              {caps[k] ? "✓" : "✗"}
            </span>
            {SETUP_COPY.google.capabilities[k]}
            <span className="sr-only">{caps[k] ? " (allowed)" : " (not allowed)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Texting as ••• ••• 1234" plus the "not you?" hint. The masked text is hidden from screen
 * readers, which hear "the number ending in 1234" instead of a row of bullets.
 * @param props the masked handle
 * @returns the account line
 */
export function TextingAs({ who }: { who: TextingAsView }) {
  const copy = SETUP_COPY.google.textingAs;
  const masked = who.kind === "phone" ? copy.phoneMasked(who.last4) : copy.emailMasked(who.domain);
  const spoken = who.kind === "phone" ? copy.phoneSpoken(who.last4) : copy.emailSpoken(who.domain);
  return (
    <div className="flex flex-col gap-1 text-base leading-relaxed" data-testid="texting-as">
      <p className="font-semibold">
        {copy.label} <span aria-hidden="true" className="whitespace-nowrap">{masked}</span>
        <span className="sr-only">{spoken}</span>
      </p>
      <p className="text-ink-soft">{copy.notYou}</p>
    </div>
  );
}

/**
 * @param props Google status, whether this session may connect, the `?google=` callback code, and
 *   the account's masked handle (`textingAs`, shown next to the buttons when known)
 * @returns the Google section (`#google`)
 */
export function GoogleConnect({
  status,
  canChange,
  banner,
  textingAs = null,
}: {
  status: GoogleStatusView;
  canChange: boolean;
  banner: GoogleConnectStatus | null;
  textingAs?: TextingAsView | null;
}) {
  const copy = SETUP_COPY.google;
  const bannerCopy = googleBanner(banner, status);
  const missing = missingCapabilities(status);
  const needsReconnect = !status.connected && status.reason !== "none";

  return (
    <Section
      id="google"
      title={copy.title}
      status={status.connected ? copy.connectedAs(cleanText(status.email, 320)) : copy.notConnected}
      statusTone={status.connected ? (missing.length === 0 ? "ok" : "warn") : needsReconnect ? "warn" : "neutral"}
    >
      {bannerCopy && (
        <Banner tone={bannerCopy.tone} focusOnMount>
          {bannerCopy.text}
        </Banner>
      )}
      {banner && <StripSearchParam name="google" />}

      <p className="text-base leading-relaxed text-ink-soft">{copy.intro}</p>

      {needsReconnect && (
        <p className="rounded-2xl bg-warn-bg px-4 py-3 text-base leading-relaxed">{copy.needsReconnect}</p>
      )}

      {status.connected && (
        <>
          <Capabilities status={status} />
          {status.triage?.running && <p className="text-base text-ink-soft">{TRIAGE_TEXT}</p>}
        </>
      )}

      <Disclosure open={!status.connected} />

      {(!status.connected || missing.length > 0) && (
        <div className="flex flex-col gap-2 text-base leading-relaxed">
          <p>
            <strong>{copy.unverifiedTitle}</strong> {copy.unverified}
          </p>
          <p>{copy.ownAccount}</p>
          <p className="text-ink-soft">{copy.schoolAccounts}</p>
        </div>
      )}

      {canChange ? (
        <div className="flex flex-col gap-3">
          {textingAs && <TextingAs who={textingAs} />}
          <div className="flex flex-wrap gap-3">
            {(!status.connected || missing.length > 0) && (
              <Button as="a" href={GOOGLE_OAUTH_START}>
                {copy.connect}
              </Button>
            )}
            {status.connected && (
              <ConfirmDialog
                trigger={copy.disconnect}
                title={copy.disconnectConfirm.title}
                confirmLabel={copy.disconnectConfirm.confirm}
                cancelLabel={copy.disconnectConfirm.cancel}
                pendingLabel="Disconnecting…"
                formAction={disconnectGoogleFormAction}
              >
                {copy.disconnectConfirm.body}
              </ConfirmDialog>
            )}
          </div>
          {(!status.connected || missing.length > 0) && <p className="text-sm text-ink-soft">{SAFARI_NOTE}</p>}
        </div>
      ) : (
        <FreshLinkNotice keyword="setup" reason="view_only" />
      )}
    </Section>
  );
}
