import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Pages never inject raw HTML (untrusted third-party text reaches the web views).
    files: ["src/app/**"],
    rules: { "react/no-danger": "error" },
  },
  {
    // Friend-protection 1: email leaves only via the confirmed-pending-action executor.
    // `sendRaw` may be imported by gmail/send.ts alone (also source-scanned in tests/unit/google/mime.test.ts).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/integrations/google/gmail/send.ts", "src/server/integrations/google/gmail/api.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/gmail/api", "./api", "@/server/integrations/google/gmail/api"],
              importNames: ["sendRaw"],
              message: "sendRaw may only be imported by src/server/integrations/google/gmail/send.ts.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
