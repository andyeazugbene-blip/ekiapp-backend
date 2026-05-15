import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["src/tests/setup.ts"],
    // Match the existing exclusion in tsconfig
    exclude: ["node_modules", "dist"],
  },
});
