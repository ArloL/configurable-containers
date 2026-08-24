// Fitness function: the two hand-copied test seeds say the same thing.
//
// `__CC_CONFIG_YAML__` is an esbuild define, so it has to be supplied twice by two
// different mechanisms that never meet: `harness/build-extension.ts` bundles the real
// extension for the e2e levels, and `vitest.shared.ts` defines it for the unit levels,
// which never run through esbuild at all. CLAUDE.md records the duplicate and adds
// "that nothing asserts" — this is that assertion.
//
// Drift here does not break a build or throw. It splits the suite's idea of what the
// shipped config says: a rule added to one copy makes an L3 case pass against behaviour
// the e2e build has never seen, or an e2e case pass against a rule no unit test knows
// about. Either way both suites stay green while disagreeing about the subject.
import { describe, it, expect } from "vitest";
import { readRepoFile } from "./sources";
import { parseConfig } from "../../src/config/parse";

// Pulled out of each file as text rather than imported: `harness/build-extension.ts`
// keeps its copy in a module-private const (it is a build input, not an export), and
// exporting it purely to be compared here would change the subject into something this
// check keeps true by construction.
function seedIn(path: string): string {
  const m = /const TEST_CONFIG_YAML = `([\s\S]*?)`;/.exec(readRepoFile(path));
  if (!m) throw new Error(`no TEST_CONFIG_YAML literal in ${path} — it moved or was renamed`);
  return m[1]!;
}

const copies = {
  "harness/build-extension.ts": seedIn("harness/build-extension.ts"),
  "vitest.shared.ts": seedIn("vitest.shared.ts"),
};

describe("fitness — the duplicated test seed", () => {
  it("reads identically in the esbuild define and the vitest define", () => {
    expect(copies["vitest.shared.ts"]).toBe(copies["harness/build-extension.ts"]);
  });

  it("parses, so neither copy can quietly become the empty config", () => {
    // A seed that fails to parse is not a loud failure anywhere: `loadConfig` answers
    // with the EMPTY config plus an error (deliberately — stale rules are a silent wrong
    // answer, nothing-matches is a loud one), so a broken seed would show up as every
    // test site landing in a throwaway. Several cases expect exactly that already.
    // `parseConfig` throws on a config it cannot make sense of, which is what
    // `packageExtension` relies on to refuse a bad seed at build time.
    for (const [path, yaml] of Object.entries(copies)) {
      const config = parseConfig(yaml);
      expect(config.rules.length, `${path} parsed to no rules`).toBeGreaterThan(0);
    }
  });
});
