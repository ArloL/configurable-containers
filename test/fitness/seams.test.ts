// Fitness function: the seams the test pyramid stands on.
//
// TESTING.md's first design claim is that the DECISION is pure and the EFFECTS sit behind a
// thin adapter. That is what puts F3–F6 and F11 at L1/L2, where tests are milliseconds and
// exhaustive, and what the mutation gate's 100% is a statement about — and the compiler
// enforces none of it. `import "…/engine/port"` into the resolver, or a `Date.now()` in the
// matcher, type-checks fine and every test stays green; what breaks is the MEANING of the
// levels above.
//
// So the seams are written down as assertions. Each is an allowlist compared EXACTLY, never
// a "no more than" bound: a file that needs an exception has to come here and say so in the
// same commit. Widening a list silently is the failure these exist to make loud.
import { describe, it, expect } from "vitest";
import { sourceFiles, filesMatching, pathsMatching } from "./sources";

// The pure levels: no browser, no clock, no I/O, no randomness. `resolve()` runs inside a
// blocking webRequest handler and inside a fast-check property with a pinned seed, and both
// depend on it answering from its arguments alone.
const pureDirs = ["src/resolver", "src/matcher", "src/psl"];

describe("fitness — the pure modules stay pure", () => {
  it("reaches no browser API, so the resolver's answer never depends on a live Firefox", () => {
    const offenders = filesMatching(sourceFiles(...pureDirs), /\bbrowser\./);
    expect(offenders).toEqual([]);
  });

  it("reads no clock and draws no randomness, so a property replays from its seed", () => {
    // The mutation gate decides each mutant from ONE run of the L1/L2 suite
    // (vitest.mutation.config.ts), so a single Math.random() or Date.now() in the mutated
    // modules makes a mutant's verdict a coin flip and the 100% unrepeatable — reported as a
    // flaky gate, never as this cause.
    const offenders = filesMatching(
      sourceFiles(...pureDirs),
      /\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bsetTimeout\b|\bsetInterval\b|\bperformance\.now\b/
    );
    expect(offenders).toEqual([]);
  });

  it("imports only its own siblings and the PSL library, never a layer above it", () => {
    // This forbids the edge that inverts the dependency direction: a pure module reaching
    // into `src/engine` or `src/extension`. `tldts` is the one runtime dependency (same-site
    // is a public-suffix question); the resolver's own types are the only other import.
    const imports = filesMatching(sourceFiles(...pureDirs), /^\s*import\s/)
      .flatMap((f) => f.lines.map((l) => `${f.path} — ${l.replace(/^\d+:\s*/, "")}`));

    expect(imports.filter((i) => /from\s+"\.\.\/(engine|extension|config|overlays)\//.test(i))).toEqual([]);
    expect(imports).toEqual([
      'src/matcher/matcher.ts — import type { Rule, Group } from "../resolver/types";',
      'src/psl/same-site.ts — import { parse } from "tldts";',
      'src/resolver/decision-label.ts — import type { Decision } from "./types";',
      'src/resolver/resolve.ts — import type { Action, Config, ContainerRef, Decision, Deps, NavContext } from "./types";',
      'src/resolver/resolve.ts — import { TEMPORARY } from "./types";',
    ]);
  });
});

describe("fitness — the layers point one way", () => {
  // The rule above, for the two layers that are not pure but are still BELOW the engine.
  //
  // `src/config` turns text into a `Config` and `src/overlays` turn a `Config` into
  // descriptions of effects; neither performs any. Both were outside the inventory above,
  // and `config/parse.ts` had quietly grown `import { isThrowawayName } from
  // "../engine/registry"` — sound sharing (restating the `tmp<N>` shape in the parser is the
  // drift that gets a user's `tmpwork` deleted by the disposer) pointed the wrong way. The
  // cost was measurable: `engine/registry.ts` was in the OPTIONS PAGE bundle, reached
  // through the parser, for one seven-line predicate. The shape now lives in
  // `resolver/types.ts` and both halves import down.
  it("keeps src/config and src/overlays out of src/engine and src/extension", () => {
    const imports = filesMatching(sourceFiles("src/config", "src/overlays"), /^\s*import\s/)
      .flatMap((f) => f.lines.map((l) => `${f.path} — ${l.replace(/^\d+:\s*/, "")}`));

    expect(imports.filter((i) => /from\s+"\.\.\/(engine|extension)\//.test(i))).toEqual([]);
  });

  // And the direction the pause feature crossed. `engine/pause.ts` imported four types from
  // `extension/pause-protocol.ts`, which imported `Recording` back — `src/`'s only import
  // cycle, type-only so no runtime cycle, but a knowledge cycle across the layer boundary
  // this file polices everywhere else.
  //
  // TWO modules are allowed, and what they have in common is the point: a protocol module is
  // by construction the shared vocabulary of one boundary, imports nothing itself, and is
  // named by both sides. The engine may name one. What it may not do is reach for a page's
  // code, or for a type the page owns the rendering of — `RecordingView` lives over there
  // now, and `pause.ts` maps its own model into it rather than shipping the model.
  //
  // The inventory is of MODULES rather than import lines, because an import that got long
  // enough to wrap would otherwise arrive here as a second entry saying `} from …`, and the
  // question this asks is which modules, not how they are spelled.
  it("lets the engine name a protocol module and nothing else in src/extension", () => {
    const named = filesMatching(sourceFiles("src/engine"), /from\s+"\.\.\/extension\//)
      .flatMap((f) => f.lines.map((l) => `${f.path} -> ${/"\.\.\/extension\/([\w-]+)"/.exec(l)?.[1] ?? l}`));

    expect([...new Set(named)].sort()).toEqual([
      "src/engine/pause.ts -> pause-protocol",
      "src/engine/picker.ts -> picker-protocol",
    ]);
  });
});

describe("fitness — the browser seam", () => {
  it("is touched by exactly the five files that are allowed to touch it", () => {
    // `BrowserPort` is the seam for the engine and its siblings: everything under
    // `src/engine` but the port implementation goes through it, which is what lets L3 drive
    // the engine against `test/engine/mock-port.ts`. A stray `browser.tabs.get` in
    // `src/engine` is no compile error and at L3 throws `browser is not defined` from a
    // floated promise, where the engine swallows it into a console.warn and routing quietly
    // stops.
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

describe("fitness — a config is applied, never restarted into", () => {
  it("calls runtime.reload() nowhere in src/", () => {
    // A save and a sync adoption both apply the config in place (2026-08-25 spec). A reload
    // reintroduced here would take back the one step of an apply that nothing can observe:
    // on a temporarily installed extension on 140.14.0esr it does not bring the background
    // back at all, so the old config goes on routing while the editor reports success. That
    // is measured (FOLLOWUPS.md's deleted ESR entry), and it is invisible to every level of
    // the pyramid except a real browser on that channel.
    //
    // Named in comments all over this codebase, which is why the check reads stripped code.
    expect(filesMatching(sourceFiles("src"), /\bruntime\.reload\b/)).toEqual([]);
  });
});
