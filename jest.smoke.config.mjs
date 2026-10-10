import nextJest from "next/jest.js";

// Smoke tests hit a real Supabase project with throwaway rows (deleted afterwards).
// Same base as jest.config.mjs; only the test match and timeout differ.
const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/smoke/**/*.smoke.test.ts"],
  testTimeout: 120000,
  // Wave gates run `npm run smoke` before any smoke file exists.
  passWithNoTests: true,
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
