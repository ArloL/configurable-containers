// Pure overlay core: does this URL match a redirector rule? No browser, no I/O. Consumed by
// the redirector-closer, through the SAME injected matchRule as the router, so the auto-close
// cannot drift from routing precedence. See the redirector-auto-close design spec §3.
import type { Config, Deps } from "../resolver/types";

// True iff the first matching rule's action is `redirector`; false for no match and for
// every other action.
export function isRedirectorUrl(
  url: string,
  config: Config,
  matchRule: Deps["matchRule"],
): boolean {
  const rule = matchRule(url, config.rules);
  return !!rule && rule.action.kind === "redirector";
}
