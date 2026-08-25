import { createBrowserPort, realClock } from "../engine/browser-port";
import { loadConfig } from "../config/load";
import { wireBackground } from "./wiring";
import {
  SEED_CONFIG_YAML,
  UNEDITED,
  readStoredConfigYaml,
  writeStoredConfigYaml,
  openConfigEditor,
} from "./config";
import { browserSyncPorts, createConfigSync } from "./config-sync";

// Injected at bundle time by esbuild (harness/build-extension.ts).
declare const __CC_GRACE_MS__: number;
declare const __CC_REDIRECTOR_DELAY_MS__: number;

// Built before the wiring so the two can reach each other: a Save publishes through this,
// and a config adopted from another machine applies through the wiring. Constructing it
// registers no listener and touches no storage — `start()` in the tail does both — so it
// costs nothing here and keeps every registration below synchronous.
//
// The arrow is what makes the forward reference safe: adoption cannot run before `start()`,
// which is long after `wireBackground` returned. Same shape as `picker` inside wiring.ts.
const configSync = createConfigSync(browserSyncPorts(() => background.applyStored()));

// Synchronous by contract: every browser.* listener registers while this script evaluates,
// before the async tail below can lose the session's first navigation. wiring.ts says why.
const background = wireBackground({
  port: createBrowserPort(),
  clock: realClock,
  graceMs: __CC_GRACE_MS__,
  redirectorDelayMs: __CC_REDIRECTOR_DELAY_MS__,
  // A Save used to publish by restarting: the fresh background's tail reconciled on the way
  // up. Nothing restarts now, so the apply fires the publish. Not awaited — a save must not
  // wait on a network-backed area — and `enqueue` already serialises what it starts.
  afterApply: () => void configSync.sync(),
});

// Everything past this point may await: the listeners are already live.
void (async () => {
  const stored = await readStoredConfigYaml();
  const loaded = loadConfig(stored, SEED_CONFIG_YAML);

  // First run: the seed becomes the user's config and storage is the truth from here on, so
  // a later build's seed never overrides an edited config. This happens even when the seed
  // does NOT parse — storing the broken text is what lets the editor below show it with its
  // parse error, where skipping the write would greet the user with a blank textarea.
  // Stamped UNEDITED so a fresh install joining an established Sync account pulls the real
  // config instead of pushing the shipped default over it.
  if (loaded.seeded) await writeStoredConfigYaml(SEED_CONFIG_YAML, UNEDITED);

  background.useConfig(loaded.config);

  if (loaded.error) {
    console.error(
      "[cc] config failed to parse — routing everything to a temporary container",
      loaded.error,
    );
    // Opened so the user sees the broken text with its parse error.
    await openConfigEditor();
  }

  await background.resumeTmpSuffix();

  await background.injectScripts();

  // Last, because it is the only step that can adopt another machine's config, and there is
  // no point applying one mid-startup. Everything routing needs is already live.
  await configSync.start();
})();
