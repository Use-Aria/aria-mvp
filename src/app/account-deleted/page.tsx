import type { Metadata } from "next";
import { PlainPage } from "@/app/_components/PlainPage";
import { Button } from "@/app/_components/ui/Button";
import { SETTINGS_COPY } from "@/shared/copy";

export const metadata: Metadata = { title: "Account deleted", robots: { index: false, follow: false } };

type Search = Promise<{ g?: string }>;

/** After account deletion. `?g=0` means Google didn't confirm the token revoke. */
export default async function AccountDeletedPage({ searchParams }: { searchParams: Search }) {
  const { g } = await searchParams;
  const copy = SETTINGS_COPY.deletedPage;
  return (
    <PlainPage>
      <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{copy.title}</h1>
      <p className="max-w-prose text-lg leading-relaxed text-ink-soft">{copy.body}</p>
      {g === "0" && (
        <div className="flex flex-col gap-3 rounded-2xl bg-warn-bg px-4 py-4">
          <p className="text-base leading-relaxed">{copy.revokeFailed}</p>
          <Button
            as="a"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
            className="self-start"
          >
            {copy.revokeButton}
          </Button>
        </div>
      )}
    </PlainPage>
  );
}
