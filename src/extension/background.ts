import { createEngine } from "../engine/engine";
import { createDisposer } from "../engine/disposer";
import { createCookieSeeder } from "../engine/cookie-seeder";
import { createBrowserPort, realClock } from "../engine/browser-port";
import { parseConfig } from "../config/parse";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { BUNDLED_CONFIG_YAML } from "./config";

// Injected at bundle time by esbuild (harness/build-extension.ts).
declare const __CC_GRACE_MS__: number;

const port = createBrowserPort();
const config = parseConfig(BUNDLED_CONFIG_YAML);

createEngine({
  port,
  config,
  deps: { matchRule, matchGroup, sameSite },
  onChoice: () => {}, // no picker UI in this slice; the bundled config has no choice rule
});

createDisposer({ port, clock: realClock, graceMs: __CC_GRACE_MS__ });

createCookieSeeder({ port, config, deps: { matchRule } });
