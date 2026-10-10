/**
 * Notice for actions that need a fresher link (copy deck §9.1): connecting accounts needs a
 * < 15 min setup link; edits and Send need a < 60 min link.
 */
import { TextAriaButton } from "@/app/_components/TextAriaButton";
import { SHARED_COPY } from "@/shared/copy";

/**
 * @param props keyword to text Aria, and why the current session isn't enough
 * @returns the notice
 */
export async function FreshLinkNotice({
  keyword,
  reason,
}: {
  keyword: "setup" | "settings" | "draft";
  reason: "stale" | "view_only";
}) {
  const text =
    keyword === "setup"
      ? SHARED_COPY.freshLinkNeeded
      : SHARED_COPY.recentLinkNeeded(keyword === "draft" ? "draft link" : "settings");
  const body = keyword === "draft" ? "draft link" : keyword;
  return (
    <div
      role="status"
      data-reason={reason}
      className="flex flex-col gap-3 rounded-2xl bg-warn-bg px-4 py-4 text-base leading-relaxed"
    >
      <p>{text}</p>
      <TextAriaButton body={body} label={`Text Aria "${body}"`} variant="secondary" />
    </div>
  );
}
