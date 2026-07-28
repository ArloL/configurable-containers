import { createEngine } from "../engine/engine";
import { createAutoTemp } from "../engine/auto-temp";
import { createDisposer } from "../engine/disposer";
import { createCookieSeeder } from "../engine/cookie-seeder";
import { createScriptInjector } from "../engine/script-injector";
import { createRedirectorCloser } from "../engine/redirector-closer";
import { createPicker } from "../engine/picker";
import { createBrowserPort, realClock } from "../engine/browser-port";
import { parseConfig } from "../config/parse";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { SEED_CONFIG_YAML } from "./config";

// Injected at bundle time by esbuild (harness/build-extension.ts).
declare const __CC_GRACE_MS__: number;
declare const __CC_REDIRECTOR_DELAY_MS__: number;

const port = createBrowserPort();
const config = parseConfig(SEED_CONFIG_YAML);

// Shared temp-container suffix counter so engine reopen + auto-temp never collide.
let n = 0;
const tmpSuffix = () => String(++n);

// `picker` is referenced inside onChoice (which fires only at navigation time, after
// construction), so the forward-reference is safe. Hoisted with `let` to satisfy the
// linter and make the dependency direction explicit.
let picker: ReturnType<typeof createPicker>;
const engine = createEngine({
  port,
  config,
  deps: { matchRule, matchGroup, sameSite },
  tmpSuffix,
  onChoice: (options, nav) => {
    void picker.showChoice(nav.tabId, nav.url, options);
  },
});
picker = createPicker({ port, config, deps: { matchRule }, reopen: engine.reopen });

createAutoTemp({ port, tmpSuffix });

createDisposer({ port, clock: realClock, graceMs: __CC_GRACE_MS__ });

createCookieSeeder({ port, config, deps: { matchRule } });

void createScriptInjector({ port, config });

createRedirectorCloser({ port, clock: realClock, config, deps: { matchRule }, delayMs: __CC_REDIRECTOR_DELAY_MS__ });
