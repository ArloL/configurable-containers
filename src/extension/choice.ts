// The keyboard-driven choice page. Stateless: the background encodes
// {tabId,url,options} into the URL hash; this script decodes, renders the options with
// keyboard hints, and reports a selection via runtime.sendMessage. On {ok:true} the
// background's reopen closes this tab; on {ok:false} (or no handler) it navigates back to
// the url (fail-open). Esc also navigates back. See the choice-screen design spec §4.

import { decodePayload, choiceKeys, type PickMessage, type PickResponse } from "./picker-protocol";

const payload = decodePayload(location.hash.slice(1));
const keys = choiceKeys(payload.options.length);

// Only navigate to http(s) URLs — the hash payload is attacker-controllable (a crafted
// moz-extension://<id>/choice.html#... link could otherwise inject a javascript: URL,
// executing script in the extension's privileged context, or redirect to an arbitrary
// scheme). Mirrors the engine's own onBeforeRequest http(s) guard.
function safeNavigate(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
  } catch {
    return;
  }
  location.href = url;
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

async function pick(container: string): Promise<void> {
  const status = document.getElementById("cc-status")!;
  status.hidden = false;
  status.textContent = "Opening " + container + "…";
  const msg: PickMessage = { type: "cc-pick", tabId: payload.tabId, url: payload.url, container };
  try {
    const res = (await browser.runtime.sendMessage(msg)) as PickResponse | undefined;
    if (res && !res.ok) {
      safeNavigate(payload.url); // reopen failed — fail open back to the url
    }
    // else: the background's reopen closed this tab; nothing to do
  } catch {
    safeNavigate(payload.url); // no handler / background gone — fail open
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    safeNavigate(payload.url);
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
