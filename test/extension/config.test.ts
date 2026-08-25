import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";
import {
  CONFIG_REPLACED_KEY,
  CONFIG_STORAGE_KEY,
  CONFIG_UPDATED_AT_KEY,
  SEED_CONFIG_YAML,
  clearReplacedConfigYaml,
  onSyncStorageChanged,
  openConfigEditor,
  readReplacedConfigYaml,
  readStoredConfigYaml,
  readStoredUpdatedAt,
  readSyncItems,
  writeStoredConfigYaml,
  writeSyncItems,
} from "../../src/extension/config";
import { installFakeBrowser, uninstallFakeBrowser, type FakeBrowser } from "./fake-storage";

describe("seed extension config", () => {
  it("parses and routes work.example to the Work container", () => {
    const config = parseConfig(SEED_CONFIG_YAML);
    const rule = matchRule("https://work.example/", config.rules);
    expect(rule).not.toBeNull();
    expect(rule!.action).toEqual({ kind: "open", containers: ["Work"] });
  });

  it("does not match an unrelated host", () => {
    const config = parseConfig(SEED_CONFIG_YAML);
    expect(matchRule("https://nomatch.example/", config.rules)).toBeNull();
  });

  it("carries the seed cookie overlay on the work.example rule", () => {
    const config = parseConfig(SEED_CONFIG_YAML);
    const rule = matchRule("https://work.example/", config.rules);
    expect(rule!.cookies).toEqual([{ name: "seed", url: "http://work.example/", value: "1" }]);
  });

  it("carries the document_start script overlay on the work.example rule", () => {
    const config = parseConfig(SEED_CONFIG_YAML);
    const rule = matchRule("https://work.example/", config.rules);
    expect(rule!.scripts).toEqual([
      { at: "document_start", run: "localStorage.setItem('cc_script', '1');" },
    ]);
  });

  it("carries a redirector rule on redirect.example", () => {
    const config = parseConfig(SEED_CONFIG_YAML);
    const rule = matchRule("https://redirect.example/", config.rules);
    expect(rule!.action).toEqual({ kind: "redirector" });
  });
});

// ---------------------------------------------------------------------------
// The storage shell. Everything above is the seed TEXT; everything below is the
// `browser.storage` plumbing around it, which no deterministic level reached until now —
// 0% branch coverage, so not one of the type guards below had ever been executed
// (FOLLOWUPS.md, "The impure shells are where coverage stops").
//
// These are adapter tests: they pin which storage call is made, with what payload, and
// what an unexpected stored value is turned into. The decisions these values feed are
// tested elsewhere and under mutation — `loadConfig` in test/config/load.test.ts, the
// reconciliation in test/config/sync-record.test.ts.
// ---------------------------------------------------------------------------

describe("config storage", () => {
  let f: FakeBrowser;

  beforeEach(() => {
    f = installFakeBrowser();
  });
  afterEach(() => {
    uninstallFakeBrowser();
  });

  // The distinction loadConfig routes on: absent means "first run, use the seed", ""
  // means "a config that matches nothing", and confusing them re-seeds a config the user
  // deliberately emptied.
  it("reads an absent config as undefined and an empty one as the empty string", async () => {
    expect(await readStoredConfigYaml()).toBeUndefined();
    f.local[CONFIG_STORAGE_KEY] = "";
    expect(await readStoredConfigYaml()).toBe("");
  });

  it("reads a stored config back", async () => {
    f.local[CONFIG_STORAGE_KEY] = "rules: []";
    expect(await readStoredConfigYaml()).toBe("rules: []");
  });

  // storage.local is untyped at runtime: a value of the wrong type is another extension's
  // key collision or a half-written record, and reading it as a config would hand
  // parseConfig something it cannot describe. Absent is the honest answer.
  it("reads a non-string stored config as absent", async () => {
    f.local[CONFIG_STORAGE_KEY] = 42;
    expect(await readStoredConfigYaml()).toBeUndefined();
  });

  it("reads a stored stamp back, and a non-number stamp as absent", async () => {
    expect(await readStoredUpdatedAt()).toBeUndefined();
    f.local[CONFIG_UPDATED_AT_KEY] = 1234;
    expect(await readStoredUpdatedAt()).toBe(1234);
    f.local[CONFIG_UPDATED_AT_KEY] = "1234";
    expect(await readStoredUpdatedAt()).toBeUndefined();
  });

  // The invariant the function exists for: two `set` calls leave a window in which the
  // stamp describes the wrong text, and that window is what decides a sync conflict.
  it("writes the config and its stamp in ONE set call", async () => {
    await writeStoredConfigYaml("rules: []", 7);
    expect(f.localSets).toEqual([{ [CONFIG_STORAGE_KEY]: "rules: []", [CONFIG_UPDATED_AT_KEY]: 7 }]);
    expect(f.calls).toEqual(["local.set"]);
  });

  it("stamps a write with the current time when no stamp is given", async () => {
    const before = Date.now();
    await writeStoredConfigYaml("rules: []");
    const after = Date.now();
    const stamp = f.local[CONFIG_UPDATED_AT_KEY] as number;
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it("reads the replaced-config backup back, and a non-string one as absent", async () => {
    expect(await readReplacedConfigYaml()).toBeUndefined();
    f.local[CONFIG_REPLACED_KEY] = "old";
    expect(await readReplacedConfigYaml()).toBe("old");
    f.local[CONFIG_REPLACED_KEY] = { not: "a string" };
    expect(await readReplacedConfigYaml()).toBeUndefined();
  });

  it("clears the replaced-config backup", async () => {
    f.local[CONFIG_REPLACED_KEY] = "old";
    await clearReplacedConfigYaml();
    expect(f.localRemoves).toEqual([[CONFIG_REPLACED_KEY]]);
    expect(await readReplacedConfigYaml()).toBeUndefined();
  });

  it("reads the whole sync area, since the record spans keys the caller cannot name", async () => {
    Object.assign(f.sync, { "cc.meta": "m", "cc.0": "a" });
    expect(await readSyncItems()).toEqual({ "cc.meta": "m", "cc.0": "a" });
  });

  // Set FIRST, then remove. After the set the record is complete — the meta names which
  // parts to read, so a leftover higher-numbered part is ignored — while removing first
  // tears the record if the set then fails.
  it("writes sync items before removing the stale ones", async () => {
    f.sync["cc.2"] = "stale";
    await writeSyncItems({ "cc.meta": "m", "cc.0": "a" }, ["cc.2"]);
    expect(f.calls).toEqual(["sync.set", "sync.remove"]);
    expect(f.syncSets).toEqual([{ "cc.meta": "m", "cc.0": "a" }]);
    expect(f.syncRemoves).toEqual([["cc.2"]]);
    expect(f.sync).toEqual({ "cc.meta": "m", "cc.0": "a" });
  });

  // `storage.sync.remove([])` is a round trip to the sync backend for nothing, on the
  // common path — every push where the record did not shrink.
  it("skips the remove call when nothing is stale", async () => {
    await writeSyncItems({ "cc.meta": "m" }, []);
    expect(f.calls).toEqual(["sync.set"]);
    expect(f.syncRemoves).toEqual([]);
  });

  // The handler drives a full reconciliation, and storage.local is written on every
  // config save and every adoption. Firing on those would reconcile against an area
  // nothing changed, and an adoption's own local write would re-enter the path that
  // performed it.
  it("notifies on a sync change and ignores every other area", () => {
    let fired = 0;
    onSyncStorageChanged(() => {
      fired += 1;
    });
    f.fireChange("local");
    f.fireChange("managed");
    expect(fired).toBe(0);
    f.fireChange("sync");
    expect(fired).toBe(1);
  });

  it("opens the config editor through the options page", async () => {
    await openConfigEditor();
    expect(f.optionsPagesOpened).toBe(1);
  });
});
