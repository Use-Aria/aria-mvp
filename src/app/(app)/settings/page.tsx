import type { Metadata } from "next";
import { SignedOut } from "@/app/_components/SignedOut";
import { TextAriaButton } from "@/app/_components/TextAriaButton";
import { Banner } from "@/app/_components/ui/Banner";
import { Button, buttonClass } from "@/app/_components/ui/Button";
import { Section } from "@/app/_components/ui/Section";
import { SubmitButton } from "@/app/_components/ui/SubmitButton";
import { requireViewer } from "@/server/web/guard";
import { getSettingsView, parseExportRefusal, type ExportRefusal } from "@/server/web/settings-data";
import { SETTINGS_COPY, SHARED_COPY, actionErrorCopy } from "@/shared/copy";
import { signOut, signOutEverywhere } from "../session-actions";
import { DeleteAccount } from "./DeleteAccount";
import { MemoryList } from "./MemoryList";

export const metadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

type Search = Promise<{ export?: string | string[] }>;

function exportRefusalCopy(code: ExportRefusal): string {
  return code === "needs_fresh_link" ? SETTINGS_COPY.export.needsFresh : actionErrorCopy(code);
}

/** Notice + "Text Aria \"settings\"" for actions that need a fresher link. */
async function NeedsLink({ text }: { text: string }) {
  return (
    <div role="status" className="flex flex-col gap-3 rounded-2xl bg-warn-bg px-4 py-4 text-base leading-relaxed">
      <p>{text}</p>
      <TextAriaButton body="settings" label={SHARED_COPY.signedOut.settings.button} variant="secondary" />
    </div>
  );
}

/**
 * /settings (web plan §7.6, copy deck §9.4): connected accounts, what Aria knows (with edit and
 * delete), sign out, export, and account deletion. Pages read with any session; each action
 * re-checks its own freshness level.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const viewer = await requireViewer();
  if (!viewer) return <SignedOut ask="settings" />;
  const { export: exportParam } = await searchParams;
  const refusal = parseExportRefusal(exportParam);
  const view = await getSettingsView(viewer);
  const { memory } = view;
  const acc = SETTINGS_COPY.accounts;
  const mem = SETTINGS_COPY.memory;

  return (
    <>
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{SETTINGS_COPY.title}</h1>
        {refusal && (
          <Banner tone={refusal === "server" ? "error" : "warn"} focusOnMount>
            {exportRefusalCopy(refusal)}
          </Banner>
        )}
      </div>

      <Section id="accounts" title={acc.title}>
        <ul className="flex flex-col gap-2 text-base">
          <li className="break-words">{view.canvas.connected ? acc.canvasConnected(view.canvas.host) : acc.canvasNot}</li>
          <li className="break-words">{view.google.connected ? acc.googleConnected(view.google.email) : acc.googleNot}</li>
        </ul>
        <Button as="a" href="/setup" variant="secondary" className="self-start">
          {acc.manage}
        </Button>
      </Section>

      <Section id="memory" title={mem.title}>
        <p className="max-w-prose text-base leading-relaxed text-ink-soft">{mem.intro}</p>
        {!view.isRecent && !memory.empty && <NeedsLink text={mem.editNeedsRecent} />}
        {memory.empty ? (
          <p className="text-base leading-relaxed">{mem.empty}</p>
        ) : (
          <>
            {(memory.profile.name || memory.profile.school || memory.profile.courses.length > 0) && (
              <div className="flex flex-col gap-1" role="group" aria-labelledby="memory-profile">
                <h3 id="memory-profile" className="text-lg font-semibold">
                  {mem.profileTitle}
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
                  {memory.profile.name && (
                    <>
                      <dt className="text-ink-soft">{mem.name}</dt>
                      <dd className="break-words">{memory.profile.name}</dd>
                    </>
                  )}
                  {memory.profile.school && (
                    <>
                      <dt className="text-ink-soft">{mem.school}</dt>
                      <dd className="break-words">{memory.profile.school}</dd>
                    </>
                  )}
                  {memory.profile.courses.length > 0 && (
                    <>
                      <dt className="text-ink-soft">{mem.courses}</dt>
                      <dd className="break-words">{memory.profile.courses.join(", ")}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}
            <MemoryList
              memory={{ preferences: memory.preferences, proposed: memory.proposed, facts: memory.facts }}
              isRecent={view.isRecent}
            />
          </>
        )}
      </Section>

      <Section id="sign-out" title={SETTINGS_COPY.signOut.title}>
        <div className="flex flex-wrap gap-3">
          <form action={signOut}>
            <SubmitButton variant="secondary" pendingLabel="Signing out…">
              {SHARED_COPY.signOut}
            </SubmitButton>
          </form>
          <form action={signOutEverywhere}>
            <SubmitButton variant="secondary" pendingLabel="Signing out…">
              {SHARED_COPY.signOutEverywhere.label}
            </SubmitButton>
          </form>
        </div>
        <p className="text-sm text-ink-soft">{SHARED_COPY.signOutEverywhere.hint}</p>
      </Section>

      <Section id="export" title={SETTINGS_COPY.export.title}>
        <p className="max-w-prose text-base leading-relaxed">{SETTINGS_COPY.export.body}</p>
        {view.canChange ? (
          // A plain form POST: the route answers with the attachment (or 303s back with a code).
          <form method="post" action="/api/me/export">
            <button type="submit" className={buttonClass("secondary")}>
              {SETTINGS_COPY.export.button}
            </button>
          </form>
        ) : (
          <NeedsLink text={SETTINGS_COPY.export.needsFresh} />
        )}
      </Section>

      <Section id="delete-account" title={SETTINGS_COPY.deleteAccount.title}>
        <p className="max-w-prose text-base leading-relaxed">{SETTINGS_COPY.deleteAccount.body}</p>
        {view.canChange ? <DeleteAccount canChange={view.canChange} /> : <NeedsLink text={SETTINGS_COPY.deleteAccount.needsFresh} />}
      </Section>
    </>
  );
}
