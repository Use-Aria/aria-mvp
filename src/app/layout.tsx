import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import { siteUrl } from "@/server/web/site";
import { ogImageFor } from "@/server/security/link-policy";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz"],
});

const DESCRIPTION = "An assistant for college students that lives in your texts.";
const LANDING_OG = {
  url: ogImageFor("landing"),
  width: 1200,
  height: 630,
  alt: "Aria: texts you what's due, before it's due.",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: "Aria",
  description: DESCRIPTION,
  referrer: "same-origin",
  applicationName: "Aria",
  appleWebApp: { capable: true, title: "Aria", statusBarStyle: "default" },
  openGraph: {
    title: "Aria",
    description: DESCRIPTION,
    url: "/",
    siteName: "Aria",
    type: "website",
    images: [LANDING_OG],
  },
  twitter: {
    card: "summary_large_image",
    title: "Aria",
    description: DESCRIPTION,
    images: [LANDING_OG.url],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f4ef" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1a14" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${bricolage.variable} antialiased`}>{children}</body>
    </html>
  );
}
