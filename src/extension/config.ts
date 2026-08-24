// The extension's config plumbing: the build-time SEED, the storage it lives in after first
// run, and the editor page. An L4 adapter, and the only non-page code outside the port that
// touches browser.*. See the 2026-07-28 design spec §4/§5 and the 2026-07-30 sync spec §4;
// the engine's BrowserPort seam knows nothing about it.

// Injected at bundle time by esbuild (harness/build-extension.ts). The FIRST-RUN SEED, not
// the live config: e2e injects the test config, the manual launcher the author's real one,
// `npm run package` src/config/default.yaml.
declare const __CC_CONFIG_YAML__: string;
export const SEED_CONFIG_YAML: string = __CC_CONFIG_YAML__;

export const CONFIG_STORAGE_KEY = "configYaml";
// When the stored config was authored here, or adopted from another machine (adopting
// copies the remote stamp so the two stay comparable). Epoch milliseconds, with two
// reserved low values below.
export const CONFIG_UPDATED_AT_KEY = "configUpdatedAt";
// The text an incoming synced config overwrote, kept so the editor can offer it back.
export const CONFIG_REPLACED_KEY = "configYamlReplaced";

// A config nobody has edited: the first-run seed. Must rank below every real config, or a
// fresh install joining an established Sync account pushes the shipped default over the
// machine that had the real rules.
export const UNEDITED = 0;
// A config edited before stamps existed. Above the seed, below every real edit.
export const PRE_SYNC_EDIT = 1;

// undefined means "never stored" (first run), distinct from "", a valid empty config.
// loadConfig() depends on the difference.
export async function readStoredConfigYaml(): Promise<string | undefined> {
  const got = await browser.storage.local.get(CONFIG_STORAGE_KEY);
  const value = got[CONFIG_STORAGE_KEY];
  return typeof value === "string" ? value : undefined;
}

export async function readStoredUpdatedAt(): Promise<number | undefined> {
  const got = await browser.storage.local.get(CONFIG_UPDATED_AT_KEY);
  const value = got[CONFIG_UPDATED_AT_KEY];
  return typeof value === "number" ? value : undefined;
}

// One `set` for both keys: landing separately leaves a window where the stamp describes the
// wrong text, and that window decides conflicts.
export async function writeStoredConfigYaml(
  yamlText: string,
  updatedAt: number = Date.now(),
): Promise<void> {
  await browser.storage.local.set({
    [CONFIG_STORAGE_KEY]: yamlText,
    [CONFIG_UPDATED_AT_KEY]: updatedAt,
  });
}

export async function readReplacedConfigYaml(): Promise<string | undefined> {
  const got = await browser.storage.local.get(CONFIG_REPLACED_KEY);
  const value = got[CONFIG_REPLACED_KEY];
  return typeof value === "string" ? value : undefined;
}

export async function clearReplacedConfigYaml(): Promise<void> {
  await browser.storage.local.remove(CONFIG_REPLACED_KEY);
}

export async function readSyncItems(): Promise<Record<string, unknown>> {
  return (await browser.storage.sync.get()) as Record<string, unknown>;
}

// Set first, then remove. After the set the record is complete: the meta names which parts
// to read, so a leftover higher-numbered part is ignored. Removing first would tear the
// record if the set then failed.
export async function writeSyncItems(
  items: Record<string, unknown>,
  remove: string[],
): Promise<void> {
  await browser.storage.sync.set(items);
  if (remove.length > 0) await browser.storage.sync.remove(remove);
}

export function onSyncStorageChanged(handler: () => void): void {
  browser.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName === "sync") handler();
  });
}

export async function openConfigEditor(): Promise<void> {
  await browser.runtime.openOptionsPage();
}
