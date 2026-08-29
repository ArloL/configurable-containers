// Fitness function: the minimum Firefox the manifest DECLARES against the minimum the
// build actually needs.
//
// The failure this closes is silent in the way the manifest permission check's is. An
// older Firefox that lacks an API or ignores a manifest key does not refuse to install —
// it routes wrongly, or does not route, on a profile no gate here has ever touched. Before
// `strict_min_version` existed here, Firefox and AMO offered CC to anything that still
// loads MV2, while `data_collection_permissions` (Firefox 140) sat in the manifest and
// `contentScripts.register` (59) sat in the code, and nothing reconciled the two.
//
// So the floor is a claim, and this is what keeps it true: every `browser.<api>.<method>`
// the source reaches for, and every manifest key the add-on ships, priced against
// @mdn/browser-compat-data and compared with the declared floor. A call that wants a
// version above it fails here rather than in a bug report from the one user on ESR.
//
// It is deliberately NOT a check that the floor is the lowest one possible. A floor above
// what the code needs is a choice — CC declares 140.0, which is where the manifest key
// lands and what CI's `latest-esr` leg measures, and below which nothing has ever been
// run. Offering the add-on where it has never been started is the thing being avoided.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sourceFiles, filesMatching, readRepoFile } from "./sources";

// Read and parsed rather than imported. `import bcd from "@mdn/browser-compat-data" with
// { type: "json" }` makes vite turn a 20MB JSON file into a JS module on every run —
// measured at 30s of import time against 0.2s for this, and `npm test` and the coverage
// gate both load this file.
const bcd = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@mdn/browser-compat-data"), "utf8")
) as { webextensions: { api: CompatNode; manifest: CompatNode } };

interface CompatNode {
  __compat?: { support?: Record<string, unknown> };
  [key: string]: unknown;
}

const manifest = JSON.parse(readRepoFile("extensions/cc/manifest.json")) as Record<string, unknown>;

const declared = (manifest.browser_specific_settings as { gecko: { strict_min_version?: string } })
  .gecko.strict_min_version;

// "0" when the manifest declares nothing, which is not a shrug: every requirement below is
// then above the floor, so the comparisons go red together with the assertion that there is
// a floor at all. Reading an absent floor as "anything clears it" is the state this file
// was written to end.
const floor = declared ?? "0";

/** "140.0" -> [140, 0]. Gecko versions compare part by part, missing parts as 0. */
function parts(version: string): number[] {
  return version.split(".").map((p) => Number.parseInt(p, 10));
}

function atLeast(required: string, available: string): boolean {
  const a = parts(required);
  const b = parts(available);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}

// BCD's `version_added` is a string ("59"), `true` (supported, version unknown), `false`
// (not supported), or `null` (nobody has established it). Several statements mean the
// support was added, removed and re-added; the first is the current one.
function versionAdded(node: CompatNode | undefined, browserName: string): unknown {
  const support = node?.__compat?.support?.[browserName];
  const statement = Array.isArray(support) ? support[0] : support;
  return (statement as { version_added?: unknown } | undefined)?.version_added;
}

// Only a string prices anything, so everything else answers null and is reported as
// unpriced rather than waved through: an unpriced feature is exactly the case this check
// exists to make visible.
function firefoxVersion(node: CompatNode | undefined): string | null {
  const added = versionAdded(node, "firefox");
  // "≤62" is BCD saying "no later than 62"; taking the number is the conservative read.
  return typeof added === "string" ? added.replace(/^≤/, "") : null;
}

function lookup(root: CompatNode, path: string[]): CompatNode | undefined {
  let node: CompatNode | undefined = root;
  for (const key of path) {
    node = node?.[key] as CompatNode | undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * The deepest prefix of `path` that BCD prices, with the version it wants. `undefined` when
 * not even the first segment is known.
 *
 * Deepest, because the segments carry different questions: `storage.local.get` is priced as
 * a whole while `tabs.onCreated.addListener` is priced at `tabs.onCreated` (BCD models the
 * event, not the three methods every event carries).
 */
function priceOf(root: CompatNode, path: string[]): { feature: string; version: string } | undefined {
  for (let depth = path.length; depth > 0; depth--) {
    const prefix = path.slice(0, depth);
    const version = firefoxVersion(lookup(root, prefix));
    if (version !== null) return { feature: prefix.join("."), version };
  }
  return undefined;
}

const api = bcd.webextensions;

function supportsAndroid(feature: string): boolean {
  return versionAdded(lookup(api.api, feature.split(".")), "firefox_android") !== false;
}

// ---------------------------------------------------------------------------------------
// What the source calls.

// Comments stripped first, for the reason sources.ts gives: this repo names the very APIs
// it is careful not to call.
const CALL = /\bbrowser\.([a-zA-Z]+)\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?/g;

const callSites = [
  ...new Set(
    filesMatching(sourceFiles("src"), CALL)
      .flatMap((f) => f.lines)
      .flatMap((line) => [...line.matchAll(CALL)].map((m) => m.slice(1, 4).filter((s) => s != null).join(".")))
  ),
].sort();

const calls = callSites.map((site) => ({ site, price: priceOf(api.api, site.split(".")) }));

// ---------------------------------------------------------------------------------------
// What the manifest ships.
//
// Walked rather than listed, so a key added to the manifest is priced without anybody
// remembering to come here. The walk descends only into keys BCD knows and stops at the
// rest, which are inventoried below with the reason each is unpriceable — a key BCD has
// simply not got to yet would otherwise be indistinguishable from one it prices at 45.

const unpriceable: Record<string, string> = {
  "browser_specific_settings.gecko.id": "the add-on's own id. BCD prices the `gecko` key, not its identity.",
  "browser_specific_settings.gecko.strict_min_version":
    "the floor itself, and it is the thing being compared: pricing it would be circular.",
  "browser_specific_settings.gecko.data_collection_permissions.required":
    "the list of data categories the add-on collects. BCD prices the key; the categories are a value, and CC's is the single entry `none`.",
  "commands.reopen-picker": "the command's own name. BCD prices `commands` and its shape, not the names an extension picks.",
  "permissions.<all_urls>":
    "a host permission rather than an API permission. BCD prices the named permissions under `manifest.permissions`; a match pattern is a value, and it has been legal for as long as MV2 has.",
};

function walkManifest(value: unknown, path: string[], out: { key: string; price?: { feature: string; version: string } }[]): void {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = [...path, key];
    const price = priceOf(api.manifest, here);
    if (price === undefined || price.feature !== here.join(".")) {
      out.push({ key: here.join(".") }); // BCD does not know this key; do not descend into it
      continue;
    }
    out.push({ key: here.join("."), price });
    // Permission names are values that BCD prices individually; every other array holds
    // file names and match patterns, which are the extension's own strings.
    if (Array.isArray(child)) {
      if (here.join(".") === "permissions") {
        for (const name of child as string[]) {
          const p = priceOf(api.manifest, [...here, name]);
          out.push(p?.feature === [...here, name].join(".") ? { key: `permissions.${name}`, price: p } : { key: `permissions.${name}` });
        }
      }
      continue;
    }
    if (child !== null && typeof child === "object") walkManifest(child, here, out);
  }
}

const manifestKeys: { key: string; price?: { feature: string; version: string } }[] = [];
walkManifest(manifest, [], manifestKeys);

// ---------------------------------------------------------------------------------------

function above(entries: { name: string; version: string }[]): string[] {
  return entries.filter((e) => !atLeast(e.version, floor)).map((e) => `${e.name} wants ${e.version}`);
}

// The calls Firefox for Android does not have at ANY version. Derived rather than listed:
// the day Android grows containers, this stops being true by itself.
const desktopOnly = calls
  .filter((c) => c.price !== undefined && !supportsAndroid(c.price.feature))
  .map((c) => c.site);

const pricedCalls = calls.flatMap((c) => (c.price ? [{ name: c.site, version: c.price.version }] : []));
const pricedKeys = manifestKeys.flatMap((k) => (k.price ? [{ name: k.key, version: k.price.version }] : []));

function highest(entries: { name: string; version: string }[]): { name: string; version: string } | undefined {
  return [...entries].sort((a, b) => (atLeast(a.version, b.version) ? 1 : -1))[0];
}

describe("fitness — the declared Firefox floor covers what the build needs", () => {
  it("declares the floor this build was measured at", () => {
    // Absent, Firefox and AMO offer the add-on to anything that still loads MV2, and every
    // comparison below silently has nothing to compare against. The literal is deliberate:
    // moving the floor is a decision about which profiles get offered the add-on, and it
    // should appear in a diff next to the reason rather than as a number that drifted.
    expect(declared).toBe("140.0");
  });

  it("builds for the floor it declares", () => {
    // `harness/build-extension.ts` is the third place a minimum Firefox is implied, and its
    // claim is narrower than the other two: esbuild's `target` decides which SYNTAX may be
    // emitted and says nothing about the APIs the code calls. Narrower is not harmless — a
    // target BELOW the floor is a bundle downlevelled for browsers the add-on refuses to
    // install on, and one ABOVE it is syntax the oldest supported profile may not parse,
    // which is a background script that never evaluates. Pinned to the same major.
    const build = sourceFiles("harness").find((f) => f.path === "harness/build-extension.ts");
    const target = /target:\s*"(firefox\d+)"/.exec(build?.code ?? "");
    expect(target?.[1]).toBe(`firefox${parts(floor)[0]}`);
  });

  it("clears every browser.* call the source makes", () => {
    expect(above(pricedCalls)).toEqual([]);
  });

  it("clears every manifest key the add-on ships", () => {
    expect(above(pricedKeys)).toEqual([]);
  });

  it("prices every call site, rather than passing the ones it cannot read", () => {
    // An api BCD does not know is not a call that is fine; it is a call nothing checked.
    // Failing here is what makes the two assertions above mean "all of them".
    expect(calls.filter((c) => c.price === undefined).map((c) => c.site)).toEqual([]);
  });

  it("prices every manifest key, or says here why the key cannot be priced", () => {
    const unpriced = manifestKeys.filter((k) => k.price === undefined).map((k) => k.key);
    expect(unpriced.sort()).toEqual(Object.keys(unpriceable).sort());
  });

  it("holds no exception that has outlived the key it excuses", () => {
    // The same rule the permission check's exception list has: a stale entry would later
    // wave a new key through.
    const present = new Set(manifestKeys.map((k) => k.key));
    expect(Object.keys(unpriceable).filter((k) => !present.has(k))).toEqual([]);
  });

  it("declares no Android floor, because the add-on cannot work there", () => {
    // `npm run lint:ext` warns about exactly this: `data_collection_permissions` reached
    // Firefox for Android in 142, and a floor of 140 with no `gecko_android` reads there as
    // 140. The fix the warning implies — a `gecko_android` floor at 142 — would be a claim
    // that CC works on Android, and it does not. Containers do not exist there, so the calls
    // below are unsupported at every Android version and NOTHING routes: the loudest form of
    // the silent failure this file is about, bought to quiet a linter.
    expect(desktopOnly).toEqual([
      "commands.onCommand.addListener",
      "contextualIdentities.create",
      "contextualIdentities.get",
      "contextualIdentities.query",
      "contextualIdentities.remove",
    ]);
    expect((manifest.browser_specific_settings as Record<string, unknown>).gecko_android).toBeUndefined();
  });

  it("names what the floor actually rests on", () => {
    // The inventory rather than a bound, so that raising the ceiling is something somebody
    // writes down. Today the two halves are far apart: the code would run on a Firefox from
    // 2018, and the manifest key is what makes 140 the honest answer.
    //
    // Both numbers are BCD's answer rather than this repo's, and Renovate bumps BCD, so a
    // correction upstream lands here as a red case. That is the check working: the version
    // a feature arrived in is exactly the fact being deferred to.
    expect(highest(pricedCalls)).toEqual({ name: "contentScripts.register", version: "59" });
    expect(highest(pricedKeys)).toEqual({
      name: "browser_specific_settings.gecko.data_collection_permissions",
      version: "140",
    });
  });
});
