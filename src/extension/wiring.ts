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
  // Publishes the loaded config: fills `config` and releases the gated first
  // navigation. One call because the two must happen together.
  useConfig(loaded: Config): void;
  // Raises the throwaway counter past every tmp<N> that already exists.
  resumeTmpSuffix(): Promise<void>;
  // The one sibling that reads the config eagerly, so it runs after useConfig.
  injectScripts(): Promise<void>;
  engine: Engine;
  pause: Pause;
  // Resolves when the gate opens — config published AND pause state hydrated. Nothing in
  // background.ts awaits it (the gated handler does that itself); it is here so the
  // restart harness can drive from a settled state rather than relying on hydration
  // happening to land inside some other await.
  ready: Promise<void>;
}

// Wires the engine and its siblings onto a port, and returns the four steps that
// must wait for the config. Called by `background.ts` at module top level, and by
// `test/engine/restart.ts` — which is the point: a restart test is only as honest
// as the startup it restarts into, so both drive this one path rather than the test
// keeping a second copy of the startup order that can silently drift.
//
// EVERY browser.* listener below registers SYNCHRONOUSLY, and must keep doing so.
// Registering them after an await loses the session's first navigation outright:
// Firefox dispatches it before webRequest.onBeforeRequest exists, so that tab is
// never routed (proven by test/e2e/auto-temp.test.ts, which went red the moment the
// wiring moved inside an async IIFE). This function therefore never awaits. Two
// devices let the config arrive later without breaking that:
//
//   1. `config` is filled IN PLACE by `useConfig`. Every sibling except the
//      script-injector reads `config.rules` / `config.groups` at event time rather
//      than at construction time, so they all observe the load through this object.
//      Passing a freshly parsed object instead would leave them holding the empty one.
//   2. `gatedPort` holds the blocking onBeforeRequest handler until the config has
//      actually arrived, so an early navigation is *delayed* rather than routed
//      against the still-empty config. Firefox awaits a blocking listener's promise
//      before letting the request proceed, which is what makes this safe.
export function wireBackground(opts: WiringOptions): Background {
  const { port, clock, graceMs, redirectorDelayMs } = opts;

  const config: Config = { rules: [], groups: [] };

  // Definitely assigned: a Promise executor runs synchronously, but tsc can't see that.
  let markConfigReady!: () => void;
  const configReady = new Promise<void>((resolve) => {
    markConfigReady = resolve;
  });

  const pause = createPause({ port, clock });

  // The blocking handler waits for BOTH. Routing against a still-empty config is wrong,
  // and so is routing a container the user armed before the restart — and the armed set
  // cannot be read inside the handler, because that is a storage round-trip in front of
  // every navigation in the browser. So it is read once, here, and the session's first
  // navigation is delayed instead. Registration itself stays synchronous; only the
  // handler's body awaits.
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

  // The throwaway counter is shared by the engine's reopen and auto-temp so their temp
  // container names never collide. It starts at 0 and is raised to clear any existing
  // tmp<N> by resumeTmpSuffix below — a reload (every config save triggers one) would
  // otherwise reissue a live container's name. Auto-temp cannot wait for that answer:
  // its own listeners must register synchronously too.
  let n = 0;
  const tmpSuffix = (): string => String(++n);

  // `picker` is referenced inside onChoice (which fires only at navigation time, after
  // construction), so the forward-reference is safe. Hoisted with `let` to satisfy the
  // linter and make the dependency direction explicit.
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

  // The ONE runtime.onMessage registration. Siblings expose a handler and are dispatched
  // by `type` from here, for two reasons that both fail silently: mock-port holds a
  // single handler slot per event, so a second addListener replaces the first without
  // any test going red; and in Firefox an async handler returns a Promise for EVERY
  // message it sees, which claims the reply channel from the sibling the message was
  // addressed to. Returning undefined synchronously for an unknown type is what leaves
  // that channel free.
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
      // On a parse failure this leaves the object empty: nothing matches, so every
      // site opens in a fresh throwaway. The failure cannot route a site into the
      // WRONG permanent container.
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
