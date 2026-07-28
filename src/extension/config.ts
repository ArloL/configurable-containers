// The extension's config plumbing: the build-time SEED, the storage it lives in
// after first run, and the editor page. This is an L4 adapter — the only place
// outside src/extension/ pages that touches browser.*. See the 2026-07-28 design
// spec §4/§5. The engine's BrowserPort seam deliberately knows nothing about it.

// Injected at bundle time by esbuild (harness/build-extension.ts). This is the
// FIRST-RUN SEED, not the live config: e2e injects the test config, the manual
// launcher injects the author's real one, and `npm run package` injects
// src/config/default.yaml.
declare const __CC_CONFIG_YAML__: string;
export const SEED_CONFIG_YAML: string = __CC_CONFIG_YAML__;

export const CONFIG_STORAGE_KEY = "configYaml";

// undefined means "never stored" (first run) — distinct from "" which is a valid,
// empty config. loadConfig() depends on that distinction.
export async function readStoredConfigYaml(): Promise<string | undefined> {
  const got = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  const value = got[CONFIG_STORAGE_KEY];
  return typeof value === "string" ? value : undefined;
}

export async function writeStoredConfigYaml(yamlText: string): Promise<void> {
  await browser.storage.local.set({ [CONFIG_STORAGE_KEY]: yamlText });
}

export async function openConfigEditor(): Promise<void> {
  await browser.runtime.openOptionsPage();
}
