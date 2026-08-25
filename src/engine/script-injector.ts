import type { Config } from "../resolver/types";
import type { BrowserPort, RegisteredContentScript } from "./port";
import { scriptRegistrations } from "../overlays/scripts";

export interface ScriptInjectorOptions {
  port: BrowserPort;
}

export interface ScriptInjector {
  apply(config: Config): Promise<void>;
}

// Unlike the seeder's per-request listener this is registration-based: each script is handed
// to browser.contentScripts.register and Firefox injects it at runAt for matching pages (F12
// — document_start runs before the page's own scripts). No cookieStoreId (F11): the script
// runs wherever the URL loads, so in the tab's own container after routing.
//
// The handles are kept because a config is applied more than once now — a save no longer
// restarts the extension, so nothing else would ever drop a registration. Unregistering is
// unconditional rather than diffed against the previous set: at this size that is a handful
// of calls on an action the user performs by hand, where a diff would be a second
// representation of the config to keep correct.
//
// What it cannot undo is a snippet already running in an open page. Neither could the
// restart this replaced: document_start means the code ran before the page's own scripts,
// and what it did to that page outlives any unregistration.
export function createScriptInjector(opts: ScriptInjectorOptions): ScriptInjector {
  const { port } = opts;
  let live: RegisteredContentScript[] = [];

  return {
    async apply(config) {
      for (const reg of live) await reg.unregister();
      live = [];
      for (const reg of scriptRegistrations(config)) {
        live.push(
          await port.registerContentScript({
            matches: reg.matches,
            js: [{ code: reg.code }],
            runAt: reg.runAt,
          }),
        );
      }
    },
  };
}
