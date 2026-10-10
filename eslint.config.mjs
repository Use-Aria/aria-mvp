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
  globalIgnores([
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "mobile/**",
    "celery_worker/**",
    ".claude/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
