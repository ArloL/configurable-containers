// Pure: no browser, no I/O. Consumed by src/engine/script-injector.ts.
import type { Config, ScriptSpec } from "../resolver/types";
import { matcherToPatterns, type Matcher } from "../matcher/matcher";

// `matches` is the union of the rule's matchers' patterns; `runAt` defaults to
// document_start, which ScriptSpec leaves optional.
export interface ScriptRegistration {
  matches: string[];
  code: string;
  runAt: "document_start" | "document_end" | "document_idle";
}

// [] when nothing matches or the match is `ignore`. Goes through the SAME injected
// matchRule as the router, so overlay precedence cannot drift from routing. Exists for
// testability: the injector itself registers patterns, not per-URL.
export function scriptsFor(
  url: string,
  config: Config,
  matchRule: (url: string, rules: Config["rules"]) => Config["rules"][number] | null,
): ScriptSpec[] {
  const rule = matchRule(url, config.rules);
  if (!rule || rule.action.kind === "ignore") return [];
  return rule.scripts ?? [];
}

// One entry per (rule, script) pair. The `ignore` arm is only for a hand-built Config: the
// parser already rejects scripts-on-ignore.
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
