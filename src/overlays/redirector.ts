// Pure: no browser, no I/O. Goes through the SAME injected matchRule as the router, so the
// auto-close cannot drift from routing precedence. See the redirector-auto-close spec §3.
import type { Config, Deps } from "../resolver/types";

export function isRedirectorUrl(
  url: string,
  config: Config,
  matchRule: Deps["matchRule"],
): boolean {
  const rule = matchRule(url, config.rules);
  return !!rule && rule.action.kind === "redirector";
}
