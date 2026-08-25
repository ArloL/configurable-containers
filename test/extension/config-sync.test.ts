import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  browserSyncPorts,
  createConfigSync,
  type SyncPorts,
} from "../../src/extension/config-sync";
import {
  CONFIG_REPLACED_KEY,
  CONFIG_STORAGE_KEY,
  CONFIG_UPDATED_AT_KEY,
  PRE_SYNC_EDIT,
  SEED_CONFIG_YAML,
  UNEDITED,
} from "../../src/extension/config";
import { installFakeBrowser, uninstallFakeBrowser, type FakeBrowser } from "./fake-storage";
import {
  CHUNK_CHARS,
  MAX_PARTS,
  META_KEY,
  decodeRecord,
  encodeRecord,
  partKey,
} from "../../src/config/sync-record";

// An in-memory stand-in for browser.storage.sync plus the one local config. It fires the
// change handler on every write, exactly as Firefox does — which is what makes the
// anti-ping-pong case real rather than asserted by inspection.
function aMachine(opts: { text: string; updatedAt: number }) {
  const area: Record<string, unknown> = {};
  const listeners: (() => void)[] = [];
  const warnings: string[] = [];
  const local = { text: opts.text, updatedAt: opts.updatedAt };
  const applied: { text: string; updatedAt: number }[] = [];
  let failReads = false;
  let failWrites = false;
  let writes = 0;

  const ports: SyncPorts = {
    readLocal: () => Promise.resolve({ ...local }),
    adopt(text, updatedAt) {
      applied.push({ text, updatedAt });
      local.text = text;
      local.updatedAt = updatedAt;
      return Promise.resolve();
    },
    readSync() {
      if (failReads) return Promise.reject(new Error("no account"));
      return Promise.resolve({ ...area });
    },
    async writeSync(items, remove) {
      if (failWrites) throw new Error("QuotaExceededError");
      // A write feeds itself back as a change event below, so a lost convergence
      // property is an infinite loop rather than a wrong answer. Without this cap the
      // suite HANGS instead of going red — verified by backing the equal-text guard out
      // of reconcile().
      if (++writes > 20) throw new Error("runaway: storage.sync written 20 times");
      Object.assign(area, items);
      for (const key of remove) delete area[key];
      // Firefox delivers our own write back as a change event too.
      await Promise.resolve();
      for (const listener of listeners) listener();
    },
    onSyncChanged(handler) {
      listeners.push(handler);
    },
    warn(message) {
      warnings.push(message);
    },
  };

  return {
    ports,
    area,
    local,
    applied,
    warnings,
    writes: () => writes,
    changeEvents: () => listeners.length,
    fireChange: () => listeners.forEach((l) => l()),
    publish(text: string, updatedAt: number) {
      Object.assign(area, encodeRecord(text, updatedAt));
    },
    breakReads() {
      failReads = true;
    },
    fixReads() {
      failReads = false;
    },
    breakWrites() {
      failWrites = true;
    },
    sync: createConfigSync(ports),
  };
}

// Reconciliations are serialised on one chain, and a write feeds itself back as a change
// event — so awaiting one more pass is what guarantees the queue is empty before a test
// changes the world underneath it.
async function settle(machine: { sync: { sync: () => Promise<unknown> } }): Promise<void> {
  await machine.sync.sync();
}

describe("mirroring the config into storage.sync", () => {
  it("publishes the local config when nothing has ever been published", async () => {
    const machine = aMachine({ text: "rules: []", updatedAt: 100 });

    expect(await machine.sync.start()).toBe("pushed");

    expect(decodeRecord(machine.area)).toEqual({
      state: "ok",
      text: "rules: []",
      updatedAt: 100,
      parts: 1,
    });
  });

  it("registers for changes before its first pass, so a change during it is not lost", async () => {
    const machine = aMachine({ text: "rules: []", updatedAt: 100 });
    await machine.sync.start();
    expect(machine.changeEvents()).toBe(1);
  });

  it("reports the two copies as agreeing once they do", async () => {
    const machine = aMachine({ text: "rules: []", updatedAt: 100 });
    await machine.sync.start();
    expect(await machine.sync.sync()).toBe("in-sync");
  });

  it("does not react to its own publication, so two machines cannot reload each other", async () => {
    // The push above fires a change event through the same path Firefox uses. If that
    // event could produce another adopt, a converged pair would restart forever.
    const machine = aMachine({ text: "rules: []", updatedAt: 100 });
    await machine.sync.start();
    await machine.sync.sync();
    expect(machine.applied).toEqual([]);
  });

  it("stops writing once the two copies agree", async () => {
    // A push is itself a change event, so a lost convergence property shows up here as
    // an unbounded write loop — the shape "both machines republish forever" takes.
    const machine = aMachine({ text: "rules: []", updatedAt: 100 });
    await machine.sync.start();
    await settle(machine);
    await settle(machine);
    expect(machine.writes()).toBe(1);
  });
});

describe("adopting a config from another machine", () => {
  it("applies a newer published config", async () => {
    const machine = aMachine({ text: "old rules", updatedAt: 100 });
    machine.publish("new rules", 200);

    expect(await machine.sync.start()).toBe("adopted");

    expect(machine.applied).toEqual([{ text: "new rules", updatedAt: 200 }]);
  });

  it("applies it exactly once, however many change events follow", async () => {
    const machine = aMachine({ text: "old rules", updatedAt: 100 });
    machine.publish("new rules", 200);
    await machine.sync.start();

    machine.fireChange();
    await machine.sync.sync();

    expect(machine.applied).toHaveLength(1);
  });

  it("publishes over an older config rather than adopting it", async () => {
    const machine = aMachine({ text: "my rules", updatedAt: 300 });
    machine.publish("stale rules", 200);

    expect(await machine.sync.start()).toBe("pushed");

    expect(machine.applied).toEqual([]);
    expect(decodeRecord(machine.area)).toMatchObject({ text: "my rules" });
  });
});

describe("a published record that is only half there", () => {
  it("waits instead of publishing over it", async () => {
    // Reading `absent` here would roll the other machine's update back, and it would then
    // adopt the rollback.
    const machine = aMachine({ text: "my rules", updatedAt: 100 });
    machine.publish("x".repeat(CHUNK_CHARS * 2), 500);
    delete machine.area[partKey(1)];

    expect(await machine.sync.start()).toBe("waiting");

    expect(machine.applied).toEqual([]);
    expect(machine.area[partKey(0)]).toBe("x".repeat(CHUNK_CHARS));
  });

  it("adopts it once the rest arrives", async () => {
    const machine = aMachine({ text: "my rules", updatedAt: 100 });
    const whole = encodeRecord("y".repeat(CHUNK_CHARS + 5), 500);
    machine.area[META_KEY] = whole[META_KEY];
    machine.area[partKey(0)] = whole[partKey(0)];
    expect(await machine.sync.start()).toBe("waiting");

    machine.area[partKey(1)] = whole[partKey(1)];
    expect(await machine.sync.sync()).toBe("adopted");
  });
});

describe("when storage.sync cannot do its job", () => {
  it("leaves the local config alone when the area cannot be read", async () => {
    const machine = aMachine({ text: "my rules", updatedAt: 100 });
    machine.breakReads();

    expect(await machine.sync.start()).toBe("failed");

    expect(machine.local.text).toBe("my rules");
    expect(machine.warnings).toEqual(["could not read storage.sync"]);
  });

  it("leaves the local config alone when the area cannot be written", async () => {
    const machine = aMachine({ text: "my rules", updatedAt: 100 });
    machine.breakWrites();

    expect(await machine.sync.start()).toBe("failed");

    expect(machine.local.text).toBe("my rules");
    expect(machine.warnings).toEqual(["could not write storage.sync"]);
  });

  it("refuses a config too large for the area without writing anything", async () => {
    const machine = aMachine({ text: "x".repeat(CHUNK_CHARS * MAX_PARTS + 1), updatedAt: 100 });

    expect(await machine.sync.start()).toBe("too-large");

    expect(machine.area).toEqual({});
  });

  it("publishes on a later pass once the area works again", async () => {
    const machine = aMachine({ text: "my rules", updatedAt: 100 });
    machine.breakReads();
    expect(await machine.sync.start()).toBe("failed");
    expect(machine.area).toEqual({});

    machine.fixReads();
    expect(await machine.sync.sync()).toBe("pushed");
  });
});

describe("publishing a config that shrank", () => {
  it("removes the parts the longer config left behind", async () => {
    const machine = aMachine({ text: "x".repeat(CHUNK_CHARS * 3), updatedAt: 100 });
    await machine.sync.start();
    await settle(machine);
    expect(Object.keys(machine.area)).toContain(partKey(2));

    machine.local.text = "tiny";
    machine.local.updatedAt = 200;
    expect(await machine.sync.sync()).toBe("pushed");

    expect(Object.keys(machine.area)).not.toContain(partKey(1));
    expect(Object.keys(machine.area)).not.toContain(partKey(2));
    expect(decodeRecord(machine.area)).toMatchObject({ text: "tiny", parts: 1 });
  });
});

// A config too large is DIAGNOSED — the user is told, and the local config keeps routing.
// Anything else out of encodeRecord is a bug in this build, and reporting it as
// "too-large" would send whoever reads the warning to shorten a config that is fine. So it
// propagates. `text` is lied about here on purpose: the types say it cannot happen, which
// is exactly what makes the rethrow untestable any other way.
describe("an encoding failure that is not a size limit", () => {
  it("propagates rather than being reported as a config that is too large", async () => {
    const machine = aMachine({ text: "x", updatedAt: 100 });
    const broken: SyncPorts = {
      ...machine.ports,
      readLocal: () => Promise.resolve({ text: undefined as unknown as string, updatedAt: 100 }),
    };

    await expect(createConfigSync(broken).sync()).rejects.toThrow();
    expect(machine.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// browserSyncPorts(anApplier) — the shell the module's own comment calls "the only part of this
// module that cannot run under a fake". It can, against a fake `browser.storage`; what it
// cannot do is answer the questions above, which is why the two halves are tested apart
// (FOLLOWUPS.md, "The impure shells are where coverage stops").
//
// Everything here is about which bytes land in storage.local, since that area is the
// single source of truth for routing and an adoption is the one write no edit can undo.
// ---------------------------------------------------------------------------

describe("browserSyncPorts", () => {
  let f: FakeBrowser;
  // What background.ts hands in: the wiring's applyStored. Counted, because putting the
  // adopted text into effect is the half of an adoption storage cannot show — it used to be
  // a runtime.reload() and is now an in-process apply.
  let applies: number;
  const anApplier = async () => void (applies += 1);

  beforeEach(() => {
    f = installFakeBrowser();
    applies = 0;
  });
  afterEach(() => {
    uninstallFakeBrowser();
  });

  it("reads the stored config and its stamp, writing nothing", async () => {
    f.local[CONFIG_STORAGE_KEY] = "rules: []";
    f.local[CONFIG_UPDATED_AT_KEY] = 4242;

    expect(await browserSyncPorts(anApplier).readLocal()).toEqual({ text: "rules: []", updatedAt: 4242 });
    expect(f.localSets).toEqual([]);
  });

  // Installed before the stamp existed. The seed is written stamped on first run
  // (background.ts), so an unstamped config means an upgrade, and the two reserved values
  // are what rank it against machines that have real stamps.
  it("backfills an untouched seed as UNEDITED, and persists the backfill", async () => {
    f.local[CONFIG_STORAGE_KEY] = SEED_CONFIG_YAML;

    expect(await browserSyncPorts(anApplier).readLocal()).toEqual({
      text: SEED_CONFIG_YAML,
      updatedAt: UNEDITED,
    });
    // Persisted, or every startup re-derives it — and the derivation stops being right the
    // moment a later build ships a different seed.
    expect(f.local[CONFIG_UPDATED_AT_KEY]).toBe(UNEDITED);
    expect(f.localSets).toEqual([{ [CONFIG_UPDATED_AT_KEY]: UNEDITED }]);
  });

  // The half that matters: a config that differs from the seed was hand-written, and must
  // outrank a fresh install's untouched seed rather than being replaced by it.
  it("backfills a config that differs from the seed as PRE_SYNC_EDIT", async () => {
    f.local[CONFIG_STORAGE_KEY] = "rules: []";

    expect(await browserSyncPorts(anApplier).readLocal()).toEqual({
      text: "rules: []",
      updatedAt: PRE_SYNC_EDIT,
    });
    expect(f.local[CONFIG_UPDATED_AT_KEY]).toBe(PRE_SYNC_EDIT);
  });

  it("reads an absent config as the empty string", async () => {
    expect(await browserSyncPorts(anApplier).readLocal()).toEqual({ text: "", updatedAt: PRE_SYNC_EDIT });
  });

  // One `set`, then the apply: an adoption goes through the same path a Save takes, and
  // there is deliberately no second one.
  it("adopts a remote config, keeping what it overwrote, then applies it", async () => {
    f.local[CONFIG_STORAGE_KEY] = "mine";
    f.local[CONFIG_UPDATED_AT_KEY] = 10;

    await browserSyncPorts(anApplier).adopt("theirs", 20);

    expect(f.localSets).toEqual([
      {
        [CONFIG_STORAGE_KEY]: "theirs",
        [CONFIG_UPDATED_AT_KEY]: 20,
        // Without this the first startup after sync ships silently destroys a hand-written
        // config — the one failure editing cannot undo.
        [CONFIG_REPLACED_KEY]: "mine",
      },
    ]);
    expect(applies).toBe(1);
  });

  it("keeps no backup when there was no config to overwrite", async () => {
    await browserSyncPorts(anApplier).adopt("theirs", 20);

    expect(f.localSets).toEqual([
      { [CONFIG_STORAGE_KEY]: "theirs", [CONFIG_UPDATED_AT_KEY]: 20 },
    ]);
    expect(f.local[CONFIG_REPLACED_KEY]).toBeUndefined();
    expect(applies).toBe(1);
  });

  // reconcile() never adopts text equal to the local text, so this is a second line of
  // defence — but offering the user their own config back as "what sync replaced" is a
  // confusing lie, and the guard is a character comparison.
  it("keeps no backup when the adopted text is what is already stored", async () => {
    f.local[CONFIG_STORAGE_KEY] = "same";

    await browserSyncPorts(anApplier).adopt("same", 20);

    expect(f.local[CONFIG_REPLACED_KEY]).toBeUndefined();
  });

  it("delegates the sync area, and the change signal, to the storage module", async () => {
    const ports = browserSyncPorts(anApplier);
    let fired = 0;
    ports.onSyncChanged(() => {
      fired += 1;
    });

    await ports.writeSync({ "cc.meta": "m" }, []);
    expect(f.sync).toEqual({ "cc.meta": "m" });
    expect(await ports.readSync()).toEqual({ "cc.meta": "m" });

    f.fireChange("local");
    expect(fired).toBe(0);
    f.fireChange("sync");
    expect(fired).toBe(1);
  });

  it("warns with the cause, and with a placeholder when there is none", () => {
    const seen: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void seen.push(args);
    try {
      const ports = browserSyncPorts(anApplier);
      ports.warn("could not read storage.sync", new Error("no account"));
      ports.warn("config too large");
    } finally {
      console.warn = original;
    }

    expect(seen[0]![0]).toBe("[cc] config sync: could not read storage.sync");
    expect((seen[0]![1] as Error).message).toBe("no account");
    expect(seen[1]).toEqual(["[cc] config sync: config too large", ""]);
  });
});
