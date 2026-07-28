// The config editor. Reads storage into a textarea, re-parses on every keystroke
// (parseConfig is pure and sub-millisecond at this size, so no debounce), and
// refuses to save anything that does not parse. Saving writes storage and reloads
// the extension so every sibling re-reads the config at startup — see the
// 2026-07-28 design spec §5.

import { parseConfig, ConfigError } from "../config/parse";
import { readStoredConfigYaml, writeStoredConfigYaml } from "./config";

const textarea = document.getElementById("cc-config") as HTMLTextAreaElement;
const saveButton = document.getElementById("cc-save") as HTMLButtonElement;
const errorEl = document.getElementById("cc-error")!;
const statusEl = document.getElementById("cc-status")!;

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

void (async () => {
  textarea.value = (await readStoredConfigYaml()) ?? "";
  // Validate on load too: the stored text may already be broken (spec §6), and the
  // page must show that without waiting for a keystroke.
  validate();
})();
