"use client";

/**
 * Top navigation for the signed-in app: Week · Setup · Settings, with `aria-current`.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SHARED_COPY } from "@/shared/copy";

const ITEMS = [
  { href: "/week", label: SHARED_COPY.nav.week },
  { href: "/setup", label: SHARED_COPY.nav.setup },
  { href: "/settings", label: SHARED_COPY.nav.settings },
] as const;

/** @returns the nav */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label={SHARED_COPY.nav.label}>
      <ul className="flex items-center gap-1">
        {ITEMS.map((item) => {
          const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={false}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full px-3 text-base font-medium ${
                  current ? "bg-bubble text-ink" : "text-ink-soft hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
