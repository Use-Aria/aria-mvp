import path from "node:path";
import { fileURLToPath } from "node:url";
import nextJest from "next/jest.js";

// Evals v0 (V2-04 §7.5, §10.3; master plan Wave 5 row 5.1): direct-mode agent turns against the
// LOCAL Supabase stack + the real Anthropic API (ANTHROPIC_API_KEY must be exported; every eval
// file skips without it). Same base as jest.smoke.config.mjs; separate match so neither
// `npm test` nor `npm run smoke` ever picks these up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const createJestConfig = nextJest({ dir: repoRoot });

/** @type {import('jest').Config} */
const config = {
  // This file lives in evals/, so <rootDir> must be pinned to the repo root.
  rootDir: repoRoot,
  testEnvironment: "node",
  testMatch: ["<rootDir>/evals/**/*.eval.ts"],
  // A case runs up to 3 samples of a multi-turn conversation against the real model.
  testTimeout: 600000,
  globalSetup: "<rootDir>/evals/harness/global-setup.ts",
  globalTeardown: "<rootDir>/evals/harness/report.ts",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^ical\\.js$": "<rootDir>/node_modules/ical.js/dist/ical.es5.cjs",
  },
  modulePathIgnorePatterns: ["<rootDir>/mobile/", "<rootDir>/celery_worker/", "<rootDir>/services/"],
};

const base = createJestConfig(config);

const jestConfig = async () => {
  const c = await base();
  c.transformIgnorePatterns = ["/node_modules/(?!(jose)/)", "^.+\\.module\\.(css|sass|scss)$"];
  return c;
};

export default jestConfig;
