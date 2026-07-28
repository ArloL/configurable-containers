import { createEngine } from "../engine/engine";
import { createAutoTemp } from "../engine/auto-temp";
import { createDisposer } from "../engine/disposer";
import { createCookieSeeder } from "../engine/cookie-seeder";
import { createScriptInjector } from "../engine/script-injector";
import { createRedirectorCloser } from "../engine/redirector-closer";
import { createPicker } from "../engine/picker";
import { createBrowserPort, realClock } from "../engine/browser-port";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { loadConfig } from "../config/load";
import { highestTmpSuffix } from "../engine/registry";
import type { BrowserPort } from "../engine/port";
import type { Config } from "../resolver/types";
import {
  SEED_CONFIG_YAML,
  readStoredConfigYaml,
  writeStoredConfigYaml,
  openConfigEditor,
} from "./config";

// Injected at bundle time by esbuild (harness/build-extension.ts).
declare const __CC_GRACE_MS__: number;
declare const __CC_REDIRECTOR_DELAY_MS__: number;

const realPort = createBrowserPort();

// The config now comes from storage, which is async — but EVERY browser.* listener
// below must still be registered SYNCHRONOUSLY while this background script
// evaluates. Registering them after an await loses the session's first navigation
// outright: Firefox dispatches it before the listener exists, so the tab is never
// routed (proven by test/e2e/auto-temp.test.ts, which went red the moment wiring
// moved inside an async IIFE). Two devices keep registration synchronous:
//
//   1. `config` is filled IN PLACE once storage resolves. Every sibling except the
//      script-injector reads `config.rules` / `config.groups` at event time rather
//      than at construction time, so they all observe the load through this object.
//   2. `gatedPort` holds the blocking onBeforeRequest handler until the config has
//      actually arrived, so an early navigation is *delayed* rather than routed
//      against the still-empty config. Firefox awaits a blocking listener's promise
//      before letting the request proceed, which is what makes this safe.
const config: Config = { rules: [], groups: [] };

// Definitely assigned: a Promise executor runs synchronously, but tsc can't see that.
let markConfigReady!: () => void;
const configReady = new Promise<void>((resolve) => {
  markConfigReady = resolve;
});

const gatedPort: BrowserPort = {
  ...realPort,
  onBeforeRequest(handler) {
    realPort.onBeforeRequest(async (details) => {
      await configReady;
      return handler(details);
    });
  },
};

// The throwaway counter is shared by the engine's reopen and auto-temp so their temp
// container names never collide. It starts at 0 and is raised to clear any existing
// tmp<N> as soon as queryIdentities() answers — a reload (every config save triggers
// one) would otherwise reissue a live container's name. Auto-temp cannot wait for
// that answer: its own listeners must register synchronously too.
let n = 0;
const tmpSuffix = () => String(++n);

// `picker` is referenced inside onChoice (which fires only at navigation time, after
// construction), so the forward-reference is safe. Hoisted with `let` to satisfy the
// linter and make the dependency direction explicit.
let picker: ReturnType<typeof createPicker>;
const engine = createEngine({
  port: gatedPort,
  config,
  deps: { matchRule, matchGroup, sameSite },
  tmpSuffix,
  onChoice: (options, nav) => {
    void picker.showChoice(nav.tabId, nav.url, options);
  },
});
picker = createPicker({ port: realPort, config, deps: { matchRule }, reopen: engine.reopen });

createAutoTemp({ port: realPort, tmpSuffix });

createDisposer({ port: realPort, clock: realClock, graceMs: __CC_GRACE_MS__ });

createCookieSeeder({ port: realPort, config, deps: { matchRule } });

createRedirectorCloser({
  port: realPort,
  clock: realClock,
  config,
  deps: { matchRule },
  delayMs: __CC_REDIRECTOR_DELAY_MS__,
});

// Everything past this point may await: the listeners above are already live.
void (async () => {
  const stored = await readStoredConfigYaml();
  const loaded = loadConfig(stored, SEED_CONFIG_YAML);

  // First run: the seed becomes the user's config, and storage is truth from here
  // on — a later version shipping a different seed never overrides an edited config.
  if (loaded.seeded && !loaded.error) await writeStoredConfigYaml(SEED_CONFIG_YAML);

  // Fill the object the siblings are already holding. On a parse failure this leaves
  // it empty: nothing matches, so every site opens in a fresh throwaway. The failure
  // cannot route a site into the WRONG permanent container.
  Object.assign(config, loaded.config);
  markConfigReady();

  if (loaded.error) {
    console.error(
      "[cc] config failed to parse — routing everything to a temporary container",
      loaded.error,
    );
    // The editor opens with the broken text and the parse error already showing.
    await openConfigEditor();
  }

  // Resume the throwaway counter above any tmp<N> that already exists.
  n = Math.max(n, highestTmpSuffix((await realPort.queryIdentities()).map((c) => c.name)));

  // Content-script registration is the one sibling that reads the config eagerly, so
  // it is the one that genuinely has to wait for it.
  await createScriptInjector({ port: realPort, config });
})();
