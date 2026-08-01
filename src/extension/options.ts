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

import { PAUSE_STORAGE_KEY } from "../engine/pause";
import type { ContainerRow, PauseStatusResponse, PauseToggleResponse } from "./pause-protocol";

const textarea = document.getElementById("cc-config") as HTMLTextAreaElement;
const saveButton = document.getElementById("cc-save") as HTMLButtonElement;
const errorEl = document.getElementById("cc-error")!;
const statusEl = document.getElementById("cc-status")!;
const syncEl = document.getElementById("cc-sync")!;
const replacedEl = document.getElementById("cc-replaced") as HTMLElement;
const restoreButton = document.getElementById("cc-restore") as HTMLButtonElement;
const pauseContainersEl = document.getElementById("cc-pause-containers")!;
const pauseRecordingsEl = document.getElementById("cc-pause-recordings")!;
const pauseClearButton = document.getElementById("cc-pause-clear") as HTMLButtonElement;

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

// ---- Pause & record -------------------------------------------------------------
//
// This page never WRITES the pause state: the background is its only writer, and a host
// row landing mid-render would otherwise race a toggle here and one of the two writes
// would be lost. Everything below goes through runtime.sendMessage.

function renderContainerRow(row: ContainerRow): HTMLElement {
  const line = document.createElement("div");
  line.className = "cc-pause-row";

  const button = document.createElement("button");
  button.dataset.ccArm = row.name;
  button.dataset.ccArmed = String(row.armed);
  button.disabled = !row.armable;
  button.textContent = row.armed ? "Resume routing" : "Pause routing";
  button.addEventListener("click", () => {
    void (async () => {
      const reply = (await browser.runtime.sendMessage({
        type: "cc-pause-toggle",
        cookieStoreId: row.cookieStoreId,
      })) as PauseToggleResponse;
      if (!reply.ok) line.append(` ${reply.message}`);
      await renderPause();
    })();
  });

  const label = document.createElement("span");
  const tabs = `${row.tabCount} tab${row.tabCount === 1 ? "" : "s"}`;
  // The hosts are what make a throwaway row identifiable: "tmp12" alone says nothing
  // about which flow it is holding, and that is the one thing the user needs to know.
  const where = row.hosts.length > 0 ? ` · ${row.hosts.join(", ")}` : "";
  const why = row.armable ? "" : ` — ${row.reason ?? ""}`;
  label.textContent = ` ${row.name} · ${tabs}${where}${why}`;

  line.append(button, label);
  return line;
}

function renderRecording(recording: PauseStatusResponse["recordings"][number]): HTMLElement {
  const box = document.createElement("div");
  box.className = "cc-pause-recording";

  const head = document.createElement("p");
  head.className = "cc-pause-when";
  const when = new Date(recording.startedAt).toLocaleString();
  head.textContent = `${recording.container} · ${when}${recording.endedAt === null ? " · recording now" : ""}`;
  box.append(head);

  for (const row of recording.hosts) {
    const line = document.createElement("div");
    line.className = "cc-pause-row";

    const copy = document.createElement("button");
    copy.dataset.ccHost = row.host;
    copy.textContent = "Copy";
    // The host, and nothing else. Choosing between inherit / ignore / open is a
    // judgement about what a domain IS to the user, and CC does not have what it would
    // take to make it — a generated snippet would be CC guessing. This removes the
    // typo, not the decision.
    copy.addEventListener("click", () => void navigator.clipboard.writeText(row.host));

    const label = document.createElement("span");
    label.className = "cc-pause-host";
    label.textContent = ` ${row.host} ×${row.hits} — ${row.wouldHave}`;

    line.append(copy, label);
    box.append(line);
  }

  if (recording.hosts.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Nothing seen yet.";
    box.append(empty);
  }
  return box;
}

async function renderPause(): Promise<void> {
  const status = (await browser.runtime.sendMessage({ type: "cc-pause-status" })) as PauseStatusResponse;
  pauseContainersEl.replaceChildren(...status.containers.map(renderContainerRow));
  pauseRecordingsEl.replaceChildren(...status.recordings.map(renderRecording));
}

pauseClearButton.addEventListener("click", () => {
  void (async () => {
    await browser.runtime.sendMessage({ type: "cc-pause-clear" });
    await renderPause();
  })();
});

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

  await renderPause();
  // Live, so a recording grows while you watch it — that mid-flow glance is what a
  // toolbar popup would have been for, and it comes free here. The subscription is only
  // a SIGNAL: the data still arrives through the message, so the background remains the
  // only reader of its own storage shape. The repaint touches the pause subtree alone,
  // never the textarea, so unsaved edits cannot be clobbered by a background write.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && PAUSE_STORAGE_KEY in changes) void renderPause();
  });
})();
