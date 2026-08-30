// Fitness function: who holds the ONE `Config` object that mutates under them.
//
// `wireBackground` creates a single `Config` and fills it IN PLACE (`Object.assign` inside
// `useConfig`), because the wiring registers every `browser.*` listener synchronously and
// the config arrives later. Every sibling handed that object depends on an invariant no
// type states — *this object mutates under you; read it at event time, never at
// construction* — and the idiomatic way to write a factory that takes a config is to
// destructure what it needs out of it, which freezes on the empty config forever. Nothing
// else here can see that: not the compiler, not the coverage gate, and not an L3 case,
// since the composed-background tests apply a config before they navigate.
//
// So the holders are written down. The value is not the list, it is the FAILURE: the next
// sibling handed a live `config` cannot be added without someone coming here, reading why
// the object mutates, and adding a row — which is exactly the moment FOLLOWUPS.md says the
// `getConfig()` accessor becomes worth taking. Left to prose, that moment has no way of
// announcing itself.
//
// It exists because the prose already drifted. FOLLOWUPS.md and the 2026-08-29 modularity
// review both said "six siblings" and put the trigger at "the seventh": a count taken from
// `grep -rn "config: Config" src/`, which answers with six FILES, two of which hold
// nothing. Four is the number, and an ordinal nobody can count to is not a trigger. That is
// the whole argument for pinning it — the miscount survived a modularity review and a month
// of the file being read.
//
// House rules as everywhere in this directory: an exact list, never a bound; identity by
// file, never by line; comments stripped before matching, since this repo's comments name
// the very shapes its checks look for (this file's own header is three such lines).
import { describe, it, expect } from "vitest";
import { sourceFiles, filesMatching } from "./sources";

// A HELD reference: an options field the factory keeps and reads at event time. Spelled as
// a bare `config: Config;` line, which is the interface-field form — a signature parameter
// is `config: Config,` on the same line as its neighbours and is not this.
const HELD = /^config: Config;$/;

// The four siblings, each of which destructures `config` out of its options and reads it
// inside a listener. Adding one is a decision, so it is a line in a diff.
const HOLDERS = [
  "src/engine/cookie-seeder.ts",
  "src/engine/engine.ts",
  "src/engine/picker.ts",
  "src/engine/redirector-closer.ts",
];

// Same spelling, not a held reference. The pattern reads a field declaration, and a field
// is also how a RESULT carries its config back to a caller — so the two config-layer result
// types match and are exempt by construction rather than by promise: nothing constructs
// them and keeps them. `script-injector` is the other name the naive count reaches, and it
// is exempt by SHAPE rather than by listing — it never matches HELD at all, which is the
// case below.
const NOT_A_HOLDER: Record<string, string> = {
  "src/config/load.ts": "LoadResult — a value returned to one caller, not a reference kept",
  "src/config/parse.ts": "ParseResult — the same, one parse",
  "src/extension/wiring.ts": "Background.config, the object itself — the owner holds no reference to itself",
};

describe("fitness — the live Config object", () => {
  it("is held by exactly four siblings, and a fifth has to say so here", () => {
    const declared = filesMatching(sourceFiles("src"), HELD).map((f) => f.path);

    expect(declared).toEqual([...HOLDERS, ...Object.keys(NOT_A_HOLDER)].sort());
  });

  // The exception that shows the shape the accessor would generalise, and the reason the
  // count was six. `script-injector` reads the config EAGERLY — it turns rules into content
  // script registrations — so it takes it as an argument rather than holding it, which is
  // already the contract form: an argument cannot go stale because there is nothing to hold.
  // Pinned so it cannot quietly become a field, which would make it a fifth holder wearing
  // the shape of the exemption.
  it("reaches script-injector as an argument, never as a field", () => {
    const injector = sourceFiles("src").find((f) => f.path === "src/engine/script-injector.ts");

    expect(injector?.code).toContain("apply(config: Config): Promise<void>;");
    expect(injector?.code).not.toMatch(HELD);
  });

  // The other half of the invariant, and the half a holder cannot defend itself against.
  // Replacing the object instead of filling it — `config = loaded`, or handing siblings a
  // freshly parsed one — leaves all four reading the empty config they were constructed
  // with, and every routing test still passes because they apply a config before they
  // navigate. `Required<Config>` is what makes a key added to `Config` later fail to compile
  // here rather than silently keep what the previous config left behind.
  it("is filled in place, never replaced", () => {
    const wiring = sourceFiles("src").find((f) => f.path === "src/extension/wiring.ts");

    expect(wiring?.code).toContain("Object.assign(config, total)");
    expect(wiring?.code).toContain("const total: Required<Config> =");
  });
});
