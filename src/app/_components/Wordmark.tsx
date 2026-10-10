/** The lowercase "aria" wordmark. Links home unless `href` is null. */
import Link from "next/link";

/**
 * @param props where the wordmark links (default "/"; null for plain text)
 * @returns the wordmark
 */
export function Wordmark({ href = "/" }: { href?: string | null }) {
  const mark = <span className="text-xl font-bold tracking-tight text-aria">aria</span>;
  if (href === null) return <p>{mark}</p>;
  return (
    <Link href={href} prefetch={false} className="inline-flex min-h-11 items-center" aria-label="Aria home">
      {mark}
    </Link>
  );
}
