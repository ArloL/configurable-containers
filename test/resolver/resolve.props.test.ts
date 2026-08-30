import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolve } from "../../src/resolver/resolve";
import { realMatchers, aConfigOf, aNavigation, host, theDefaultContainer, aThrowaway, theContainerNamed } from "./helpers";
import type { Rule, Group, ContainerRef } from "../../src/resolver/types";

const deps = realMatchers();

// Fixed host pool so matches actually occur.
const hosts = ["a.com", "b.com", "c.com", "sub.a.com", "d.co", "e.co"];
const arbHost = fc.constantFrom(...hosts);
const arbUrl = arbHost.map((h) => `https://${h}/`);
const arbContainer: fc.Arbitrary<ContainerRef> = fc.oneof(
  fc.constant(theDefaultContainer),
  fc.constant(aThrowaway),
  fc.constantFrom("Work", "Personal", "Gmail").map((n) => theContainerNamed(n)),
);
const arbAction = fc.oneof(
  fc.record({
    kind: fc.constant("open" as const),
    // Explicit type argument: fast-check 4 infers `const` type parameters, so a bare
    // call yields readonly tuples that don't fit Action's mutable, non-empty `containers`.
    containers: fc.constantFrom<[string, ...string[]]>(["X"], ["Temporary"], ["Personal", "Work"]),
  }),
  fc.constant({ kind: "inherit" as const }),
  fc.constant({ kind: "ignore" as const }),
  fc.constant({ kind: "redirector" as const }),
);
const arbRule: fc.Arbitrary<Rule> = fc.record({
  match: fc.array(arbHost, { minLength: 1, maxLength: 2 }),
  action: arbAction,
});
const arbGroup: fc.Arbitrary<Group> = fc.record({ match: fc.array(arbHost, { minLength: 1, maxLength: 3 }) });
const arbGroups = fc.array(arbGroup, { maxLength: 3 });
const arbConfig = fc.record({ rules: fc.array(arbRule, { maxLength: 5 }), groups: fc.array(arbGroup, { maxLength: 3 }) });

// What these properties are ABOUT, since the answer is not obvious and getting it wrong is
// how three of them came to assert nothing (drift review D6, 2026-08-30).
//
// The subject is `resolve`, and `deps` is the pair of test doubles from `./helpers` — NOT
// the production matcher, which is L2's subject and `test/matcher/` owns. So nothing here
// may take a matcher's answer as its own oracle: a property whose reference is
// `deps.matchRule` re-spelled is a function compared with a copy of itself, which is
// exactly what the F5 property here used to be. Every reference below is either a
// SECOND CALL TO `resolve` on a config that differs in a stated way, or a decision written
// out by hand.
//
// The one matcher fact these lean on is that a rule whose match list is a URL's own host
// matches that URL. It is the weakest thing a matcher can do, and both the double and the
// production matcher have it pinned by example (`helpers.test.ts`,
// `matcher/matcher.rules.test.ts`). Everything else about which rule matches is generated
// and left to the double.
//
// Every one was revert-verified, since "this assertion looks stricter" is precisely the
// judgement that let the old three through. Each dies to the mutation beside it:
//
//   head decides      matchRule taking the LAST match rather than the first        (alone)
//   shadows nothing   resolve reading `config.rules[0]`, not the matched rule      (alone)
//   first group       matchGroup taking the LAST match                            (alone)
//                     …and groups dropped from `sameSite || sameGroup`   (with F3 below)
//   only the target   `sameGroup` read as "the target is in some group"   (with F3 below)
//   independence      a single-container `open:` taking the disposable path        (alone)
//
// "(alone)" means no other case in this file goes red for it — including F3's oracle,
// which computes its own expectation through the same `deps` and so cannot see a matcher
// answering differently.
describe("resolve — properties", () => {
  // A rule that matches `url` by construction, so "first" can be argued from POSITION
  // rather than from a re-implementation of the matcher.
  const aRuleMatching = (url: string, action: Rule["action"]): Rule => ({ match: [host(url)], action });

  // A hop between two throwaways, which is where continuity is decided: `current` is a
  // page in a temporary container, so the disposable path is reachable and every rule kind
  // is still exercised above it.
  const aHop = (fromUrl: string, toUrl: string) =>
    aNavigation(toUrl, { url: fromUrl, container: aThrowaway });

  // F5 is "scan in order, take first", which is two claims: what a matching rule at the
  // head does to everything under it, and what a rule that does NOT match does — nothing.
  // Together they are what a precedence bug breaks, and each dies to the opposite mistake.
  it("F5: a rule matching at the head decides, whatever rules follow it", () => {
    fc.assert(
      fc.property(arbUrl, arbUrl, arbAction, fc.array(arbRule, { maxLength: 5 }), arbGroups, (from, to, action, tail, groups) => {
        const head = aRuleMatching(to, action);
        // The tail is generated over the same host pool, so it contains rules that match
        // `to` and answer differently. Taking the LAST match instead of the first is what
        // this equality stops being true under.
        expect(resolve(aHop(from, to), { rules: [head, ...tail], groups }, deps)).toEqual(
          resolve(aHop(from, to), { rules: [head], groups }, deps),
        );
      }),
    );
  });

  it("F5: a rule that does not match shadows nothing below it", () => {
    fc.assert(
      fc.property(arbUrl, arbUrl, arbAction, fc.array(arbRule, { maxLength: 5 }), arbGroups, (from, to, action, rules, groups) => {
        // A host outside the pool, so it matches none of the generated URLs — no oracle
        // needed to know that. The other half of first-match: reading `rules[0]` rather
        // than the rule that matched passes the case above and fails this one.
        const irrelevant: Rule = { match: ["zzz.example"], action };
        expect(resolve(aHop(from, to), { rules: [irrelevant, ...rules], groups }, deps)).toEqual(
          resolve(aHop(from, to), { rules, groups }, deps),
        );
      }),
    );
  });

  // F4 is group TOTALITY: a URL is in at most one group, so a group that names both ends of
  // a hop keeps it whatever the rest of the list says — and a group naming only one end is
  // not a group they share. The second half is the one the age-gate chain turns on: reading
  // "the target is in some group" as "these two are in the same group" keeps a login hop in
  // the container it came from, which is F4's reported failure exactly.
  it("F4: the first group naming both ends of a hop keeps it, whatever groups follow", () => {
    fc.assert(
      fc.property(arbUrl, arbUrl, arbGroups, (from, to, tail) => {
        const shared: Group = { match: [host(from), host(to)] };
        expect(resolve(aHop(from, to), { rules: [], groups: [shared, ...tail] }, deps)).toEqual({ kind: "stay" });
      }),
    );
  });

  it("F4: a group naming only the target is not a group the two share", () => {
    fc.assert(
      fc.property(arbUrl, arbUrl, (from, to) => {
        // A precondition, not an oracle: same-site hops stay for a reason that has nothing
        // to do with groups, and would satisfy this vacuously.
        fc.pre(!deps.sameSite(from, to));
        const onlyTheTarget: Group = { match: [host(to)] };
        expect(resolve(aHop(from, to), { rules: [], groups: [onlyTheTarget] }, deps)).toEqual({
          kind: "reopen",
          into: { kind: "temporary" },
        });
      }),
    );
  });

  // Independence, in the direction that has content: routing outranks continuity, so a rule
  // naming a container answers the same whatever the groups say. (The other direction —
  // changing a rule's `open:` target cannot change a group answer — is a fact about
  // `matchGroup`'s signature, which is not handed the rules at all, and there is nothing
  // for a property to vary.) `Temporary` is excluded because `open: Temporary` IS the
  // disposable path, where consulting the groups is the whole point.
  it("F4/F5 independence: a rule naming a container outranks whatever the groups say", () => {
    fc.assert(
      fc.property(
        arbUrl,
        arbUrl,
        fc.constantFrom<[string, ...string[]]>(["X"], ["Personal", "Work"]),
        arbGroups,
        (from, to, containers, groups) => {
          const rule = aRuleMatching(to, { kind: "open", containers });
          expect(resolve(aHop(from, to), { rules: [rule], groups }, deps)).toEqual(
            resolve(aHop(from, to), { rules: [rule], groups: [] }, deps),
          );
        },
      ),
    );
  });

  // "…and for a fixed initiator its result is invariant under the rest of the config"
  // (TESTING.md L1) is the half the tail and the groups carry: the rule is at the head, so
  // first-match keeps it in charge, and nothing under it may reach the answer.
  it("F6: inherit yields only stay or reopen into exactly the initiator", () => {
    const inheritRule: Rule = { match: ["a.com"], action: { kind: "inherit" } };
    fc.assert(fc.property(arbContainer, arbContainer, fc.array(arbRule, { maxLength: 4 }), arbGroups, (initiator, currentC, tail, groups) => {
      const n = aNavigation("https://a.com/", { url: "https://b.com/", container: currentC }, initiator);
      const d = resolve(n, { rules: [inheritRule, ...tail], groups }, deps);
      if (d.kind === "reopen") {
        expect(d.into).toEqual(initiator); // never a fresh temporary-from-nowhere or a permanent from nowhere
      } else {
        expect(d.kind).toBe("stay");
      }
    }));
  });

  it("F3: continuity monotonicity on the disposable path", () => {
    fc.assert(fc.property(arbUrl, arbUrl, arbConfig, (curUrl, tgtUrl, cfg) => {
      // Force the disposable path: no rules, current is a temporary.
      const cfg2 = aConfigOf([], cfg.groups);
      const d = resolve(aNavigation(tgtUrl, { url: curUrl, container: aThrowaway }), cfg2, deps);
      const sameSite = deps.sameSite(curUrl, tgtUrl);
      const gA = deps.matchGroup(curUrl, cfg2.groups);
      const gB = deps.matchGroup(tgtUrl, cfg2.groups);
      const sameGroup = gA !== null && gA === gB;
      if (sameSite || sameGroup) expect(d).toEqual({ kind: "stay" });
      else expect(d).toEqual({ kind: "reopen", into: { kind: "temporary" } });
    }));
  });
});
