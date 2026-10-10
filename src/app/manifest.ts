import type { MetadataRoute } from "next";

/**
 * Web app manifest (web plan §7.2). No service worker and no install prompt: Add to Home
 * Screen opens /week, which shows the PWA sign-in copy when the app has no cookie.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "aria",
    name: "Aria",
    short_name: "Aria",
    description: "An assistant for college students that lives in your texts.",
    start_url: "/week?src=pwa",
    scope: "/",
    display: "standalone",
    background_color: "#f2f4ef",
    theme_color: "#f2f4ef",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
