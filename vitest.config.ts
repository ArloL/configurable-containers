import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run test files sequentially: several e2e/build tests bundle the CC extension
    // to the same extensions/cc/background.js, so parallel files would race on it.
    fileParallelism: false,
  },
});
