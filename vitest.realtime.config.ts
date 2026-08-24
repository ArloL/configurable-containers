import { defineConfig } from "vitest/config";
import { ccDefines } from "./vitest.shared.ts";

// The nightly real-delay run: only *.realtime.test.ts, the cases that wait out
// production timers instead of a wound-down one. Kept out of vitest.config.ts rather
// than gated by an env var so `npm test` neither runs them nor reports them as skipped.
export default defineConfig({
  define: ccDefines,
  test: {
    include: ["test/**/*.realtime.test.ts"],
    // Wall clock per test, so this must clear the longest grace a case waits out plus
    // the slack it allows past it (300s + 180s today), with room for Firefox startup.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // Same reason as vitest.config.ts: these bundle the extension to extensions/cc/.
    fileParallelism: false,
  },
});
