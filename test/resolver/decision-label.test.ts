// A decision said in words, at L1.
//
// These two functions used to live in `engine.ts` and were exercised only through L3 engine
// cases — which is to say the mutation gate, whose scope is `src/resolver` and whose killers
// are these five suites, never saw them. Moving them down to the resolver is what removes
// the `pause -> engine` edge; owning them here is what stops that move from being a hole in
// the gate.
//
// What they decide is user-facing and small, and both halves are load-bearing. `targetLabel`
// is the ONE wording shared by the F9 toast and the pause record, so drift between them is
// a user reading two different accounts of the same declined navigation.
// `namesAConfiguredContainer` decides whether a decline interrupts the user at all.
import { describe, it, expect } from "vitest";
import { namesAConfiguredContainer, targetLabel } from "../../src/resolver/decision-label";
import type { Declinable } from "../../src/resolver/decision-label";
import type { Target } from "../../src/resolver/types";

const choice = (...options: string[]): Declinable => ({ kind: "choice", options });
const reopenInto = (into: Target): Declinable => ({ kind: "reopen", into });

describe("targetLabel", () => {
  it("names a permanent container by the name the config gave it", () => {
    // The case the F9 toast exists for: "stayed in tmp9 instead of Haeger" points at the
    // rule to fix, because "Haeger" is a word the user wrote in their own config.
    expect(targetLabel(reopenInto({ kind: "permanent", name: "Haeger" }))).toBe("Haeger");
  });

  it("says a throwaway is a new one, since it has no name worth printing", () => {
    expect(targetLabel(reopenInto({ kind: "temporary" }))).toBe("a new temporary container");
  });

  it("says the default container rather than naming Firefox's store id", () => {
    expect(targetLabel(reopenInto({ kind: "default" }))).toBe("the default container");
  });

  // Two options, not one: the separator is what makes a list readable, and a single-element
  // list would report the same string whatever it joined with.
  it("lists a choice's options, so the user can see what they were choosing between", () => {
    expect(targetLabel(choice("Personal", "Work"))).toBe("one of: Personal, Work");
  });
});

describe("namesAConfiguredContainer", () => {
  // A toast earns its interruption by naming something the user wrote and can act on.
  it("announces a permanent container, which is a name from the config", () => {
    expect(namesAConfiguredContainer(reopenInto({ kind: "permanent", name: "Haeger" }))).toBe(true);
  });

  it("announces a choice, whose options are all config names", () => {
    expect(namesAConfiguredContainer(choice("Personal", "Work"))).toBe(true);
  });

  // "Stayed in tmp9 instead of a new temporary container" names two throwaways the user can
  // neither tell apart nor act on — and it is the COMMON case, a card payment at an unmatched
  // site where the 3-D Secure host posts back cross-site and staying put is what makes
  // checkout work.
  it("stays quiet about a throwaway, which names nothing the user can act on", () => {
    expect(namesAConfiguredContainer(reopenInto({ kind: "temporary" }))).toBe(false);
  });

  // Firefox's no-container, not a rule's target.
  it("stays quiet about the default container for the same reason", () => {
    expect(namesAConfiguredContainer(reopenInto({ kind: "default" }))).toBe(false);
  });
});
