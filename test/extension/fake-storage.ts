// A hand-rolled fake of the `browser.*` surface `src/extension/config.ts` and
// `browserSyncPorts()` touch, installed as the global `browser` for the duration of a
// test. Same shape and the same reason as the one in `test/engine/browser-port.test.ts`:
// the subject is the ADAPTER, so what matters is which calls it makes, in what order,
// with what payload — not a faithful model of Firefox's storage semantics.
//
// Two behaviours are modelled because the code under test depends on them:
//
//   - `storage.local.get(key)` answers `{}` when the key was never stored, and
//     `{ [key]: value }` when it was. That is the difference `readStoredConfigYaml`
//     turns into `undefined` vs `""`, and `loadConfig` routes on it.
//   - `storage.onChanged` fires with an area NAME, and fires for `local` writes too.
//     `onSyncStorageChanged` exists to filter those out.

export interface FakeBrowser {
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
  // Every call the adapter made, in order, as `<area>.<method>`. Ordering across areas
  // is what pins "set, then remove" in writeSyncItems.
  calls: string[];
  localSets: Record<string, unknown>[];
  localRemoves: string[][];
  syncSets: Record<string, unknown>[];
  syncRemoves: string[][];
  // Delivers a change event the way Firefox does — to every listener, with the area name.
  fireChange(areaName: string): void;
  optionsPagesOpened: number;
  reloads: number;
}

export function installFakeBrowser(): FakeBrowser {
  const calls: string[] = [];
  const changeListeners: ((changes: Record<string, unknown>, areaName: string) => void)[] = [];

  const f: FakeBrowser = {
    local: {},
    sync: {},
    calls,
    localSets: [],
    localRemoves: [],
    syncSets: [],
    syncRemoves: [],
    fireChange(areaName) {
      for (const listener of changeListeners) listener({}, areaName);
    },
    optionsPagesOpened: 0,
    reloads: 0,
  };

  function area(
    name: "local" | "sync",
    store: Record<string, unknown>,
    sets: Record<string, unknown>[],
    removes: string[][],
  ) {
    return {
      get(key?: string): Promise<Record<string, unknown>> {
        calls.push(`${name}.get`);
        if (key === undefined) return Promise.resolve({ ...store });
        return Promise.resolve(key in store ? { [key]: store[key] } : {});
      },
      set(items: Record<string, unknown>): Promise<void> {
        calls.push(`${name}.set`);
        sets.push(items);
        Object.assign(store, items);
        return Promise.resolve();
      },
      remove(keys: string | string[]): Promise<void> {
        calls.push(`${name}.remove`);
        const list = typeof keys === "string" ? [keys] : keys;
        removes.push(list);
        for (const key of list) delete store[key];
        return Promise.resolve();
      },
    };
  }

  const fake = {
    storage: {
      local: area("local", f.local, f.localSets, f.localRemoves),
      sync: area("sync", f.sync, f.syncSets, f.syncRemoves),
      onChanged: {
        addListener(fn: (changes: Record<string, unknown>, areaName: string) => void) {
          changeListeners.push(fn);
        },
      },
    },
    runtime: {
      openOptionsPage(): Promise<void> {
        f.optionsPagesOpened += 1;
        return Promise.resolve();
      },
      reload(): void {
        f.reloads += 1;
      },
    },
  };

  (globalThis as unknown as { browser: unknown }).browser = fake;
  return f;
}

export function uninstallFakeBrowser(): void {
  delete (globalThis as unknown as { browser?: unknown }).browser;
}
