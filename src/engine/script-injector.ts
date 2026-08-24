import type { Config } from "../resolver/types";
import type { BrowserPort } from "./port";
import { scriptRegistrations } from "../overlays/scripts";

export interface ScriptInjectorOptions {
  port: BrowserPort;
  config: Config;
}

// Unlike the seeder's per-request listener this is registration-based: at startup it
// registers each script via browser.contentScripts.register and Firefox injects it at runAt
// for matching pages (F12 — document_start runs before the page's own scripts). No
// cookieStoreId (F11): the script runs wherever the URL loads, so in the tab's own container
// after routing.
export async function createScriptInjector(opts: ScriptInjectorOptions): Promise<void> {
  const { port, config } = opts;
  for (const reg of scriptRegistrations(config)) {
    await port.registerContentScript({
      matches: reg.matches,
      js: [{ code: reg.code }],
      runAt: reg.runAt,
    });
  }
}
