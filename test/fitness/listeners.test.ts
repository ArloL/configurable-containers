// Fitness function: one browser event, one registration.
//
// `runtime.onMessage` is the event where a second registration is a bug in FIREFOX, not just
// an inconvenience in a test double: an async handler returns a Promise for every message it
// sees and claims the reply channel from the sibling that was addressed. `wireBackground`
// owns the single registration and dispatches by `type`; this inventory keeps it single.
//
// The other events are additive in Firefox and, since 2026-08-24, in `test/engine/mock-port.ts`
// too. They are inventoried for a weaker but real reason: two siblings on one event should be
// deliberate, and every blind spot found here was found by reading this list, not by anything
// going red. Hence an exact inventory rather than a bound — adding a registration means
// editing the list, and the list is where the question gets asked.
import { describe, it, expect } from "vitest";
import { sourceFiles, filesMatching } from "./sources";

// Every event-registration method on `BrowserPort`, single-caller ones included: the check
// is about the ones that GROW.
const events = [
  "onBeforeRequest",
  "onBeforeNavigate",
  "onTabCreated",
  "onTabRemoved",
  "onTabUpdated",
  "onBeforeSendHeaders",
  "onMessage",
  "onCommand",
  "onActionClicked",
] as const;

// `port.ts` declares them and `browser-port.ts` implements them; neither is a caller.
const callers = sourceFiles("src").filter((f) => !/\/(port|browser-port)\.ts$/.test(f.path));

// One entry per call site, named by FILE only. Line numbers were the obvious thing to pin
// and the wrong one: every edit above a registration would fail this without anything having
// moved, and a check that cries wolf gets deleted. A file registering the same event twice
// still shows up twice, which is what matters.
function registrationSites(event: string): string[] {
  return filesMatching(callers, new RegExp(`\\.${event}\\(`)).flatMap((f) => f.lines.map(() => f.path));
}

describe("fitness — one browser event, one registration", () => {
  it("registers every event exactly where this list says, and nowhere else", () => {
    const inventory = Object.fromEntries(events.map((e) => [e, registrationSites(e)]));

    expect(inventory).toEqual({
      // TWO sites, ONE listener: `gatedPort` wraps the event and the engine registers on
      // the wrapper, so one handler reaches the real port. The wrapper delays the session's
      // first navigation until the config has loaded and pause has hydrated — a chain, not
      // a fan-out.
      onBeforeRequest: ["src/engine/engine.ts", "src/extension/wiring.ts"],

      onBeforeNavigate: ["src/engine/engine.ts"],
      onTabCreated: ["src/engine/auto-temp.ts"],

      // TWO sites, TWO listeners — a deliberate fan-out. Both run, in Firefox and at L3:
      // the mock keeps a list per event, and `test/engine/wiring.test.ts` pins pause's
      // disarm-on-empty with the disposer on the same event. While the mock held one slot
      // the disposer displaced pause here and that case could not be written at all.
      onTabRemoved: ["src/engine/disposer.ts", "src/engine/pause.ts"],

      // The same shape: `createRedirectorCloser` registers after `createAutoTemp` and both
      // are called. Auto-temp listens on BOTH tab events because Firefox bug 1586612 fires
      // `onCreated` with "about:blank" before the real url; an onCreated-only draft passed
      // L3 and failed in real Firefox, and the mock's single slot had quietly put L3 back in
      // that position. `wiring.test.ts` now pins the update path with the closer alongside.
      onTabUpdated: ["src/engine/auto-temp.ts", "src/engine/redirector-closer.ts"],

      onBeforeSendHeaders: ["src/engine/cookie-seeder.ts"],

      // The only event where a second registration is a bug in FIREFOX and not just in the
      // mock: an async handler returns a Promise for every message it sees and claims the
      // reply channel from the sibling that was addressed. `wireBackground` owns it and
      // dispatches by `type`; siblings expose `handleMessage`.
      onMessage: ["src/extension/wiring.ts"],

      onCommand: ["src/engine/picker.ts"],
      onActionClicked: ["src/engine/pause.ts"],
    });
  });

  it("keeps runtime.onMessage a single addListener in the port implementation too", () => {
    // The seam is only as good as what is under it: a sibling reaching past the port to
    // `browser.runtime.onMessage.addListener` would rebuild the reply-channel bug the
    // dispatcher prevents, and no inventory of `port.onMessage` calls would show it.
    const sites = filesMatching(sourceFiles("src"), /\bbrowser\.runtime\.onMessage\.addListener\b/);
    expect(sites.map((s) => s.path)).toEqual(["src/engine/browser-port.ts"]);
  });
});
