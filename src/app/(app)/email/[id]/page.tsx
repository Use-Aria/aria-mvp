// OWNER: 4.5

/**
 * /email/[id]: review, edit, and send an email draft Aria prepared (web plan §7.7, copy deck §9.5).
 * Reached from an `email_draft` magic link (view scope, 60 min). Non-UUID ids and actions that
 * aren't the viewer's `send_email` draft are a 404 (existence is never revealed). Recipients are
 * read-only; everything in the draft is untrusted text, rendered as escaped plain text only.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "@/app/_components/ExternalLink";
import { FreshLinkNotice } from "@/app/_components/FreshLinkNotice";
import { SignedOut } from "@/app/_components/SignedOut";
import { TextAriaButton } from "@/app/_components/TextAriaButton";
import { Banner } from "@/app/_components/ui/Banner";
import { getDraftView, isDraftId, type DraftView } from "@/server/web/email-data";
import { requireViewer } from "@/server/web/guard";
import { EMAIL_COPY, SHARED_COPY } from "@/shared/copy";
import { DraftEditor, DraftErrorBanner } from "./DraftEditor";

export const metadata: Metadata = { title: EMAIL_COPY.title, robots: { index: false, follow: false } };

const SENDING_COPY = "Sending now. Reload in a minute to see whether it went out.";

function Recipients({ draft }: { draft: DraftView }) {
  const rows: Array<[string, string]> = [
    [EMAIL_COPY.from, draft.from],
    [EMAIL_COPY.to, draft.to.join(", ")],
  ];
  if (draft.cc.length > 0) rows.push([EMAIL_COPY.cc, draft.cc.join(", ")]);
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium text-ink-soft">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {draft.status === "pending" && <p className="text-sm text-ink-soft">{EMAIL_COPY.recipientsHint}</p>}
    </div>
  );
}

function ReadOnlyDraft({ draft }: { draft: DraftView }) {
  return (
    <div className="flex flex-col gap-3 rounded-3xl bg-bubble p-5">
      <p className="break-words text-lg font-semibold">{draft.subject}</p>
      <p className="whitespace-pre-wrap break-words text-base leading-relaxed">{draft.body}</p>
    </div>
  );
}

function StatusBanner({ draft }: { draft: DraftView }) {
  switch (draft.status) {
    case "sent":
      return (
        <Banner tone="ok">
          <strong>Sent</strong>
          {draft.sentAtLabel ? ` at ${draft.sentAtLabel}. ` : ". "}
          Aria also confirmed it in Messages.
        </Banner>
      );
    case "sending":
      // Gmail didn't confirm the send (`send_unconfirmed`): "check your Sent folder", not "sending now".
      return draft.failureCode ? (
        <DraftErrorBanner code={draft.failureCode} />
      ) : (
        <Banner tone="warn">{SENDING_COPY}</Banner>
      );
    case "cancelled":
      return <Banner tone="warn">{EMAIL_COPY.cancelled}</Banner>;
    case "expired":
      return <Banner tone="warn">{EMAIL_COPY.expired}</Banner>;
    case "failed":
      // The specific reason (e.g. Google disconnected → Setup link) survives the post-Send refresh.
      return <DraftErrorBanner code={draft.failureCode ?? "executor_failed"} />;
    default:
      return null;
  }
}

/**
 * @param props route params (`id` = `pending_actions.id`)
 * @returns the draft page, `SignedOut`, or a 404
 */
export default async function EmailDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDraftId(id)) notFound();
  const viewer = await requireViewer();
  if (!viewer) return <SignedOut />;
  const draft = await getDraftView(viewer, id);
  if (!draft) notFound();

  return (
    <>
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{EMAIL_COPY.title}</h1>
        <Recipients draft={draft} />
        {draft.status === "pending" && (
          <p className="text-base text-ink-soft">{EMAIL_COPY.expires(draft.expiresAtLabel)}</p>
        )}
      </div>

      <StatusBanner draft={draft} />

      {draft.status === "pending" ? (
        <>
          {!draft.canSend && <FreshLinkNotice keyword="draft" reason="stale" />}
          <DraftEditor draft={draft} />
        </>
      ) : (
        <ReadOnlyDraft draft={draft} />
      )}

      <div className="flex flex-col gap-4 border-t border-line pt-6">
        {draft.originalPermalink && (
          <ExternalLink href={draft.originalPermalink} allowHosts={["mail.google.com"]}>
            {EMAIL_COPY.originalEmail}
          </ExternalLink>
        )}
        <TextAriaButton body="" label={SHARED_COPY.backToChat} variant="secondary" />
      </div>
    </>
  );
}
