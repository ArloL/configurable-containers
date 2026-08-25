// The config editor. Re-parses on every keystroke with no debounce, because parseConfig is
// pure and sub-millisecond at this size, and refuses to save anything that does not parse.
// Saving writes storage and asks the background to apply it — 2026-08-25 spec. It used to
// call runtime.reload(), which is the one step of a save nothing here could observe.
//
// It REPORTS on Firefox Sync (2026-07-30 spec §6) without ever writing to it: the background
// is the only publisher, so this page says what the sync area holds and offers back a config
// an incoming sync replaced.

import { parseConfigDetailed, ConfigError } from "../config/parse";
import { stampVersion } from "../config/stamp";
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

import { CONFIG_APPLY, type ConfigApplyResponse } from "./config-protocol";
import { PAUSE_STORAGE_KEY } from "../engine/pause";
import type { ContainerRow, PauseStatusResponse, PauseToggleResponse } from "./pause-protocol";

const textarea = document.getElementById("cc-config") as HTMLTextAreaElement;
const saveButton = document.getElementById("cc-save") as HTMLButtonElement;
const errorEl = document.getElementById("cc-error")!;
const warningsEl = document.getElementById("cc-warnings")!;
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

// Also drives the error and warning regions and the Save button's disabled state.
//
// A warning is what a config written by a NEWER build leaves behind here: the parts of it
// this build has never heard of, which it ignored rather than refused. It does not disable
// Save — this machine must still be able to edit and re-publish a config it only partly
// understands, or updating one machine strands every other one read-only.
function validate(): boolean {
  try {
    const parsed = parseConfigDetailed(textarea.value);
    errorEl.textContent = "";
    warningsEl.textContent = parsed.warnings.map((w) => w.message).join("\n");
    saveButton.disabled = false;
    return true;
  } catch (e) {
    errorEl.textContent = describe(e);
    warningsEl.textContent = "";
    saveButton.disabled = true;
    return false;
  }
}

// What the sync area holds, against what is stored locally. Derived on every visit rather
// than cached: a cached status is one more thing that can be stale in exactly the situation
// this page exists to explain.
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
      // An unedited config carries a reserved stamp, not a time; rendering it would date
      // every fresh install to 1970.
      const when =
        remote.updatedAt > PRE_SYNC_EDIT
          ? `, last change ${new Date(remote.updatedAt).toLocaleString()}`
          : "";
      syncEl.textContent = `Synced via Firefox Sync — ${remote.parts} ${unit}${when}.`;
    }
  }
}

// Shown only when a synced config replaced something. The button loads the replaced text
// INTO THE TEXTAREA, never into storage: the user sees what they are restoring, validation
// runs on it, and keeping it goes through the ordinary Save — no second write path that
// could stamp or publish differently.
async function renderReplaced(): Promise<void> {
  const replaced = await readReplacedConfigYaml();
  const stored = await readStoredConfigYaml();
  replacedEl.hidden = replaced === undefined || replaced === stored;
}

// ---- Pause & record -------------------------------------------------------------
//
// This page never WRITES the pause state: the background is its only writer, and a host row
// landing mid-render would race a toggle here and lose one of the two writes. Everything
// below goes through runtime.sendMessage.

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
  // The hosts are what make a throwaway row identifiable: "tmp12" alone says nothing about
  // which flow it holds.
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
    // The host, and nothing else. Choosing between inherit / ignore / open is a judgement
    // about what a domain IS to the user, which CC cannot make. This removes the typo, not
    // the decision.
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
    // The `version:` line is derived, so it is written here rather than by whoever
    // remembers: it is what tells a machine still on an older build that the keys it does
    // not recognise are features rather than typos. Saved back into the editor so the text
    // on screen is the text that was stored.
    textarea.value = stampVersion(textarea.value);

    // The stamp decides conflicts against other machines; the background reads it back when
    // the apply below publishes.
    await writeStoredConfigYaml(textarea.value, Date.now());
    await clearReplacedConfigYaml();
    statusEl.textContent = "Saving…";
    // No spinner: an apply is a storage read, a parse and a handful of registrations, so a
    // spinner would flash rather than inform. The button is what says "in flight", and
    // disabling it also keeps a second Save from racing the first.
    saveButton.disabled = true;

    // The status reports the background's answer instead of predicting it. The old one said
    // "Saved — reloading" and called runtime.reload(), which on a temporarily installed
    // extension on 140 ESR never came back: the old config kept routing and this page said
    // it had saved. An unanswered apply now says so.
    let report: ConfigApplyResponse | undefined;
    try {
      report = (await browser.runtime.sendMessage({ type: CONFIG_APPLY })) as ConfigApplyResponse | undefined;
    } catch {
      report = undefined;
    }
    statusEl.textContent =
      report === undefined
        ? "Stored, but the extension did not confirm it applied — restart Firefox"
        : report.scriptError
          ? `Saved — a script could not be registered: ${report.scriptError}`
          : "Saved";

    // Re-derives the button's disabled state from the text, which is what re-enables Save.
    validate();

    // This page survives its own save now, so what it says about sync and about a replaced
    // config has to be brought up to date rather than rebuilt by a restart.
    await renderSyncStatus();
    await renderReplaced();
  })();
});

void (async () => {
  textarea.value = (await readStoredConfigYaml()) ?? "";
  // Validate on load too: the stored text may already be broken (spec §6), and the page
  // must show that without waiting for a keystroke.
  validate();
  await renderReplaced();
  await renderSyncStatus();
  // Live: the background pushes in its startup tail, possibly after this page painted, and
  // a status stuck on "not yet published" until the next visit reports a race, not a fact.
  onSyncStorageChanged(() => void renderSyncStatus());

  await renderPause();
  // Live, so a recording grows while you watch it — the mid-flow glance a toolbar popup
  // would have been for, free here. The subscription is only a SIGNAL: the data still
  // arrives through the message, so the background stays the only reader of its own storage
  // shape. The repaint touches the pause subtree alone, never the textarea, so unsaved edits
  // survive a background write.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && PAUSE_STORAGE_KEY in changes) void renderPause();
  });
})();
