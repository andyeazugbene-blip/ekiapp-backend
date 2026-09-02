import { defineConfig } from "vitest/config";

// Separate config for the e2e-*.test.ts files: these hit a live deployment
// or a real Postgres database directly and are NOT run by the default
// `npm test` / CI gate (see vitest.config.ts's exclude list). Run explicitly
// with `npm run test:e2e` against a real environment (set DATABASE_URL /
// TEST_DATABASE_URL as needed) — never wire this into automatic CI.
export default defineConfig({
  test: {
    setupFiles: ["src/tests/setup.ts"],
    include: ["src/tests/e2e-*.test.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
