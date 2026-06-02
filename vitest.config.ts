import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Co-located tests: *.test.ts sit beside the source they cover.
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // Pure-function suite is fast; no setup files needed yet.
    // Integration tests (orchestrators vs a real test DB) come later with their
    // own setup and a separate include pattern.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/db/src/generated/**", // generated types, nothing to cover
        "packages/*/src/**/index.ts", // barrels
      ],
    },
  },
});
