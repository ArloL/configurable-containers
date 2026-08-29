// Mirrors the stored config into browser.storage.sync so an edit on one machine reaches the
// others. See the 2026-07-30 design spec.
//
// `storage.local.configYaml` stays the single source of truth for routing: nothing in the
// engine, the wiring or loadConfig learns that sync exists. The sync area is a MIRROR — read,
// compared, then either overwritten from local or copied into local — and applying an adopted
// config reuses the path a Save takes (write storage, then apply it in place). That is what
// keeps this out of wireBackground's startup contract.
//
// The BACKGROUND is the sync area's only writer. The options page writes storage.local and
// asks the background to apply it; the background publishes. One publisher means no window
// in which the options page and the background both write.

import {
  ConfigTooLargeError,
  decodeRecord,
  encodeRecord,
  reconcile,
  staleKeys,
} from "../config/sync-record";
import {
  CONFIG_REPLACED_KEY,
  CONFIG_STORAGE_KEY,
  CONFIG_UPDATED_AT_KEY,
  PRE_SYNC_EDIT,
  SEED_CONFIG_YAML,
  UNEDITED,
  onSyncStorageChanged,
  readStoredConfigYaml,
  readStoredUpdatedAt,
  readSyncItems,
  writeSyncItems,
} from "./config";

export interface SyncPorts {
  readLocal(): Promise<{ text: string; updatedAt: number }>;
  // Replaces the local config with one from another machine and applies it. Never called
  // with text equal to the local text: reconcile() guarantees that, and that guarantee is
  // what stops two machines reloading each other forever.
  adopt(text: string, updatedAt: number): Promise<void>;
  readSync(): Promise<Record<string, unknown>>;
  writeSync(items: Record<string, unknown>, remove: string[]): Promise<void>;
  onSyncChanged(handler: () => void): void;
  warn(message: string, cause?: unknown): void;
}

export type SyncOutcome =
  | "in-sync" // the two copies agree
  | "pushed" // the local config is now the published one
  | "adopted" // a remote config replaced the local one and has already been applied
  | "waiting" // the remote record is half-arrived or from a newer build
  | "too-large" // the config needs more parts than the area allows
  | "failed"; // storage.sync could not be read or written

export interface ConfigSync {
  start(): Promise<SyncOutcome>;
  sync(): Promise<SyncOutcome>;
}

export function createConfigSync(ports: SyncPorts): ConfigSync {
  async function reconcileOnce(): Promise<SyncOutcome> {
    let items: Record<string, unknown>;
    try {
      items = await ports.readSync();
    } catch (e) {
      // No Firefox Account, storage disabled, a transient backend error. None of it changes
      // how a tab is routed — routing reads storage.local. Retried at the next startup and
      // the next change event.
      ports.warn("could not read storage.sync", e);
      return "failed";
    }

    const remote = decodeRecord(items);
    const local = await ports.readLocal();
    const decision = reconcile(local, remote);

    switch (decision.action) {
      case "none":
        return remote.state === "ok" ? "in-sync" : "waiting";

      case "push": {
        let encoded: Record<string, unknown>;
        try {
          encoded = encodeRecord(local.text, local.updatedAt);
        } catch (e) {
          if (e instanceof ConfigTooLargeError) {
            ports.warn(e.message);
            return "too-large";
          }
          throw e;
        }
        const parts = Object.keys(encoded).length - 1; // every key but the meta
        try {
          await ports.writeSync(encoded, staleKeys(items, parts));
        } catch (e) {
          ports.warn("could not write storage.sync", e);
          return "failed";
        }
        return "pushed";
      }

      case "adopt":
        await ports.adopt(decision.text, decision.updatedAt);
        return "adopted";
    }
  }

  // Serialised: a push is itself a change event, and two concurrent reconciliations could
  // both read the pre-write area and both decide to push.
  let inFlight: Promise<SyncOutcome> = Promise.resolve("in-sync");
  function enqueue(): Promise<SyncOutcome> {
    inFlight = inFlight.then(reconcileOnce, reconcileOnce);
    return inFlight;
  }

  return {
    sync: enqueue,
    start() {
      // Register before the first reconciliation: a change landing during that first pass
      // would otherwise be the one nobody hears about.
      ports.onSyncChanged(() => void enqueue());
      return enqueue();
    },
  };
}

// ---------------------------------------------------------------------------
// Everything below touches browser.* — the only part of this module that cannot run under
// a fake.
// ---------------------------------------------------------------------------

// `apply` puts the adopted text into effect: the wiring's applyStored, handed in by
// background.ts. Taken as an argument rather than imported because the wiring is built after
// this is, and because an adoption that could not apply would have to restart the extension
// — the step this slice removed.
export function browserSyncPorts(apply: () => Promise<unknown>): SyncPorts {
  return {
    async readLocal() {
      const text = (await readStoredConfigYaml()) ?? "";
      const stored = await readStoredUpdatedAt();
      if (stored !== undefined) return { text, updatedAt: stored };
      // Installed before this slice existed, so nothing stamped this config. An untouched
      // seed must rank BELOW every real edit, or a fresh install wins the tie-break and
      // replaces another machine's rules with the shipped default.
      const updatedAt = text === SEED_CONFIG_YAML ? UNEDITED : PRE_SYNC_EDIT;
      await browser.storage.local.set({ [CONFIG_UPDATED_AT_KEY]: updatedAt });
      return { text, updatedAt };
    },

    async adopt(text, updatedAt) {
      const previous = await readStoredConfigYaml();
      // Keep what we are about to overwrite: without it, the first startup after this ships
      // silently destroys a hand-written config, the one failure editing cannot undo.
      const backup =
        previous !== undefined && previous !== text ? { [CONFIG_REPLACED_KEY]: previous } : {};
      await browser.storage.local.set({
        [CONFIG_STORAGE_KEY]: text,
        [CONFIG_UPDATED_AT_KEY]: updatedAt,
        ...backup,
      });
      // The same apply path a Save takes; there is deliberately no second one. It used to be
      // runtime.reload(), which is the one step of an apply nothing could observe — and on a
      // temporarily installed extension on 140 ESR it never came back at all.
      await apply();
    },

    readSync: readSyncItems,
    writeSync: writeSyncItems,
    onSyncChanged: onSyncStorageChanged,
    warn(message, cause) {
      console.warn(`[cc] config sync: ${message}`, cause ?? "");
    },
  };
}
