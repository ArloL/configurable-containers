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

// A clock the session stops delivering from once it ends. The fake clock outlives the
// session, so without this the previous disposer's re-arming GC tick keeps sweeping through a
// closure holding a live port, and the harness reports state "surviving" a restart that never
// happened. Firefox drops a dead context's timers with the context.
function aSessionClock(clock: Clock): { clock: Clock; stop: () => void } {
  let live = true;
  return {
    clock: {
      setTimeout(fn, ms) {
        clock.setTimeout(() => {
          if (live) fn();
        }, ms);
      },
      // Time is not per-session: it runs on while the background is dead, which is the
      // interval a restored deadline has to account for.
      now: () => clock.now(),
    },
    stop: () => void (live = false),
  };
}

// A port whose LISTENERS stop being called once the session ends — the counterpart of the
// clock facade, for the same reason. `browser.*.addListener` is additive in Firefox and
// `mock-port` models that, so wiring a second background does not retire the first one's
// handlers: without this the old session's auto-temp, disposer and engine keep running
// against a live port and the harness reports state "surviving" a restart that never
// happened. Firefox retires them by destroying their context; here they are gated instead,
// which looks the same from outside and needs no removal API on the mock.
//
// This is the job mock-port's one-slot-per-event did as a side effect of being wrong about
// Firefox. Splitting it out let the mock become additive, which is what made two
// double-registered events visible at L3 at all.
function aSessionPort(port: BrowserPort): { port: BrowserPort; stop: () => void } {
  let live = true;

  // Every event the port exposes, gated. Listed rather than proxied so a new event on
  // `BrowserPort` fails to compile here instead of silently joining what a dead session
  // still hears.
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
      // Undefined, not a Promise of undefined: a dead session must leave the reply channel
      // free for the live one, as wiring's dispatcher does for a message it does not own.
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

// Starts a background against `browser`, running the async tail in background.ts's order and
// awaiting it, so a caller observes a settled startup.
export async function startTheBackground(
  browser: MockPort,
  clock: Clock,
  config: Config,
  // What background.ts passes for the sync publish. Optional because only the cases about
  // applying a config care which of the two apply paths fired it.
  opts: { afterApply?: () => void } = {},
): Promise<BackgroundSession> {
  const session = aSessionClock(clock);
  const listeners = aSessionPort(browser.port);
  const background = wireBackground({
    port: listeners.port,
    clock: session.clock,
    graceMs: GRACE_MS,
    redirectorDelayMs: REDIRECTOR_DELAY_MS,
    ...opts,
  });

  background.useConfig(config);
  // The gate's own condition: config published and pause hydrated. Awaited so a caller sees
  // a background that finished starting — otherwise a case can read half-hydrated pause state
  // and pass for the wrong reason.
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

// The same browser, none of the same memory. Every Map, Set and counter the previous
// background held is gone; what the new one knows, it rebuilt from browser.* queries.
//
// `previous.ends()` retires the old session, in two halves because the browser outlives the
// background twice over: `aSessionPort` stops its listeners being called (mock-port is
// additive, like Firefox, so re-wiring adds handlers rather than replacing them) and
// `aSessionClock` stops its timers firing (the fake clock is shared and knows nothing about
// sessions). Both model one fact: Firefox destroys the context a dead background lives in.
//
// Not modelled: async work in flight at the restart — Firefox kills it, here it lands. Drive
// restarts from a settled state, as every case in restart.test.ts does.
export async function restartTheBackground(
  previous: BackgroundSession,
  browser: MockPort,
  clock: Clock,
  config: Config,
): Promise<BackgroundSession> {
  previous.ends();
  return startTheBackground(browser, clock, config);
}
