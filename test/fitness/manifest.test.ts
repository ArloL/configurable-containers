// Fitness function: the manifest's permissions and the APIs the code actually calls.
//
// Both directions fail silently, in opposite ways.
//
// A MISSING permission is the failure mode CLAUDE.md opens its Firefox section with:
// without `cookies`, `tabs.create({cookieStoreId})` throws and nothing routes; without
// `contextualIdentities`, MAC's gate rejects the F7 handshake; without `notifications`,
// the F9 declination toast is lost with no error anyone sees; without `webNavigation`,
// `onBeforeNavigate` never fires and every "View Page Source" is routed as a navigation
// (F13). Some of those the e2e suite would eventually catch, in minutes, as a wrong
// container three layers from the cause; the toast one it would not catch at all
// (`browser-port.test.ts` covers the ordering, not the permission).
//
// An UNUSED permission is quieter still and never fails a test: it is a bigger install
// prompt for the user and more surface for an AMO reviewer, for an API the extension
// stopped calling two refactors ago. Nothing in this repo would ever mention it again.
import { describe, it, expect } from "vitest";
import { sourceFiles, filesMatching, readRepoFile } from "./sources";

// `browser.<api>.…` -> the manifest permission that API needs. Only the APIs whose
// permission is a plain name are listed: this is a lookup table, not a model of the
// WebExtension permission system, and an entry that guessed would be worse than absent.
const permissionFor: Record<string, string> = {
  cookies: "cookies",
  contextualIdentities: "contextualIdentities",
  notifications: "notifications",
  webNavigation: "webNavigation",
  webRequest: "webRequest",
  tabs: "tabs",
  storage: "storage",
};

// Permissions no `browser.<name>.` call can ever account for, each with the reason it is
// in the manifest. This list is the exception mechanism, and it is compared exactly.
const notCalledByName: Record<string, string> = {
  webRequestBlocking:
    "the opt-in that makes onBeforeRequest able to return { cancel: true }; it is a flag on " +
    "webRequest, not an API namespace of its own. Without it the engine can observe a " +
    "navigation and not stop one, so every reopen would leave the original load running.",
  "<all_urls>":
    "host permission. Routing is a decision about any site the config might name, and " +
    "contentScripts.register (the scripts overlay) can only register for hosts we hold.",
};

const manifest = JSON.parse(readRepoFile("extensions/cc/manifest.json")) as { permissions: string[] };

// What the shipped background actually calls. `browser-port.ts` is the only file that may
// (test/fitness/seams.test.ts pins that), so it is also the only file that can create a
// permission requirement — plus the extension's own plumbing, which calls storage directly.
const calledApis = new Set(
  filesMatching(sourceFiles("src"), /\bbrowser\.([a-zA-Z]+)\./g)
    .flatMap((f) => f.lines)
    .flatMap((line) => [...line.matchAll(/\bbrowser\.([a-zA-Z]+)\./g)].map((m) => m[1]))
);

describe("fitness — manifest permissions match what the code calls", () => {
  it("declares a permission for every API the source reaches for", () => {
    const missing = [...calledApis]
      .map((api) => permissionFor[api])
      .filter((p): p is string => p != null && !manifest.permissions.includes(p));

    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it("calls every permission it declares, or says here why it cannot be called by name", () => {
    const accountedFor = new Set(
      [...calledApis].map((api) => permissionFor[api]).filter((p): p is string => p != null)
    );

    const unexplained = manifest.permissions.filter(
      (p) => !accountedFor.has(p) && !(p in notCalledByName)
    );

    expect(unexplained).toEqual([]);
  });

  it("keeps the four permissions whose loss is silent, whatever else changes", () => {
    // Named individually and not derived from the code, because the derivation above
    // fails open in the one case that matters: delete the `browser.notifications.create`
    // call by accident and "the code no longer needs it" becomes true rather than red.
    // These four are the ones CLAUDE.md records as failing with no error at all.
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["cookies", "contextualIdentities", "notifications", "webNavigation"])
    );
  });

  it("holds no permission that has quietly stopped being explained", () => {
    // The exception list is the place a permission goes to be justified, so it must not
    // outlive the permission itself: an entry here for something the manifest no longer
    // asks for is a stale reason that would later wave a new one through.
    expect(Object.keys(notCalledByName).filter((p) => !manifest.permissions.includes(p))).toEqual([]);
  });
});
