"use client";

/**
 * "Delete my account" (web plan §7.6, copy deck §9.4): a native `<dialog>` confirm that stays
 * disabled until the user types "delete". The server action re-checks the session (`fresh_setup`)
 * and the typed word, deletes, clears the cookie, and redirects to /account-deleted.
 */
import { useActionState } from "react";
import { ConfirmDialog } from "@/app/_components/ui/ConfirmDialog";
import type { ActionResult } from "@/shared/action-result";
import { SETTINGS_COPY, actionErrorCopy } from "@/shared/copy";
import { deleteAccountAction } from "./actions";

const COPY = SETTINGS_COPY.deleteAccount;

/**
 * @param props whether the session may delete the account (a < 15 min setup link)
 * @returns the delete trigger + dialog, or nothing without a fresh session (the page shows the notice)
 */
export function DeleteAccount({ canChange }: { canChange: boolean }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(deleteAccountAction, null);
  if (!canChange) return null;
  const error = state && !state.ok ? (state.code === "invalid" ? COPY.typeError : actionErrorCopy(state.code)) : null;
  return (
    <div className="flex flex-col gap-3">
      <ConfirmDialog
        trigger={COPY.confirm}
        triggerVariant="danger"
        title={COPY.dialogTitle}
        confirmLabel={COPY.confirm}
        cancelLabel={COPY.cancel}
        pendingLabel="Deleting…"
        requireText="delete"
        requireLabel={COPY.dialogBody}
        formAction={action}
      >
        {error && (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        )}
      </ConfirmDialog>
      {error && <p className="text-base text-danger">{error}</p>}
    </div>
  );
}
