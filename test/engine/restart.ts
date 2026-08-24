import { wireBackground, type Background } from "../../src/extension/wiring";
import type { BrowserPort, Clock } from "../../src/engine/port";
import type { Config } from "../../src/resolver/types";
import type { MockPort } from "./mock-port";

export const GRACE_MS = 300_000;
export const REDIRECTOR_DELAY_MS = 5_000;

export interface BackgroundSession extends Background {
  // Retires this session's timers. Called for you by restartTheBackground.
  ends(): void;
}

// A clock the session stops delivering from once it ends. The fake clock outlives
// the session, so without this the previous disposer's re-arming 10-minute GC tick
// keeps sweeping through a closure that still holds a live port — and the harness
// would report state "surviving" a restart that never actually happened. Real
// Firefox drops a dead background context's timers with the context.
function aSessionClock(clock: Clock): { clock: Clock; stop: () => void } {
  let live = true;
  return {
    clock: {
      setTimeout(fn, ms) {
        clock.setTimeout(() => {
          if (live) fn();
        }, ms);
      },
      // Time itself is not per-session: it keeps running while the background is dead,
      // which is exactly the interval a restored deadline has to account for.
      now: () => clock.now(),
    },
    stop: () => void (live = false),
  };
}

// A port whose LISTENERS stop being called once the session ends — the counterpart of
// the clock facade above, and for the same reason. `browser.*.addListener` is additive
// in Firefox and `mock-port` models that faithfully, so nothing about registering a
// second background retires the first one's handlers: without this, the previous
// session's auto-temp, disposer and engine all keep running against a live port, and the
// harness reports state "surviving" a restart that never happened. Firefox retires them
// by destroying the context they live in; here they are gated instead, which is
// indistinguishable from the outside and needs no removal API on the mock.
//
// This is the job `mock-port`'s one-slot-per-event used to do as a side effect of being
// wrong about Firefox. Splitting it out is what let the mock become additive — and what
// made two double-registered events (onTabRemoved, onTabUpdated) visible at L3 at all.
function aSessionPort(port: BrowserPort): { port: BrowserPort; stop: () => void } {
  let live = true;

  // Every event the port exposes, gated. Listed one by one rather than proxied: a new
  // event on `BrowserPort` should fail to compile here (it will not be in the spread's
  // shape) rather than silently join the set of things a dead session still hears.
  const sessionPort: BrowserPort = {
    ...port,
    onBeforeRequest(handler) {
      port.onBeforeRequest(async (d) => (live ? handler(d) : undefined));
    },
    onBeforeNavigate(handler) {
      port.onBeforeNavigate((d) => {
        if (live) handler(d);
      });
    },
    onBeforeSendHeaders(handler) {
      port.onBeforeSendHeaders(async (d) => (live ? handler(d) : undefined));
    },
    onTabCreated(handler) {
      port.onTabCreated((tab) => {
        if (live) handler(tab);
      });
    },
    onTabRemoved(handler) {
      port.onTabRemoved((tabId) => {
        if (live) handler(tabId);
      });
    },
    onTabUpdated(handler) {
      port.onTabUpdated((tab, info) => {
        if (live) handler(tab, info);
      });
    },
    onMessage(handler) {
      // Undefined, not a Promise of undefined: a dead session must leave the reply
      // channel free for the live one, which is the same reason wiring's dispatcher
      // answers a message it does not own synchronously.
      port.onMessage((msg, sender) => (live ? handler(msg, sender) : undefined));
    },
    onCommand(handler) {
      port.onCommand((name) => {
        if (live) handler(name);
      });
    },
    onActionClicked(handler) {
      port.onActionClicked((tab) => {
        if (live) handler(tab);
      });
    },
  };

  return { port: sessionPort, stop: () => void (live = false) };
}

// Starts a background against `browser`, running the async tail in the order
// background.ts runs it, and awaits it — so a caller observes a settled startup.
export async function startTheBackground(
  browser: MockPort,
  clock: Clock,
  config: Config,
): Promise<BackgroundSession> {
  const session = aSessionClock(clock);
  const listeners = aSessionPort(browser.port);
  const background = wireBackground({
    port: listeners.port,
    clock: session.clock,
    graceMs: GRACE_MS,
    redirectorDelayMs: REDIRECTOR_DELAY_MS,
  });

  background.useConfig(config);
  // The gate's own condition: config published and pause state hydrated. Awaited here so
  // a caller observes a background that has actually finished starting — without it a
  // case could read half-hydrated pause state and pass for the wrong reason.
  await background.ready;
  await background.resumeTmpSuffix();
  await background.injectScripts();

  return {
    ...background,
    ends: () => {
      session.stop();
      listeners.stop();
    },
  };
}

// The same browser, none of the same memory. Every Map, Set and counter the
// previous background held is gone; whatever the new one knows, it reconstructed
// from browser.* queries.
//
// `previous.ends()` is what retires the old session, and it has two halves because the
// browser outlives the background twice over: `aSessionPort` stops its listeners being
// called (mock-port is additive, like Firefox — re-wiring adds handlers, it does not
// replace them) and `aSessionClock` stops its timers firing (the fake clock is shared
// and knows nothing about sessions). Both model one fact: Firefox destroys the context
// a dead background's callbacks live in.
//
// Not modelled: async work already in flight at the restart (a floated containerize
// mid-await). Firefox would kill it; here it would land. Drive the restart from a
// settled state, as every case in restart.test.ts does.
export async function restartTheBackground(
  previous: BackgroundSession,
  browser: MockPort,
  clock: Clock,
  config: Config,
): Promise<BackgroundSession> {
  previous.ends();
  return startTheBackground(browser, clock, config);
}
