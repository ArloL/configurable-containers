// Fitness function: the seams the test pyramid stands on.
//
// TESTING.md's first design claim is that the DECISION is a pure function and the
// EFFECTS sit behind a thin adapter — that is what puts F3–F6 and F11 at L1/L2, where
// tests are milliseconds and exhaustive, and it is what the mutation gate's 100% is a
// statement about. None of it is enforced by the compiler. `import "…/engine/port"` into
// the resolver, or a `Date.now()` in the matcher, type-checks perfectly and every
// existing test stays green; what breaks is the *meaning* of the levels above.
//
// So these are the seams written down as assertions. Each one is an allowlist compared
// EXACTLY, not a "no more than" bound: a new file that needs an exception has to come
// here and say so in the same commit, which is the whole mechanism. Widening a list
// silently is the failure mode these are here to make loud.
import { describe, it, expect } from "vitest";
import { sourceFiles, filesMatching, pathsMatching } from "./sources";

// The pure levels: no browser, no clock, no I/O, no randomness. `resolve()` is called
// inside a blocking webRequest handler and again inside a fast-check property with a
// pinned seed; both of those depend on it answering from its arguments alone.
const pureDirs = ["src/resolver", "src/matcher", "src/psl"];

describe("fitness — the pure modules stay pure", () => {
  it("reaches no browser API, so the resolver's answer never depends on a live Firefox", () => {
    const offenders = filesMatching(sourceFiles(...pureDirs), /\bbrowser\./);
    expect(offenders).toEqual([]);
  });

  it("reads no clock and draws no randomness, so a property replays from its seed", () => {
    // Determinism is not a nicety here: the mutation gate decides each mutant from ONE
    // run of the L1/L2 suite (vitest.mutation.config.ts), so a single Math.random() or
    // Date.now() inside the mutated modules would make a mutant's verdict a coin flip
    // and the 100% score unrepeatable — reported as a flaky gate, never as this cause.
    const offenders = filesMatching(
      sourceFiles(...pureDirs),
      /\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bsetTimeout\b|\bsetInterval\b|\bperformance\.now\b/
    );
    expect(offenders).toEqual([]);
  });

  it("imports only its own siblings and the PSL library, never a layer above it", () => {
    // What this forbids is the edge that would invert the dependency direction: a pure
    // module reaching into `src/engine` or `src/extension`. `tldts` is the one runtime
    // dependency (same-site is a public-suffix question and cannot be answered without
    // the list); the resolver's own types are the only other import in the set.
    const imports = filesMatching(sourceFiles(...pureDirs), /^\s*import\s/)
      .flatMap((f) => f.lines.map((l) => `${f.path} — ${l.replace(/^\d+:\s*/, "")}`));

    expect(imports.filter((i) => /from\s+"\.\.\/(engine|extension|config|overlays)\//.test(i))).toEqual([]);
    expect(imports).toEqual([
      'src/matcher/matcher.ts — import type { Rule, Group } from "../resolver/types";',
      'src/psl/same-site.ts — import { parse } from "tldts";',
      'src/resolver/resolve.ts — import type { Config, ContainerRef, Decision, Deps, NavContext } from "./types";',
      'src/resolver/resolve.ts — import { TEMPORARY } from "./types";',
    ]);
  });
});

describe("fitness — the browser seam", () => {
  it("is touched by exactly the five files that are allowed to touch it", () => {
    // `BrowserPort` is the seam for the engine and its siblings: everything under
    // `src/engine` except the port implementation itself goes through it, which is what
    // lets L3 drive the whole engine against `test/engine/mock-port.ts`. A stray
    // `browser.tabs.get` inside `src/engine` would not be a compile error and, at L3,
    // would throw `browser is not defined` — from a floated promise, where the engine
    // swallows it into a console.warn and the navigation just quietly stops routing.
    //
    // The four extension files are the documented exception (CLAUDE.md, "Where new logic
    // goes"): they are the extension's own plumbing — storage, the options page, the
    // choice page — and were never behind the port. They have no L3 level to lie to.
    expect(pathsMatching(sourceFiles("src"), /\bbrowser\./)).toEqual([
      "src/engine/browser-port.ts",
      "src/extension/choice.ts",
      "src/extension/config-sync.ts",
      "src/extension/config.ts",
      "src/extension/options.ts",
    ]);
  });

  it("keeps the overlays and the config parser free of it, so both stay testable as data", () => {
    // The overlays turn config into descriptions of effects (a cookie to set, a script to
    // register) and hand them to whoever performs them; `config/parse` turns text into a
    // Config. Both are pure by design and tested that way — this pins the property that
    // makes those tests worth their names.
    expect(filesMatching(sourceFiles("src/overlays", "src/config"), /\bbrowser\./)).toEqual([]);
  });
});
