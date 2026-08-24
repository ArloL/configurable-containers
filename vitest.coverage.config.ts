// The coverage gate (`npm run test:coverage`, every push in CI).
//
// It answers a different question from the mutation gate, and a weaker one: mutation
// asks whether the pure decision code has logic no test would notice changing, over
// three modules; this asks whether any of `src/` is reached by no deterministic test at
// all. Coverage is necessary, the mutation score is the real bar (TESTING.md,
// "Cross-cutting gates") — so the thresholds here are set to what the suite actually
// reaches, and exist to stop it slipping, not to be aspired to.
//
// It runs the deterministic levels ONLY (L1–L3). The e2e cases drive a packaged
// extension inside a real Firefox, where the code under test runs in another process
// and contributes no coverage here at all — including them would cost minutes of
// wall clock and change no number.
import { defineConfig, configDefaults } from "vitest/config";
import { ccDefines } from "./vitest.shared";

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
      reporter: ["text", "html"],
      reportsDirectory: "reports/coverage",
      thresholds: {
        // Floors, a point or two under what the suite measures today — not targets.
        // Raise them when the number rises; a drop is a file, or a branch of one, that
        // nothing deterministic reaches any more.
        statements: 93,
        branches: 91,
        functions: 84,
        lines: 93,
        // The pure modules the mutation gate also owns are held at 100 here, so a new
        // branch in them is caught by the fast gate too, on the push that adds it
        // rather than that night.
        "src/resolver/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/matcher/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/psl/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        // Added to the mutation gate's scope on 2026-08-24, so held to the same floor
        // here: a new branch in either is caught on the push that writes it rather than
        // that night.
        "src/config/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/overlays/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
