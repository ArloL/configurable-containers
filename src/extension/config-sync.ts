// Mirrors the stored config into browser.storage.sync so a config edited on one machine
// reaches the others. See the 2026-07-30 design spec.
//
// `storage.local.configYaml` stays the single source of truth for routing: nothing in
// the engine, the wiring or loadConfig learns that sync exists. The sync area is a
// MIRROR — read, compared, and either overwritten from local or copied into local — and
// applying an adopted config reuses the path a Save already takes (write storage, then
// runtime.reload()). That is what keeps this out of the startup contract wireBackground
// documents: listeners still register synchronously and the gated first navigation still
// waits on exactly one promise.
//
// The BACKGROUND is the only writer of the sync area. The options page writes
// storage.local and reloads; the fresh background then reconciles and pushes. One
// publisher means no window in which a dying options page and a starting background both
// write.

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
  // Replaces the local config with one that arrived from another machine and applies it.
  // Never called with text equal to the local text — reconcile() guarantees that, and it
  // is the guarantee that stops two machines reloading each other forever.
  adopt(text: string, updatedAt: number): Promise<void>;
  readSync(): Promise<Record<string, unknown>>;
  writeSync(items: Record<string, unknown>, remove: string[]): Promise<void>;
  onSyncChanged(handler: () => void): void;
  warn(message: string, cause?: unknown): void;
}

export type SyncOutcome =
  | "in-sync" // the two copies agree
  | "pushed" // the local config is now the published one
  | "adopted" // a remote config replaced the local one; a reload is under way
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
      // No Firefox Account, storage disabled, a transient backend error. None of this can
      // change how a tab is routed: routing reads storage.local and never learns whether
      // the mirror is healthy. Retried at the next startup and the next change event.
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

  // Serialised: a change event arrives while a push is in flight (a push is itself a
  // change event), and two concurrent reconciliations could both read a pre-write area
  // and both decide to push.
  let inFlight: Promise<SyncOutcome> = Promise.resolve("in-sync");
  function enqueue(): Promise<SyncOutcome> {
    inFlight = inFlight.then(reconcileOnce, reconcileOnce);
    return inFlight;
  }

  return {
    sync: enqueue,
    start() {
      // Register before the first reconciliation, not after: a change landing while that
      // first pass runs would otherwise be the one change nobody hears about.
      ports.onSyncChanged(() => void enqueue());
      return enqueue();
    },
  };
}

// ---------------------------------------------------------------------------
// The real ports. Everything below this line touches browser.* and is the only
// part of the module that cannot run under a fake.
// ---------------------------------------------------------------------------

export function browserSyncPorts(): SyncPorts {
  return {
    async readLocal() {
      const text = (await readStoredConfigYaml()) ?? "";
      const stored = await readStoredUpdatedAt();
      if (stored !== undefined) return { text, updatedAt: stored };
      // Installed before this slice existed, so nothing ever stamped this config. An
      // untouched seed must rank BELOW every real edit, or a fresh install could win the
      // tie-break and replace another machine's rules with the shipped default.
      const updatedAt = text === SEED_CONFIG_YAML ? UNEDITED : PRE_SYNC_EDIT;
      await browser.storage.local.set({ [CONFIG_UPDATED_AT_KEY]: updatedAt });
      return { text, updatedAt };
    },

    async adopt(text, updatedAt) {
      const previous = await readStoredConfigYaml();
      // Keep what we are about to overwrite. Without this, the first startup after this
      // slice ships is a silent overwrite of a hand-written file — the one failure here
      // that editing cannot undo.
      const backup =
        previous !== undefined && previous !== text ? { [CONFIG_REPLACED_KEY]: previous } : {};
      await browser.storage.local.set({
        [CONFIG_STORAGE_KEY]: text,
        [CONFIG_UPDATED_AT_KEY]: updatedAt,
        ...backup,
      });
      // The same apply path a Save takes. There is deliberately no second way for a
      // config to take effect.
      browser.runtime.reload();
    },

    readSync: readSyncItems,
    writeSync: writeSyncItems,
    onSyncChanged: onSyncStorageChanged,
    warn(message, cause) {
      console.warn(`[cc] config sync: ${message}`, cause ?? "");
    },
  };
}
