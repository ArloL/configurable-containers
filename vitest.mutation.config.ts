// The suite Stryker mutates against (`npm run test:mutation`, nightly).
//
// It is the PURE levels only — the resolver, the matcher, the same-site check the
// resolver's continuity rule leans on and, since the 2026-08-24 widening, the config
// parser and the overlays. That narrowing is the point of the gate, not a speed
// compromise: a mutant in `resolve()` that only an L3 engine case notices is a hole in
// the level that is supposed to own that logic (TESTING.md, "Almost all subtle logic
// lives in L1/L2"). Widening this include list would let the slow levels paper over
// exactly the gap the Mutation column is there to report.
import { defineConfig } from "vitest/config";
import { ccDefines } from "./vitest.shared.ts";

export default defineConfig({
  define: ccDefines,
  test: {
    include: ["test/{resolver,matcher,psl,config,overlays}/**/*.test.ts"],
    // Stryker decides each mutant from ONE run of this suite, so a property test that
    // draws a different sample per run would make a mutant's verdict a coin flip and
    // the score unrepeatable. The seed is pinned for the mutation run only — `npm test`
    // still varies its samples, which is where fast-check earns its keep.
    setupFiles: ["./test/fast-check-seed.ts"],
    // Named explicitly ONLY to stop vitest adding one of its own. With none configured it
    // appends `github-actions` whenever `GITHUB_ACTIONS=true`, and that reporter writes a
    // job summary on every `onTestRunEnd` with `flag: "a"`. Stryker starts ONE vitest and
    // ends a test run per mutant, so the nightly's summary got **1152 reports, 2302 of
    // them marked ❌** — and a failing run here is a mutant being KILLED, so a green
    // 100% job rendered as a wall of red nobody could read. Measured, not guessed.
    //
    // `reporters: []` does not work: the auto-add is `if (!resolved.reporters.length)`, so
    // an empty array takes the same branch. It has to name one, and "default" is what was
    // already running — this drops the GitHub reporter and changes nothing else.
    reporters: ["default"],
  },
});
