// Pins fast-check's sample for the mutation run (vitest.mutation.config.ts).
//
// Stryker runs the suite once per mutant and records the verdict; a property test that
// draws fresh samples each run would report a mutant killed on one night and survived
// on the next, from the same code. Pinning the seed makes the score a fact about the
// tests rather than about the draw. `npm test` does NOT load this file — unseeded
// exploration is the reason the property tests exist.
import fc from "fast-check";

fc.configureGlobal({ seed: 0x1c0ffee, numRuns: 200 });
