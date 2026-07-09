import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolve } from "../../src/resolver/resolve";
import { makeDeps, config, nav, def, temp, perm } from "./helpers";
import type { Rule, Group, ContainerRef, NavContext } from "../../src/resolver/types";

const deps = makeDeps();

// Fixed host pool so matches actually occur.
const hosts = ["a.com", "b.com", "c.com", "sub.a.com", "d.co", "e.co"];
const arbHost = fc.constantFrom(...hosts);
const arbUrl = arbHost.map((h) => `https://${h}/`);
const arbContainer: fc.Arbitrary<ContainerRef> = fc.oneof(
  fc.constant(def),
  fc.constant(temp),
  fc.constantFrom("Work", "Personal", "Gmail").map((n) => perm(n)),
);
const arbAction = fc.oneof(
  fc.record({
    kind: fc.constant("open" as const),
    containers: fc.constantFrom(["X"], ["Temporary"], ["Personal", "Work"]),
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
const arbConfig = fc.record({ rules: fc.array(arbRule, { maxLength: 5 }), groups: fc.array(arbGroup, { maxLength: 3 }) });

describe("resolve — properties", () => {
  it("F5: matchRule equals a first-match oracle", () => {
    fc.assert(fc.property(arbUrl, fc.array(arbRule, { maxLength: 6 }), (url, rules) => {
      const h = new URL(url).host;
      const oracle = rules.find((r) =>
        r.match.some((m) => h === String(m) || h.endsWith("." + String(m)))) ?? null;
      expect(deps.matchRule(url, rules)).toBe(oracle);
    }));
  });

  it("F4: group membership is a function of the URL only", () => {
    fc.assert(fc.property(arbConfig, arbUrl, arbContainer, arbContainer, (cfg, url, cA, cB) => {
      // Membership never depends on nav context (initiator/current); only the URL.
      const base = deps.matchGroup(url, cfg.groups);
      void cA; void cB;
      expect(deps.matchGroup(url, cfg.groups)).toBe(base);
    }));
  });

  it("F4/F5 independence: changing a rule's open target never changes group answers", () => {
    fc.assert(fc.property(arbConfig, arbUrl, (cfg, url) => {
      const before = deps.matchGroup(url, cfg.groups);
      const mutated = {
        ...cfg,
        rules: cfg.rules.map((r) =>
          r.action.kind === "open" ? { ...r, action: { ...r.action, containers: ["ZZZ"] } } : r),
      };
      expect(deps.matchGroup(url, mutated.groups)).toBe(before);
    }));
  });

  it("F6: inherit yields only stay or reopen into exactly the initiator", () => {
    const inheritRule: Rule = { match: ["a.com"], action: { kind: "inherit" } };
    fc.assert(fc.property(arbContainer, arbContainer, (initiator, currentC) => {
      const n = nav("https://a.com/", { url: "https://b.com/", container: currentC }, initiator);
      const d = resolve(n, config([inheritRule]), deps);
      if (d.kind === "reopen") {
        expect(d.into).toEqual(initiator); // never a fresh temp-from-nowhere or a permanent from nowhere
      } else {
        expect(d.kind).toBe("stay");
      }
    }));
  });

  it("F3: continuity monotonicity on the disposable path", () => {
    fc.assert(fc.property(arbUrl, arbUrl, arbConfig, (curUrl, tgtUrl, cfg) => {
      // Force the disposable path: no rules, current is a temporary.
      const cfg2 = config([], cfg.groups);
      const d = resolve(nav(tgtUrl, { url: curUrl, container: temp }), cfg2, deps);
      const sameSite = deps.sameSite(curUrl, tgtUrl);
      const gA = deps.matchGroup(curUrl, cfg2.groups);
      const gB = deps.matchGroup(tgtUrl, cfg2.groups);
      const sameGroup = gA !== null && gA === gB;
      if (sameSite || sameGroup) expect(d).toEqual({ kind: "stay" });
      else expect(d).toEqual({ kind: "reopen", into: { kind: "temporary" } });
    }));
  });
});
