// The suite Stryker mutates against (`npm run test:mutation`, nightly).
//
// It is L1 + L2 ONLY — the pure levels: resolver, matcher and the same-site check the
// resolver's continuity rule leans on. That narrowing is the point of the gate, not a
// speed compromise: a mutant in `resolve()` that only an L3 engine case notices is a
// hole in the level that is supposed to own that logic (TESTING.md, "Almost all subtle
// logic lives in L1/L2"). Widening this include list would let the slow levels paper
// over exactly the gap the Mutation column is there to report.
import { defineConfig } from "vitest/config";
import { ccDefines } from "./vitest.shared";

export default defineConfig({
  define: ccDefines,
  test: {
    include: ["test/{resolver,matcher,psl}/**/*.test.ts"],
    // Stryker decides each mutant from ONE run of this suite, so a property test that
    // draws a different sample per run would make a mutant's verdict a coin flip and
    // the score unrepeatable. The seed is pinned for the mutation run only — `npm test`
    // still varies its samples, which is where fast-check earns its keep.
    setupFiles: ["./test/fast-check-seed.ts"],
  },
});
