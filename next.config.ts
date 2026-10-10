import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Static CSP, no nonce (web plan §2.6): a nonce needs proxy.ts and makes every page dynamic.
 * The real XSS defenses are React escaping, no dangerouslySetInnerHTML (eslint), and the
 * external-URL allow-list. `form-action 'self'` is why Google connect is a GET <a>, and the
 * /m redeem form (same-origin POST → 303 same-origin) still works under it. Dev needs
 * 'unsafe-eval' (React debug stacks) and ws: for HMR.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // same-origin, not no-referrer: no-referrer makes browsers send
          // `Origin: null` on form POSTs, which breaks the redeem Origin check.
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
