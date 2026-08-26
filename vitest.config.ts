import { defineConfig, configDefaults } from "vitest/config";
import { ccDefines } from "./vitest.shared.ts";

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
    sequence: {
      // Sequential, but not in a FIXED sequence. Every other gate here samples the suite
      // for time-dependence; nothing sampled it for order-dependence, and the two fail
      // differently: a case that depends on state an earlier file left behind fails the
      // same way every run, so `npm run test:flake` reports it as red rather than as a
      // race and the comparison never sees it. Shuffling is what turns that into a
      // disagreement it can catch.
      //
      // FILES ONLY. A file's cases share one browser session and several are written as a
      // sequence on purpose — choice.test.ts picks a container and then asserts the choice
      // was not remembered — so the file is the unit of isolation here, not the case.
      //
      // The seed is random and vitest prints it ("Running tests with seed N"); pass
      // `--sequence.seed=N` to replay an order exactly. Same trade as fast-check's
      // unseeded sampling, and for the same reason: an order nobody chose is the only one
      // that finds this. The MUTATION run does not inherit any of it — it is a separate
      // config, and Stryker deciding each mutant from one run needs that run repeatable.
      shuffle: { files: true, tests: false },
    },
  },
});
