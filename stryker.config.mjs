// Mutation testing for the pure levels (`npm run test:mutation`, nightly).
//
// The gate answers the one question coverage cannot: is there logic here that no test
// would notice being changed? Scope is deliberately narrow at both ends — only the pure
// modules are mutated, and only L1/L2 get to kill the mutants (vitest.mutation.config.ts
// explains why). See TESTING.md, "Cross-cutting gates" and the coverage matrix.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  // `related: false` — the runner's default asks Vitest which test files import the
  // mutated one, and Vitest 4 answers "none" for every file here, so the dry run finds no
  // tests and Stryker exits before mutating anything. The suite this points at is eight
  // files and under a second; running all of them is not a cost worth a module graph.
  vitest: { configFile: "vitest.mutation.config.ts", related: false },

  // The decision, and the two matchers it is built from. The stateful modules
  // (`src/engine`, `src/extension`) are out of scope: their tests are the L3 mock-browser
  // suite, which is slower by an order of magnitude and whose failures under mutation are
  // usually "the mock does not model that", not "the logic is untested".
  mutate: ["src/resolver/**/*.ts", "src/matcher/**/*.ts", "src/psl/**/*.ts"],

  // Run only the tests that covered the mutated line. Safe here because the suite has no
  // shared mutable state — every case builds its own config object.
  coverageAnalysis: "perTest",

  // 100 is the bar because the scope is 100-able: three pure modules, no I/O, no clock.
  // A survivor is not a metric wobble, it is a named behaviour nothing asserts — so the
  // nightly run fails and the matrix's Mutation column stops being true until it is
  // either killed by a new test or `// Stryker disable` d with a reason.
  thresholds: { high: 100, low: 100, break: 100 },

  // Points Stryker's tsconfig rewriter at a file that does not exist, which is how it is
  // turned off. It rewrites `extends`/`references` paths that would escape the sandbox,
  // through `ts.parseConfigFileTextToJson` — an API **TypeScript 7 no longer exports**, so
  // with it on, `stryker run` dies before the first mutant with a bare
  // `ts.parseConfigFileTextToJson is not a function`. Nothing is lost: the sandbox is a
  // copy of the whole project, our tsconfig has no `extends` and no project references,
  // and the runner never typechecks. Revisit if a tsconfig here ever points outside the
  // repo.
  tsconfigFile: "none",

  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  tempDirName: "node_modules/.stryker-tmp",
};
