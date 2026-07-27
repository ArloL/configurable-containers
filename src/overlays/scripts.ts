// Pure overlay core: which scripts apply to a URL, and the registration shape the
// injector hands to browser.contentScripts.register. No browser, no I/O. Consumed by
// the script-injector (src/engine/script-injector.ts).
import type { Config, ScriptSpec } from "../resolver/types";
import { matcherToPatterns, type Matcher } from "../matcher/matcher";

// The register-arg shape: one entry per (rule, script) pair. `matches` is the union of
// the rule's matchers' patterns; `code` is the inline JS; `runAt` defaults to
// document_start (ScriptSpec.at is optional).
export interface ScriptRegistration {
  matches: string[];
  code: string;
  runAt: "document_start" | "document_end" | "document_idle";
}

// The scripts to inject for `url`: the first matching rule's overlay, or [] when no
// rule matches or the matched rule is `ignore`. Routed through the SAME injected
// matchRule as the router, so overlay precedence can never drift from routing. (Used for
// pure testability; the injector itself registers patterns, not per-URL.)
export function scriptsFor(
  url: string,
  config: Config,
  matchRule: (url: string, rules: Config["rules"]) => Config["rules"][number] | null,
): ScriptSpec[] {
  const rule = matchRule(url, config.rules);
  if (!rule || rule.action.kind === "ignore") return [];
  return rule.scripts ?? [];
}

// Flatten every rule's scripts into the register-arg shape. Skips rules without scripts
// and `ignore` rules (the parser already rejects scripts-on-ignore; this is defensive
// for a hand-built Config). One registration per (rule, script) pair.
export function scriptRegistrations(config: Config): ScriptRegistration[] {
  const out: ScriptRegistration[] = [];
  for (const rule of config.rules) {
    if (rule.action.kind === "ignore") continue;
    if (!rule.scripts) continue;
    const matches = rule.match.flatMap((m) => matcherToPatterns(m as Matcher));
    for (const s of rule.scripts) {
      out.push({ matches, code: s.run, runAt: s.at ?? "document_start" });
    }
  }
  return out;
}
