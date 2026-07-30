// The config editor. Reads storage into a textarea, re-parses on every keystroke
// (parseConfig is pure and sub-millisecond at this size, so no debounce), and
// refuses to save anything that does not parse. Saving writes storage and reloads
// the extension so every sibling re-reads the config at startup — see the
// 2026-07-28 design spec §5.
//
// It also REPORTS on Firefox Sync (2026-07-30 spec §6) without ever writing to it: the
// background is the only publisher, so this page's job is to say what is actually in the
// sync area and to hand back a config that an incoming sync replaced.

import { parseConfig, ConfigError } from "../config/parse";
import { MAX_PARTS, decodeRecord, splitParts } from "../config/sync-record";
import {
  PRE_SYNC_EDIT,
  clearReplacedConfigYaml,
  onSyncStorageChanged,
  readReplacedConfigYaml,
  readStoredConfigYaml,
  readSyncItems,
  writeStoredConfigYaml,
} from "./config";

const textarea = document.getElementById("cc-config") as HTMLTextAreaElement;
const saveButton = document.getElementById("cc-save") as HTMLButtonElement;
const errorEl = document.getElementById("cc-error")!;
const statusEl = document.getElementById("cc-status")!;
const syncEl = document.getElementById("cc-sync")!;
const replacedEl = document.getElementById("cc-replaced") as HTMLElement;
const restoreButton = document.getElementById("cc-restore") as HTMLButtonElement;

function describe(e: unknown): string {
  if (e instanceof ConfigError) {
    const where = e.line !== undefined ? ` (line ${e.line}${e.col !== undefined ? `, col ${e.col}` : ""})` : "";
    return e.message + where;
  }
  return String(e);
}

// Returns true iff the current text parses; drives the error region and Save.
function validate(): boolean {
  try {
    parseConfig(textarea.value);
    errorEl.textContent = "";
    saveButton.disabled = false;
    return true;
  } catch (e) {
    errorEl.textContent = describe(e);
    saveButton.disabled = true;
    return false;
  }
}

// What the sync area actually holds, compared against what is stored locally. Derived on
// every visit rather than cached: a cached status would be one more thing that can be
// stale in exactly the situation this page exists to explain.
async function renderSyncStatus(): Promise<void> {
  const stored = (await readStoredConfigYaml()) ?? "";
  const parts = splitParts(stored).length;
  if (parts > MAX_PARTS) {
    syncEl.textContent =
      `Too large for Firefox Sync — this config needs ${parts} parts and the limit is ` +
      `${MAX_PARTS}. It is not being synced.`;
    return;
  }

  let remote;
  try {
    remote = decodeRecord(await readSyncItems());
  } catch {
    syncEl.textContent = "Firefox Sync is unavailable on this machine.";
    return;
  }

  switch (remote.state) {
    case "absent":
      syncEl.textContent = "Not yet published to Firefox Sync.";
      return;
    case "incomplete":
      syncEl.textContent = "Syncing…";
      return;
    case "unreadable":
      syncEl.textContent =
        "Firefox Sync holds a config written by a newer version of this extension.";
      return;
    case "ok": {
      if (remote.text !== stored) {
        syncEl.textContent = "A different config is in Firefox Sync; reconciling.";
        return;
      }
      const unit = remote.parts === 1 ? "part" : "parts";
      // A config nobody has edited carries a reserved stamp, not a time. Rendering it
      // would date every fresh install to 1970.
      const when =
        remote.updatedAt > PRE_SYNC_EDIT
          ? `, last change ${new Date(remote.updatedAt).toLocaleString()}`
          : "";
      syncEl.textContent = `Synced via Firefox Sync — ${remote.parts} ${unit}${when}.`;
    }
  }
}

// Shown only when a synced config actually replaced something. The button loads the
// replaced text INTO THE TEXTAREA, never straight into storage: the user sees what they
// are restoring, validate-on-input runs against it, and keeping it goes through the same
// Save as any other edit — so there is no second write path that could stamp or publish
// differently.
async function renderReplaced(): Promise<void> {
  const replaced = await readReplacedConfigYaml();
  const stored = await readStoredConfigYaml();
  replacedEl.hidden = replaced === undefined || replaced === stored;
}

textarea.addEventListener("input", () => {
  statusEl.textContent = "";
  validate();
});

restoreButton.addEventListener("click", () => {
  void (async () => {
    const replaced = await readReplacedConfigYaml();
    if (replaced === undefined) return;
    textarea.value = replaced;
    validate();
    statusEl.textContent = "Loaded into the editor — press Save to keep it.";
  })();
});

saveButton.addEventListener("click", () => {
  if (!validate()) return;
  void (async () => {
    // Date.now() is what decides conflicts against other machines; the background reads
    // it back on the restart below and publishes.
    await writeStoredConfigYaml(textarea.value, Date.now());
    await clearReplacedConfigYaml();
    statusEl.textContent = "Saved — reloading";
    // runtime.reload() tears down every extension page, including this one. The
    // delay lets the status paint first so the teardown reads as a consequence of
    // the click rather than a crash.
    setTimeout(() => browser.runtime.reload(), 100);
  })();
});

void (async () => {
  textarea.value = (await readStoredConfigYaml()) ?? "";
  // Validate on load too: the stored text may already be broken (spec §6), and the
  // page must show that without waiting for a keystroke.
  validate();
  await renderReplaced();
  await renderSyncStatus();
  // Live: the background pushes in its startup tail, which may well be after this page
  // painted, and a status that said "not yet published" until the next visit would be
  // reporting a race rather than the truth.
  onSyncStorageChanged(() => void renderSyncStatus());
})();
