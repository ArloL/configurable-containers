import { createEngine, type Engine } from "../engine/engine";
import { createAutoTemp } from "../engine/auto-temp";
import { createDisposer } from "../engine/disposer";
import { createCookieSeeder } from "../engine/cookie-seeder";
import { createScriptInjector } from "../engine/script-injector";
import { createRedirectorCloser } from "../engine/redirector-closer";
import { createPicker } from "../engine/picker";
import { createPause, type Pause } from "../engine/pause";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { highestTmpSuffix } from "../engine/registry";
import type { BrowserPort, Clock } from "../engine/port";
import type { Config } from "../resolver/types";

export interface WiringOptions {
  port: BrowserPort;
  clock: Clock;
  graceMs: number;
  redirectorDelayMs: number;
}

export interface Background {
  // The single config object every sibling reads at event time. Filled in place.
  config: Config;
  // Fills `config` and releases the gated first navigation. One call, because the two
  // must happen together.
  useConfig(loaded: Config): void;
  // Raises the throwaway counter past every tmp<N> that already exists.
  resumeTmpSuffix(): Promise<void>;
  // The one sibling that reads the config eagerly, so it runs after useConfig.
  injectScripts(): Promise<void>;
  engine: Engine;
  pause: Pause;
  // Resolves when the gate opens: config published AND pause state hydrated. background.ts
  // never awaits it (the gated handler does), so it exists for the restart harness, which
  // must drive from a settled state rather than hope hydration lands inside another await.
  ready: Promise<void>;
}

// Wires the engine and its siblings onto a port and returns the four steps that must wait
// for the config. Called by `background.ts` at module top level and by
// `test/engine/restart.ts`: a restart test is only as honest as the startup it restarts
// into, so both drive this one path instead of the test keeping a second copy of the
// startup order.
//
// EVERY browser.* listener below registers SYNCHRONOUSLY and must keep doing so. After an
// await, the session's first navigation is lost outright — Firefox dispatches it before
// webRequest.onBeforeRequest exists, so that tab is never routed (test/e2e/auto-temp.test.ts
// went red the moment the wiring moved inside an async IIFE). So this function never awaits,
// and two devices let the config arrive later:
//
//   1. `config` is filled IN PLACE by `useConfig`. Every sibling but the script-injector
//      reads it at event time, so all of them see the load through this one object; handing
//      them a freshly parsed object would leave them holding the empty one.
//   2. `gatedPort` holds the blocking onBeforeRequest handler until the config arrives, so
//      an early navigation is DELAYED rather than routed against an empty config. Firefox
//      awaits a blocking listener's promise before letting the request proceed.
export function wireBackground(opts: WiringOptions): Background {
  const { port, clock, graceMs, redirectorDelayMs } = opts;

  const config: Config = { rules: [], groups: [] };

  // Definitely assigned: a Promise executor runs synchronously, but tsc can't see that.
  let markConfigReady!: () => void;
  const configReady = new Promise<void>((resolve) => {
    markConfigReady = resolve;
  });

  const pause = createPause({ port, clock });

  // The blocking handler waits for BOTH: routing against an empty config is wrong, and so
  // is routing a container the user armed before the restart. The armed set cannot be read
  // inside the handler (a storage round-trip before every navigation), so it is read once
  // here and the session's first navigation is delayed. Registration stays synchronous;
  // only the handler's body awaits.
  const ready = Promise.all([configReady, pause.hydrate()]);

  const gatedPort: BrowserPort = {
    ...port,
    onBeforeRequest(handler) {
      port.onBeforeRequest(async (details) => {
        await ready;
        return handler(details);
      });
    },
  };

  // Shared by the engine's reopen and auto-temp so their container names never collide.
  // Starts at 0 and is raised past every existing tmp<N> by resumeTmpSuffix below — every
  // config save reloads, and a reset counter would reissue a live container's name.
  // Auto-temp cannot wait for that answer; its listeners must register synchronously too.
  let n = 0;
  const tmpSuffix = (): string => String(++n);

  // onChoice fires at navigation time, long after construction, so the forward reference
  // is safe. `let` makes the dependency direction explicit.
  let picker: ReturnType<typeof createPicker>;
  const engine = createEngine({
    port: gatedPort,
    config,
    deps: { matchRule, matchGroup, sameSite },
    pause,
    tmpSuffix,
    onChoice: (options, nav) => {
      void picker.showChoice(nav.tabId, nav.url, options);
    },
  });
  picker = createPicker({ port, config, deps: { matchRule }, reopen: engine.reopen });

  // The ONE runtime.onMessage registration; siblings expose a handler and are dispatched by
  // `type` from here. In Firefox an async handler returns a Promise for EVERY message it
  // sees, claiming the reply channel from the sibling the message was addressed to, so a
  // synchronous undefined for an unknown type is what leaves that channel free. Unlike the
  // tab events this is a real browser bug, not just a test-double one;
  // `test/fitness/listeners.test.ts` keeps this the only registration.
  port.onMessage((msg, sender) => {
    const type = (msg as { type?: unknown } | null | undefined)?.type;
    if (type === "cc-pick") return picker.handleMessage(msg, sender);
    if (typeof type === "string" && type.startsWith("cc-pause-")) return pause.handleMessage(msg);
    return undefined;
  });

  createAutoTemp({ port, tmpSuffix });

  createDisposer({ port, clock, graceMs });

  createCookieSeeder({ port, config, deps: { matchRule } });

  createRedirectorCloser({ port, clock, config, deps: { matchRule }, delayMs: redirectorDelayMs });

  return {
    config,
    useConfig(loaded) {
      // A parse failure leaves the object empty: nothing matches, so every site opens in a
      // fresh throwaway. It can never route a site into the WRONG permanent container.
      Object.assign(config, loaded);
      markConfigReady();
    },
    async resumeTmpSuffix() {
      n = Math.max(n, highestTmpSuffix((await port.queryIdentities()).map((c) => c.name)));
    },
    async injectScripts() {
      await createScriptInjector({ port, config });
    },
    engine,
    pause,
    ready: ready.then(() => {}),
  };
}
