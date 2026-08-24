// Fitness function: one browser event, one registration.
//
// `runtime.onMessage` is the one event where a second registration is a bug in FIREFOX,
// not merely an inconvenience in a test double: an async handler returns a Promise for
// every message it sees and claims the reply channel from the sibling the message was
// addressed to. `wireBackground` owns the single registration and dispatches by `type`,
// and this inventory is what keeps it single.
//
// The rest of the events are additive in Firefox and, since 2026-08-24, in
// `test/engine/mock-port.ts` too. They are still inventoried, for a weaker but real
// reason: two siblings on one event is a fact about the composed background that ought to
// be deliberate, and every case here that used to be a blind spot was found by reading
// this list rather than by anything going red.
//
// Hence an exact inventory rather than a bound. Adding a registration means editing this
// list, and the list is where the question gets asked.
import { describe, it, expect } from "vitest";
import { sourceFiles, filesMatching } from "./sources";

// Every event-registration method on `BrowserPort`. Kept here in full — including the
// ones with a single caller — because the check is about the ones that GROW.
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

// One entry per call site, named by FILE only. Line numbers were the obvious thing to
// pin and the wrong one: every edit above a registration would fail this check without
// anything having moved, and a fitness function that cries wolf is one that gets deleted.
// A file registering the same event twice still shows up twice, which is what matters.
function registrationSites(event: string): string[] {
  return filesMatching(callers, new RegExp(`\\.${event}\\(`)).flatMap((f) => f.lines.map(() => f.path));
}

describe("fitness — one browser event, one registration", () => {
  it("registers every event exactly where this list says, and nowhere else", () => {
    const inventory = Object.fromEntries(events.map((e) => [e, registrationSites(e)]));

    expect(inventory).toEqual({
      // TWO sites, ONE listener: wiring's `gatedPort` wraps the event and the engine
      // registers on the wrapper, so exactly one handler reaches the real port. The
      // wrapper is what delays the session's first navigation until the config has
      // loaded and the pause state has hydrated — a chain, not a fan-out.
      onBeforeRequest: ["src/engine/engine.ts", "src/extension/wiring.ts"],

      onBeforeNavigate: ["src/engine/engine.ts"],
      onTabCreated: ["src/engine/auto-temp.ts"],

      // TWO sites, TWO listeners — a deliberate fan-out. Both run, in Firefox and at L3:
      // the mock keeps a list per event, and `test/engine/wiring.test.ts` pins pause's
      // disarm-on-empty happening with the disposer registered on the same event. While
      // the mock held one slot the disposer (constructed second) displaced pause here,
      // and that case could not be written at all.
      onTabRemoved: ["src/engine/disposer.ts", "src/engine/pause.ts"],

      // The same shape: `createRedirectorCloser` registers after `createAutoTemp`, and
      // both are called. Auto-temp listens on BOTH tab events precisely because Firefox
      // bug 1586612 makes `onCreated` fire with "about:blank" before the real url, and an
      // onCreated-only draft passed L3 and failed in real Firefox (CLAUDE.md) — so the
      // single slot had quietly put L3 back in exactly that position. `wiring.test.ts`
      // now pins the update-driven path with the closer registered alongside.
      onTabUpdated: ["src/engine/auto-temp.ts", "src/engine/redirector-closer.ts"],

      onBeforeSendHeaders: ["src/engine/cookie-seeder.ts"],

      // The one the codebase already treats as sacred, and the only event where a second
      // registration is a bug in FIREFOX too, not just in the mock: an async handler
      // returns a Promise for every message it sees and claims the reply channel from
      // the sibling the message was addressed to. `wireBackground` owns it and dispatches
      // by `type`; siblings expose `handleMessage`.
      onMessage: ["src/extension/wiring.ts"],

      onCommand: ["src/engine/picker.ts"],
      onActionClicked: ["src/engine/pause.ts"],
    });
  });

  it("keeps runtime.onMessage a single addListener in the port implementation too", () => {
    // The seam above is only as good as what is underneath it: a sibling that reached
    // past the port straight to `browser.runtime.onMessage.addListener` would rebuild
    // exactly the reply-channel bug the dispatcher exists to prevent, and no inventory
    // of `port.onMessage` calls would show it.
    const sites = filesMatching(sourceFiles("src"), /\bbrowser\.runtime\.onMessage\.addListener\b/);
    expect(sites.map((s) => s.path)).toEqual(["src/engine/browser-port.ts"]);
  });
});
