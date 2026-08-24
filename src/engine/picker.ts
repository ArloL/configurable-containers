import type { Config, Deps, Target } from "../resolver/types";
import { TEMPORARY } from "../resolver/types";
import type { BrowserPort, MessageSender, Tab } from "./port";
import { supersede } from "./supersede";
import { encodePayload, type PickMessage, type PickResponse } from "../extension/picker-protocol";

export interface PickerOptions {
  port: BrowserPort;
  config: Config;
  deps: Pick<Deps, "matchRule">;
  reopen: (tab: Tab, url: string, target: Target) => Promise<void>;
}

export interface Picker {
  // Called by the engine's onChoice and by the reopen-picker command.
  showChoice(tabId: number, url: string, options: string[]): Promise<void>;
  // The wiring owns the single runtime.onMessage registration and dispatches to this.
  // Returns undefined SYNCHRONOUSLY for a message that is not ours: in Firefox an async
  // handler returns a Promise for every message it sees, which says "I will answer this"
  // and claims the reply channel from the sibling that was addressed.
  handleMessage(msg: unknown, sender: MessageSender): Promise<PickResponse> | undefined;
}

const REOPEN_PICKER_COMMAND = "reopen-picker";

function containerToTarget(container: string): Target {
  return container === TEMPORARY ? { kind: "temporary" } : { kind: "permanent", name: container };
}

// Owns the choice screen and the reopen picker. Both show the stateless choice page and,
// on selection, go through the engine's F1-guarded `reopen` — the picker never reopens a
// tab by hand. See the choice-screen design spec §2.
export function createPicker(opts: PickerOptions): Picker {
  const { port, config, deps, reopen } = opts;

  // The choice page opens in a tab OF ITS OWN, beside the triggering tab. Loading it into
  // the triggering tab, as this once did, destroyed the user's page before they had chosen
  // anything — the loss `supersede` exists to avoid. Both paths now share that rule: a
  // triggering tab on a page is kept, one with nothing to lose is replaced.
  //
  // Picking then supersedes the CHOICE tab, which is never on http(s) and so is always
  // replaced, landing the container tab where a single-container reopen would have put it.
  async function showChoice(tabId: number, url: string, options: string[]): Promise<void> {
    const tab = await port.getTab(tabId);
    if (!tab) return; // raced away
    const choiceUrl = port.getURL("choice.html") + "#" + encodePayload({ url, options });
    await supersede(port, tab, { url: choiceUrl, cookieStoreId: tab.cookieStoreId });
  }

  // Not `async`: "not ours" must be a synchronous undefined, and an async function returns
  // a Promise before its first line runs.
  function handleMessage(msg: unknown, sender: MessageSender): Promise<PickResponse> | undefined {
    const m = msg as PickMessage;
    if (m?.type !== "cc-pick") return undefined;
    return (async () => {
      // The tab to consume is the one that spoke, never one the message names: the hash
      // payload the page renders from is attacker-reachable (a crafted
      // moz-extension://<id>/choice.html#… link), and so is anything derived from it.
      if (sender.tabId == null) return { ok: false } satisfies PickResponse;
      // The url travels on to port.createTab, where a javascript: or data: url would run
      // in a privileged origin.
      if (!/^https?:/.test(m.url)) return { ok: false } satisfies PickResponse;
      const tab = await port.getTab(sender.tabId);
      if (!tab) return { ok: false } satisfies PickResponse;
      try {
        await reopen(tab, m.url, containerToTarget(m.container));
        return { ok: true } satisfies PickResponse;
      } catch {
        return { ok: false } satisfies PickResponse;
      }
    })();
  }

  port.onCommand((name) => {
    if (name !== REOPEN_PICKER_COMMAND) return;
    void (async () => {
      const tab = await port.getActiveTab();
      if (!tab) return;
      const rule = deps.matchRule(tab.url, config.rules);
      // Only a multi-open rule has anything to choose; everything else is a no-op (the
      // unmatched case is undecided per CONFIG.md).
      if (!rule || rule.action.kind !== "open" || rule.action.containers.length < 2) return;
      await showChoice(tab.id, tab.url, rule.action.containers);
    })();
  });

  return { showChoice, handleMessage };
}
