// The coverage gate (`npm run test:coverage`, every push in CI).
//
// It answers a different question from the mutation gate, and a weaker one: mutation
// asks whether the pure decision code has logic no test would notice changing, over the
// five modules named below; this asks whether any of `src/` is reached by no deterministic
// test at all. Coverage is necessary, the mutation score is the real bar (TESTING.md,
// "Cross-cutting gates") — so the thresholds here are set to what the suite actually
// reaches, and exist to stop it slipping, not to be aspired to.
//
// It runs the deterministic levels ONLY (L1–L3). The e2e cases drive a packaged
// extension inside a real Firefox, where the code under test runs in another process
// and contributes no coverage here at all — including them would cost minutes of
// wall clock and change no number.
import { defineConfig, configDefaults } from "vitest/config";
import { ccDefines } from "./vitest.shared.ts";

export default defineConfig({
  define: ccDefines,
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "**/*.realtime.test.ts",
      "test/e2e/**",
      // Launches a real Firefox to prove the reaper kills it; L4 by nature, and its
      // subject is `harness/`, which is not measured here.
      "test/harness/reaper-firefox.test.ts",
    ],
    testTimeout: 30_000,
    fileParallelism: false,
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      // Three files no deterministic level can reach, each for a reason that is a fact
      // about the platform rather than a gap to close:
      //
      //   - `background.ts` is the MV2 entry point. Its listeners must register
      //     synchronously as the file evaluates, so it is a call to `wireBackground`
      //     plus an async tail — and the L3 restart harness drives that same function
      //     directly, which is the whole reason it is a function.
      //   - `choice.ts` and `options.ts` are DOM. There is no jsdom in this repo, so
      //     they have no level below L4; the parts of them that could be decided
      //     without a document already were (`picker-protocol.ts`, at 100%).
      //
      // Excluded rather than left in at 0%, because a threshold set low enough to
      // accommodate them would stop reporting anything about the rest.
      exclude: [
        "src/extension/background.ts",
        "src/extension/choice.ts",
        "src/extension/options.ts",
      ],
      // lcov is what SonarCloud imports (sonar.javascript.lcov.reportPaths). Without it the
      // scan still succeeds and reports 0% coverage, which is worse than no gate at all.
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "reports/coverage",
      thresholds: {
        // 100 everywhere, and a floor rather than a target: every line and branch of
        // `src/` outside the three files above is reached by an L1-L3 case. What that
        // buys is a failure that NAMES the new code nothing reaches, on the push that
        // writes it — a threshold set below the measurement absorbs the first few in
        // silence and only fails once someone has written several.
        //
        // Reaching it needed two things a lower bar hides. Code no deterministic level
        // can reach is marked at the line (`/* v8 ignore … -- why */`, as `matcher.ts`
        // and `load.ts` already did), so the exception is readable beside the code
        // instead of being averaged away. And a defence that turned out to be dead was
        // deleted rather than tested — `hostsByStore.get(csid) ?? []` over a key from
        // that same map, and `createEngine`'s own tmp-suffix counter, which the one
        // production caller has always overridden because auto-temp shares its own.
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
