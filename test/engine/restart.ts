import { wireBackground, type Background } from "../../src/extension/wiring";
import type { Clock } from "../../src/engine/port";
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

// Starts a background against `browser`, running the async tail in the order
// background.ts runs it, and awaits it — so a caller observes a settled startup.
export async function startTheBackground(
  browser: MockPort,
  clock: Clock,
  config: Config,
): Promise<BackgroundSession> {
  const session = aSessionClock(clock);
  const background = wireBackground({
    port: browser.port,
    clock: session.clock,
    graceMs: GRACE_MS,
    redirectorDelayMs: REDIRECTOR_DELAY_MS,
  });

  background.useConfig(config);
  await background.resumeTmpSuffix();
  await background.injectScripts();

  return { ...background, ends: session.stop };
}

// The same browser, none of the same memory. Every Map, Set and counter the
// previous background held is gone; whatever the new one knows, it reconstructed
// from browser.* queries.
//
// Re-wiring is all it takes to retire the old listeners: mock-port.ts holds ONE
// handler slot per event, so a second registration replaces the first — exactly as
// a dead context's listeners stop being called. Its timers need the explicit stop
// above, because the fake clock is shared and does not know about sessions.
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
