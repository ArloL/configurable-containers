// The config editor. Reads storage into a textarea, re-parses on every keystroke
// (parseConfig is pure and sub-millisecond at this size, so no debounce), and
// refuses to save anything that does not parse. Saving writes storage and reloads
// the extension so every sibling re-reads the config at startup — see the
// 2026-07-28 design spec §5.

import { parseConfig, ConfigError } from "../config/parse";
import { scriptRegistrations } from "../overlays/scripts";
import { readStoredConfigYaml, writeStoredConfigYaml } from "./config";

const textarea = document.getElementById("cc-config") as HTMLTextAreaElement;
const saveButton = document.getElementById("cc-save") as HTMLButtonElement;
const errorEl = document.getElementById("cc-error")!;
const statusEl = document.getElementById("cc-status")!;
const grantSection = document.getElementById("cc-grant-scripts") as HTMLDivElement;
const grantButton = document.getElementById("cc-grant") as HTMLButtonElement;
const grantStatusEl = document.getElementById("cc-grant-status")!;

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

textarea.addEventListener("input", () => {
  statusEl.textContent = "";
  validate();
});

saveButton.addEventListener("click", () => {
  if (!validate()) return;
  void (async () => {
    await writeStoredConfigYaml(textarea.value);
    statusEl.textContent = "Saved — reloading";
    // runtime.reload() tears down every extension page, including this one. The
    // delay lets the status paint first so the teardown reads as a consequence of
    // the click rather than a crash.
    setTimeout(() => browser.runtime.reload(), 100);
  })();
});

// The prompt is only worth showing to someone it affects: a config with no `scripts:`
// overlay needs nothing, and a granted permission needs nothing either. Anything that
// does not parse is not asked about at all — the parse error is the message that matters.
async function refreshScriptsPermissionPrompt(): Promise<void> {
  let usesScripts = false;
  try {
    usesScripts = scriptRegistrations(parseConfig(textarea.value)).length > 0;
  } catch {
    usesScripts = false;
  }
  const granted = await browser.permissions.contains({ permissions: ["userScripts"] });
  grantSection.hidden = !usesScripts || granted;
}

grantButton.addEventListener("click", () => {
  // Inside the click handler on purpose: permissions.request is rejected without a
  // user gesture, which is exactly why the background script cannot do this itself.
  void (async () => {
    const granted = await browser.permissions.request({ permissions: ["userScripts"] });
    if (!granted) {
      grantStatusEl.textContent = "Not granted.";
      return;
    }
    grantStatusEl.textContent = "Granted — reloading";
    // The injector registers at startup, so the scripts only take effect on the next
    // one. Same reload the Save button uses, for the same reason.
    setTimeout(() => browser.runtime.reload(), 100);
  })();
});

textarea.addEventListener("input", () => {
  void refreshScriptsPermissionPrompt();
});

void (async () => {
  textarea.value = (await readStoredConfigYaml()) ?? "";
  // Validate on load too: the stored text may already be broken (spec §6), and the
  // page must show that without waiting for a keystroke.
  validate();
  await refreshScriptsPermissionPrompt();
})();
