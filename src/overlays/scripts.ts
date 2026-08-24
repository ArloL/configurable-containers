// Pure overlay core: which scripts apply to a URL, and the registration shape the
// injector hands to browser.contentScripts.register. No browser, no I/O. Consumed by
// the script-injector (src/engine/script-injector.ts).
import type { Config, ScriptSpec } from "../resolver/types";
import { matcherToPatterns, type Matcher } from "../matcher/matcher";

// The register-arg shape, one entry per (rule, script) pair: `matches` is the union of the
// rule's matchers' patterns, `code` the inline JS, `runAt` document_start by default.
export interface ScriptRegistration {
  matches: string[];
  code: string;
  runAt: "document_start" | "document_end" | "document_idle";
}

// The scripts to inject for `url`: the first matching rule's overlay, or [] when nothing
// matches or the match is `ignore`. Through the SAME injected matchRule as the router, so
// overlay precedence cannot drift from routing. (For testability; the injector registers
// patterns, not per-URL.)
export function scriptsFor(
  url: string,
  config: Config,
  matchRule: (url: string, rules: Config["rules"]) => Config["rules"][number] | null,
): ScriptSpec[] {
  const rule = matchRule(url, config.rules);
  if (!rule || rule.action.kind === "ignore") return [];
  return rule.scripts ?? [];
}

// Flatten every rule's scripts into the register-arg shape, one per (rule, script) pair.
// Skips rules without scripts and `ignore` rules — the parser already rejects
// scripts-on-ignore, so that arm is only for a hand-built Config.
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
