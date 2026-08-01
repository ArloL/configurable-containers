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
  // Open the choice page for the triggering tab. Called by the engine's onChoice
  // (automatic) and by the reopen-picker command (manual).
  showChoice(tabId: number, url: string, options: string[]): Promise<void>;
  // The wiring owns the single runtime.onMessage registration and dispatches to this.
  // Returns undefined SYNCHRONOUSLY for a message that is not ours: registering a second
  // listener here would replace this one in mock-port (one handler slot per event), and
  // in Firefox an async handler returns a Promise for every message it sees — which
  // tells Firefox "I will answer this" and claims the reply channel from the sibling the
  // message was actually addressed to.
  handleMessage(msg: unknown, sender: MessageSender): Promise<PickResponse> | undefined;
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

  // The choice page opens in a tab OF ITS OWN, beside the triggering tab. Navigating the
  // triggering tab there instead — as this did — destroyed the page the user was on
  // before they had chosen anything, which is exactly the loss `supersede` exists to
  // avoid for single-container rules. The two paths now share that rule: a triggering tab
  // that is on a page is kept, one with nothing to lose (a pre-commit middle-clicked
  // link) is replaced, so no empty tab is stranded either way.
  //
  // Picking then supersedes the CHOICE tab, which is never on an http(s) page and so is
  // always replaced — landing the container tab at the same index, in the same window,
  // with the same opener a single-container reopen would have produced.
  async function showChoice(tabId: number, url: string, options: string[]): Promise<void> {
    const tab = await port.getTab(tabId);
    if (!tab) return; // tab raced away — nothing to route
    const choiceUrl = port.getURL("choice.html") + "#" + encodePayload({ url, options });
    await supersede(port, tab, { url: choiceUrl, cookieStoreId: tab.cookieStoreId });
  }

  // Not `async`: the "not ours" answer has to be a synchronous undefined, and an async
  // function cannot give one — it returns a Promise before the first line runs.
  function handleMessage(msg: unknown, sender: MessageSender): Promise<PickResponse> | undefined {
    const m = msg as PickMessage;
    if (m?.type !== "cc-pick") return undefined;
    return (async () => {
      // The tab to consume is the one that spoke, not one the message names: the hash
      // payload a choice page renders from is attacker-reachable (a crafted
      // moz-extension://<id>/choice.html#… link), and so is anything derived from it.
      if (sender.tabId == null) return { ok: false } satisfies PickResponse;
      // Same reason the choice page only ever navigated to http(s): the url travels on to
      // port.createTab, and a javascript:/data: url there would run in a privileged origin.
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
      // Only a multi-open rule has anything to choose; single-open / no-rule / non-open
      // rules are no-ops (the unmatched case is undecided per CONFIG.md).
      if (!rule || rule.action.kind !== "open" || rule.action.containers.length < 2) return;
      await showChoice(tab.id, tab.url, rule.action.containers);
    })();
  });

  return { showChoice, handleMessage };
}
