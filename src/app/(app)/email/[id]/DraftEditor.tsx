"use client";
// OWNER: 4.5

/**
 * Pending email draft editor (web plan §7.7, copy deck §9.5): subject input, body textarea,
 * Save, Send (disabled while there are unsaved edits or while pending), Cancel (confirm dialog).
 * Recipients are not editable here (the page shows them read-only). Hidden `id` + `version`
 * fields carry the version the user reviewed; when the server copy changes (a save, or Aria
 * revising the draft in chat), the fields reset to the latest version. A send Gmail didn't confirm
 * (`send_unconfirmed`) locks the editor (read-only, no Save/Send/Cancel) under a warning: it may
 * already be out, so nothing here may resend or change it.
 */
import { useActionState, useState } from "react";
import { Banner } from "@/app/_components/ui/Banner";
import { ConfirmDialog } from "@/app/_components/ui/ConfirmDialog";
import { FIELD_CONTROL_CLASS, Field } from "@/app/_components/ui/Field";
import { SubmitButton } from "@/app/_components/ui/SubmitButton";
import type { DraftView } from "@/server/web/email-data";
import type { ActionErrorCode, ActionResult } from "@/shared/action-result";
import { EMAIL_COPY, SHARED_COPY, actionErrorCopy, type BannerTone } from "@/shared/copy";
import { cancelDraftAction, saveDraftAction, sendDraftAction } from "./actions";

const SUBJECT_MAX = 250;
const BODY_MAX = 20_000;

/**
 * Copy and tone for a failed draft action.
 * @param code action error code
 * @returns banner tone and text (`needs_recent_link` asks for a fresh "draft link")
 */
export function draftErrorCopy(code: ActionErrorCode): { tone: BannerTone; text: string } {
  switch (code) {
    case "needs_recent_link":
      return { tone: "warn", text: SHARED_COPY.recentLinkNeeded("draft link") };
    case "version_conflict":
    case "not_pending":
    case "expired":
    case "rate_limited":
    case "same_run":
    case "send_unconfirmed":
      return { tone: "warn", text: actionErrorCopy(code) };
    default:
      return { tone: "error", text: actionErrorCopy(code) };
  }
}

/**
 * Banner for a failed draft action, or for a draft whose send failed (the page renders it with
 * `DraftView.failureCode` after the refresh). `google_disconnected` adds an "Open Setup" link.
 * @param props action error code
 * @returns the banner (takes focus when it appears)
 */
export function DraftErrorBanner({ code }: { code: ActionErrorCode }) {
  const { tone, text } = draftErrorCopy(code);
  return (
    <Banner tone={tone} focusOnMount>
      <p>{text}</p>
      {code === "google_disconnected" && (
        <p className="mt-2">
          <a href="/setup#google" className="font-semibold text-aria underline underline-offset-4">
            Open Setup
          </a>
        </p>
      )}
    </Banner>
  );
}

/**
 * @param props the pending draft (status `pending`)
 * @returns the editor
 */
export function DraftEditor({ draft }: { draft: DraftView }) {
  const [seen, setSeen] = useState({ version: draft.version, subject: draft.subject, body: draft.body });
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [saveState, saveAction] = useActionState<ActionResult<{ version: number }> | null, FormData>(
    saveDraftAction,
    null,
  );
  const [sendState, sendAction] = useActionState<ActionResult<{ sentAtLabel: string }> | null, FormData>(
    sendDraftAction,
    null,
  );
  const [cancelState, cancelAction] = useActionState<ActionResult | null, FormData>(cancelDraftAction, null);

  // The server copy changed (our save, or a revision in chat): show the latest version.
  if (seen.version !== draft.version || seen.subject !== draft.subject || seen.body !== draft.body) {
    setSeen({ version: draft.version, subject: draft.subject, body: draft.body });
    setSubject(draft.subject);
    setBody(draft.body);
  }

  // Gmail didn't confirm the send: it may be out already, so nothing more happens from this page.
  const unconfirmed = sendState?.ok === false && sendState.code === "send_unconfirmed";
  const editable = draft.canSend && !unconfirmed;
  const dirty = subject !== draft.subject || body !== draft.body;
  const rows = Math.min(24, Math.max(8, body.split("\n").length + 1));

  return (
    <div className="flex flex-col gap-6">
      <form action={saveAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={draft.id} />
        <input type="hidden" name="version" value={draft.version} />
        <Field id="draft-subject" label={EMAIL_COPY.subjectLabel}>
          <input
            name="subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value.replace(/[\r\n]+/g, " "))}
            maxLength={SUBJECT_MAX}
            readOnly={!editable}
            autoComplete="off"
            className={FIELD_CONTROL_CLASS}
          />
        </Field>
        <Field id="draft-body" label={EMAIL_COPY.bodyLabel}>
          <textarea
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={BODY_MAX}
            readOnly={!editable}
            rows={rows}
            className={`${FIELD_CONTROL_CLASS} whitespace-pre-wrap break-words py-3 leading-relaxed`}
          />
        </Field>
        {editable && (
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton variant="secondary" pendingLabel={EMAIL_COPY.save.pending} disabled={!dirty}>
              {EMAIL_COPY.save.idle}
            </SubmitButton>
            {saveState?.ok && !dirty && (
              <p role="status" className="text-base text-ink-soft">
                {EMAIL_COPY.save.done}
              </p>
            )}
          </div>
        )}
        {saveState && !saveState.ok && <DraftErrorBanner code={saveState.code} />}
      </form>

      {editable && (
        <form action={sendAction} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={draft.id} />
          <input type="hidden" name="version" value={draft.version} />
          <SubmitButton pendingLabel={EMAIL_COPY.send.pending} disabled={dirty} className="self-start">
            {EMAIL_COPY.send.idle}
          </SubmitButton>
          {dirty && <p className="text-base text-ink-soft">{EMAIL_COPY.sendBlockedDirty}</p>}
          {sendState && !sendState.ok && <DraftErrorBanner code={sendState.code} />}
        </form>
      )}
      {unconfirmed && <DraftErrorBanner code="send_unconfirmed" />}

      {!unconfirmed && (
        <div className="flex flex-col gap-3">
          <div>
            <ConfirmDialog
              trigger={EMAIL_COPY.cancel.button}
              title={EMAIL_COPY.cancel.title}
              confirmLabel={EMAIL_COPY.cancel.confirm}
              cancelLabel={EMAIL_COPY.cancel.keep}
              formAction={cancelAction}
              hidden={{ id: draft.id }}
            >
              {EMAIL_COPY.cancel.body}
            </ConfirmDialog>
          </div>
          {cancelState && !cancelState.ok && <DraftErrorBanner code={cancelState.code} />}
        </div>
      )}
    </div>
  );
}
