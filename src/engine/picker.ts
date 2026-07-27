import type { Config, Deps, Target } from "../resolver/types";
import { TEMPORARY } from "../resolver/types";
import type { BrowserPort, Tab } from "./port";
import { encodePayload, type PickMessage, type PickResponse } from "../extension/picker-protocol";

export interface PickerOptions {
  port: BrowserPort;
  config: Config;
  deps: Pick<Deps, "matchRule">;
  reopen: (tab: Tab, url: string, target: Target) => Promise<void>;
}

export interface Picker {
  // Navigate the triggering tab to the choice page. Called by the engine's onChoice
  // (automatic) and by the reopen-picker command (manual).
  showChoice(tabId: number, url: string, options: string[]): Promise<void>;
}

const REOPEN_PICKER_COMMAND = "reopen-picker";

function containerToTarget(container: string): Target {
  return container === TEMPORARY ? { kind: "temporary" } : { kind: "permanent", name: container };
}

// A sibling of the engine, disposer, cookie-seeder, script-injector, and redirector-closer
// (wired at background.ts, not nested). Owns the choice screen (onChoice flow) and the
// reopen picker (keyboard command). Both surface the stateless choice page and, on
// selection, reopen into the chosen container through the engine's F1-guarded `reopen` —
// the picker never reopens a tab by hand. See the choice-screen design spec §2.
export function createPicker(opts: PickerOptions): Picker {
  const { port, config, deps, reopen } = opts;

  async function showChoice(tabId: number, url: string, options: string[]): Promise<void> {
    const choiceUrl = port.getURL("choice.html") + "#" + encodePayload({ tabId, url, options });
    await port.updateTab(tabId, { url: choiceUrl });
  }

  port.onMessage(async (msg) => {
    const m = msg as PickMessage;
    if (m?.type !== "cc-pick") return undefined;
    const tab = await port.getTab(m.tabId);
    if (!tab) return { ok: false } satisfies PickResponse;
    try {
      await reopen(tab, m.url, containerToTarget(m.container));
      return { ok: true } satisfies PickResponse;
    } catch {
      return { ok: false } satisfies PickResponse;
    }
  });

  port.onCommand((name) => {
    if (name !== REOPEN_PICKER_COMMAND) return;
    void (async () => {
      const tab = await port.getActiveTab();
      if (!tab) return;
      const rule = deps.matchRule(tab.url, config.rules);
      // Only a multi-open rule has anything to choose; single-open / no-rule / non-open
      // rules are no-ops (the unmatched case is undecided per CONFIG.md).
      if (!rule || rule.action.kind !== "open" || rule.action.containers.length < 2) return;
      await showChoice(tab.id, tab.url, rule.action.containers);
    })();
  });

  return { showChoice };
}
