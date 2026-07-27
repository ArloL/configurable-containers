import { createEngine } from "../engine/engine";
import { createBrowserPort } from "../engine/browser-port";
import { parseConfig } from "../config/parse";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { BUNDLED_CONFIG_YAML } from "./config";

createEngine({
  port: createBrowserPort(),
  config: parseConfig(BUNDLED_CONFIG_YAML),
  deps: { matchRule, matchGroup, sameSite },
  onChoice: () => {}, // no picker UI in this slice; the bundled config has no choice rule
});
