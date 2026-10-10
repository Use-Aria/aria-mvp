import nextJest from "next/jest.js";

// next/jest wires SWC transforms and loads .env files the way Next does.
// (.mjs, not .ts: Jest's native TS config loading needs Node 22.18+.)
const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.tsx"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // ical.js's package entry is ESM; Jest runs CJS, so point it at the bundled CJS build.
    "^ical\\.js$": "<rootDir>/node_modules/ical.js/dist/ical.es5.cjs",
  },
  modulePathIgnorePatterns: ["<rootDir>/mobile/", "<rootDir>/celery_worker/", "<rootDir>/services/"],
};

const base = createJestConfig(config);

// next/jest's transformIgnorePatterns skip all of node_modules; jose is ESM-only, so let SWC
// transform it. (Override after next/jest resolves its config, which would otherwise win.)
const jestConfig = async () => {
  const c = await base();
  c.transformIgnorePatterns = ["/node_modules/(?!(jose)/)", "^.+\\.module\\.(css|sass|scss)$"];
  return c;
};

export default jestConfig;
