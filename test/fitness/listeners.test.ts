// Fitness function: one browser event, one registration.
//
// `test/engine/mock-port.ts` holds a SINGLE handler slot per event — `onTabRemoved(h) {
// onTabRemovedH = h }`, an assignment, not a push. That is deliberate and load-bearing
// twice over: it is how `test/engine/restart.ts` retires a dead session's listeners (a
// second `wireBackground` against the same fake browser replaces them, the way Firefox
// drops a background context's listeners with the context), and it is the reason
// CLAUDE.md's `viewSourceNav` note gives for that map having no `onTabRemoved` cleanup.
//
// The cost is that a SECOND registration of the same event anywhere in `src/` is
// invisible: the later one silently displaces the earlier, nothing goes red, and the
// displaced behaviour is simply not wired for every L3 case that drives the composed
// background. Real Firefox is additive and runs both, so this is a hole in what L3 can
// SEE rather than a shipped bug — which is exactly the kind that survives, because no
// symptom points at it.
//
// Hence an exact inventory rather than a bound. Adding a registration means editing this
// list, and the list is where the question "what does the mock do with two of these?"
// gets asked.
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

      // TWO sites, TWO listeners — a genuine fan-out, and the one the single-slot mock
      // cannot represent. The disposer registers after `createPause` in `wireBackground`,
      // so under `test/engine/mock-port.ts` the disposer's sweep wins and pause's
      // disarm-on-empty is never wired. Both run in Firefox (`tabs.onRemoved` is
      // additive), and pause's own unit tests build a `createPause` on a port of their
      // own, so the behaviour is covered — what is NOT covered, and cannot be while this
      // reads two, is disarm-on-empty in the composed background. See FOLLOWUPS.md.
      onTabRemoved: ["src/engine/disposer.ts", "src/engine/pause.ts"],

      // The same fan-out, the same blind spot: `createRedirectorCloser` registers after
      // `createAutoTemp`, so at L3 the closer's handler is the one that survives and
      // auto-temp is driven by `onTabCreated` alone. That matters more than it looks —
      // auto-temp listens on BOTH events precisely because Firefox bug 1586612 makes
      // `onCreated` fire with "about:blank" before the real url, and an onCreated-only
      // draft passed L3 and failed in real Firefox (CLAUDE.md). L3 is back to being
      // unable to tell the difference.
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
