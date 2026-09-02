import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["src/tests/setup.ts"],
    // Match the existing exclusion in tsconfig, plus the e2e-*.test.ts files:
    // those hit a live deployment (or a real Postgres via a direct
    // PrismaClient) over the network and don't belong in the fast, fully
    // mocked unit-test gate that CI runs on every push. Run them explicitly
    // via `npm run test:e2e` against a real environment when needed.
    exclude: ["node_modules", "dist", "src/tests/e2e-*.test.ts"],
  },
});
