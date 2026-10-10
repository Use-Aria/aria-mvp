import type { MetadataRoute } from "next";

/** robots.txt: the landing page is public; APIs are not. Private pages also send `noindex`. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: "/api/" } };
}
