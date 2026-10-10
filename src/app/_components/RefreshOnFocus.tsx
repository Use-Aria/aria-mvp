"use client";

/**
 * Re-renders the route from the server when the page comes back: on a bfcache restore
 * (so Back after sign out can't show a signed-in page) and when the tab becomes visible
 * after more than a minute away (coming back from Messages).
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const STALE_MS = 60_000;

/** @returns nothing visible */
export function RefreshOnFocus() {
  const router = useRouter();
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) router.refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (hiddenAt !== null && Date.now() - hiddenAt > STALE_MS) {
        hiddenAt = null;
        router.refresh();
      }
    };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);
  return null;
}
