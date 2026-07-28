import { defineConfig, configDefaults } from "vitest/config";
import { ccDefines } from "./vitest.shared";

export default defineConfig({
  define: ccDefines,
  test: {
    include: ["test/**/*.test.ts"],
    // The real-delay cases wait out production timers (five minutes for one throwaway),
    // so they are not part of `npm test` — `npm run test:realtime` runs them nightly via
    // vitest.realtime.config.ts. Excluded rather than skipped: a skip in this suite would
    // be a standing invitation to stop noticing it, and `npm test` skips nothing.
    exclude: [...configDefaults.exclude, "**/*.realtime.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run test files sequentially: several e2e/build tests bundle the CC extension
    // to the same extensions/cc/background.js, so parallel files would race on it.
    fileParallelism: false,
  },
});
