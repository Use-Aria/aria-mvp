/**
 * Link to an external site (Canvas, Google) that renders as `<a>` only when
 * `safeExternalUrl` accepts the URL; otherwise the children render as plain text.
 * Opens in a new tab with `noopener noreferrer`.
 */
import type { ReactNode } from "react";
import { safeExternalUrl } from "@/shared/safe-url";

/**
 * @param props untrusted href, host allow-list, link content, and an optional accessible label
 * @returns a safe link, or plain text
 */
export function ExternalLink({
  href,
  allowHosts,
  children,
  label,
  className = "text-aria underline underline-offset-4",
}: {
  href: string | null | undefined;
  allowHosts: readonly string[];
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  const safe = safeExternalUrl(href, allowHosts);
  if (!safe) return <span>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" aria-label={label} className={className}>
      {children}
    </a>
  );
}
