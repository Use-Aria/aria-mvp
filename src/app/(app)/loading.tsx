/** Skeleton while an app page loads (static bars; no shimmer, so nothing moves under reduced motion). */
export default function AppLoading() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-6">
      <div className="h-10 w-2/3 rounded-xl bg-bubble" />
      <div className="h-5 w-full rounded-lg bg-bubble" />
      <div className="h-5 w-5/6 rounded-lg bg-bubble" />
      <div className="mt-4 h-28 w-full rounded-2xl bg-bubble" />
      <div className="h-28 w-full rounded-2xl bg-bubble" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
