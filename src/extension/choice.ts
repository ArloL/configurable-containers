// The keyboard-driven choice page. Stateless: the background encodes {url,options} into
// the URL hash; this script decodes, renders the options with keyboard hints, and reports
// a selection via runtime.sendMessage. On {ok:true} the background's reopen consumes this
// tab. See the choice-screen design spec §4.
//
// This page lives in a tab of its own, beside the page the user was on, so Esc means
// CANCEL — close this tab and leave that page alone. It deliberately never navigates
// itself to the payload url: that url resolved to a choice in the first place, so loading
// it here would just be answered with another choice page. (It also kept the hash payload
// — which is attacker-reachable via a crafted moz-extension://<id>/choice.html#… link — on
// a path to `location.href`, where a javascript: url would have run privileged. The
// background re-checks the url it receives for the same reason.)

import { decodePayload, choiceKeys, type PickMessage, type PickResponse } from "./picker-protocol";

const payload = decodePayload(location.hash.slice(1));
const keys = choiceKeys(payload.options.length);

const status = document.getElementById("cc-status")!;

async function closeSelf(): Promise<void> {
  const self = await browser.tabs.getCurrent();
  if (self?.id != null) await browser.tabs.remove(self.id);
}

document.getElementById("cc-dest")!.textContent = "Opening: " + payload.url;

const list = document.getElementById("cc-options")!;
payload.options.forEach((container, i) => {
  const li = document.createElement("li");
  li.setAttribute("data-cc-option", "");
  li.setAttribute("data-key", keys[i]);
  li.setAttribute("data-container", container);
  li.tabIndex = 0;
  li.textContent = `${keys[i]} · ${container}`;
  list.appendChild(li);
});

// The reopen could not be performed. Say so and leave the options live rather than
// loading the url here: this tab is not the user's page, and the choice still stands.
function reportFailed(container: string): void {
  status.hidden = false;
  status.textContent = `Could not open ${container}. Pick again, or press Esc to cancel.`;
}

async function pick(container: string): Promise<void> {
  status.hidden = false;
  status.textContent = "Opening " + container + "…";
  const msg: PickMessage = { type: "cc-pick", url: payload.url, container };
  try {
    const res = (await browser.runtime.sendMessage(msg)) as PickResponse | undefined;
    if (res && !res.ok) reportFailed(container);
    // else: the background's reopen consumed this tab; nothing to do
  } catch {
    reportFailed(container); // no handler / background gone
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    void closeSelf();
    return;
  }
  const li = list.querySelector<HTMLElement>(`[data-key="${e.key}"]`);
  if (li) {
    void pick(li.getAttribute("data-container")!);
  }
});

list.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-cc-option]");
  if (li) {
    void pick(li.getAttribute("data-container")!);
  }
});
