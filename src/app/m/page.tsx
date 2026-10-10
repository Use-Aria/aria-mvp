/**
 * /m — magic-link landing. Renders generic OG tags (an aggregate count at
 * most, from non-secret query params) and never touches the token on the
 * server: the token is in the fragment and redeemed by RedeemForm's POST.
 */
import type { Metadata } from "next";
import { PlainPage } from "@/app/_components/PlainPage";
import { ogImageFor, previewTitle } from "@/server/security/link-policy";
import { RedeemForm } from "./RedeemForm";

type Search = Promise<{ k?: string; n?: string }>;

const DESCRIPTION = "Tap to open in Aria.";

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const { k, n } = await searchParams;
  const kind = typeof k === "string" ? k : undefined;
  const title = previewTitle(kind, typeof n === "string" ? n : undefined);
  const image = { url: ogImageFor(kind), width: 1200, height: 630, alt: title };
  return {
    title,
    description: DESCRIPTION,
    robots: { index: false, follow: false },
    openGraph: { title, description: DESCRIPTION, siteName: "Aria", type: "website", images: [image] },
    twitter: { card: "summary_large_image", title, description: DESCRIPTION, images: [image.url] },
  };
}

export default function MagicLinkPage() {
  return (
    <PlainPage>
      <RedeemForm />
    </PlainPage>
  );
}
