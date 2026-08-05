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
//
// Keyboard handling is a pure decision (`choiceIntent`, unit-tested at L1) plus the DOM
// effects here. The page focuses its first option as it renders: with nothing focused,
// the two things a user reaches for first — arrows and Enter — did nothing at all, and
// the hotkeys were the only way in.

import {
  choiceBindings,
  choiceHints,
  choiceIntent,
  decodePayload,
  type PickMessage,
  type PickResponse,
} from "./picker-protocol";

const payload = decodePayload(location.hash.slice(1));
const hints = choiceHints(payload.options);
const bindings = choiceBindings(hints);

const status = document.getElementById("cc-status")!;

async function closeSelf(): Promise<void> {
  const self = await browser.tabs.getCurrent();
  if (self?.id != null) await browser.tabs.remove(self.id);
}

document.getElementById("cc-dest")!.textContent = "Opening: " + payload.url;

// The container name with its mnemonic letter underlined. Built from DOM nodes, not
// innerHTML: the names come from the user's config and this is a privileged
// moz-extension: page, so markup in a name must stay text.
function nameWithMnemonic(name: string, at: number | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (at === undefined) {
    frag.append(name);
    return frag;
  }
  const marked = document.createElement("u");
  marked.textContent = name[at];
  frag.append(name.slice(0, at), marked, name.slice(at + 1));
  return frag;
}

const list = document.getElementById("cc-options")!;
const items: HTMLElement[] = payload.options.map((container, i) => {
  const li = document.createElement("li");
  li.setAttribute("data-cc-option", "");
  li.setAttribute("data-key", hints[i].key);
  li.setAttribute("data-container", container);
  if (hints[i].mnemonic) li.setAttribute("data-mnemonic", hints[i].mnemonic!);
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", "false");
  // Roving tabindex: exactly one option is in the tab order, so Tab leaves the list
  // rather than walking it — arrows are how you move inside a listbox.
  li.tabIndex = -1;

  const key = document.createElement("kbd");
  key.className = "cc-key";
  key.textContent = hints[i].key;
  const name = document.createElement("span");
  name.className = "cc-name";
  name.append(nameWithMnemonic(container, hints[i].at));
  li.append(key, name);

  list.appendChild(li);
  return li;
});

let focused = -1;

function setFocus(index: number): void {
  focused = index;
  items.forEach((li, i) => {
    const on = i === index;
    li.tabIndex = on ? 0 : -1;
    li.setAttribute("aria-selected", String(on));
    if (on) li.focus();
  });
}

// The reopen could not be performed. Say so and leave the options live rather than
// loading the url here: this tab is not the user's page, and the choice still stands.
function reportFailed(container: string): void {
  status.hidden = false;
  status.textContent = `Could not open ${container}. Pick again, or press Esc to cancel.`;
}

// One pick at a time. Two keystrokes in the time a reopen takes would otherwise open the
// site twice — the reopen that consumes this tab is what normally ends the interaction,
// and until it lands the page is still listening.
let picking = false;

async function pick(index: number): Promise<void> {
  const container = payload.options[index];
  if (picking || container === undefined) return;
  picking = true;
  setFocus(index);
  status.hidden = false;
  status.textContent = "Opening " + container + "…";
  const msg: PickMessage = { type: "cc-pick", url: payload.url, container };
  try {
    const res = (await browser.runtime.sendMessage(msg)) as PickResponse | undefined;
    if (res && !res.ok) {
      picking = false;
      reportFailed(container);
    }
    // else: the background's reopen consumed this tab; nothing to do
  } catch {
    picking = false;
    reportFailed(container); // no handler / background gone
  }
}

document.addEventListener("keydown", (e) => {
  const intent = choiceIntent(e, bindings, items.length, focused);
  if (!intent) return;
  // Only now: an unhandled key (a browser shortcut, a stray modifier chord) keeps its
  // default. Space would scroll and Enter would re-fire the focused option's click.
  e.preventDefault();
  if (intent.kind === "cancel") {
    void closeSelf();
  } else if (intent.kind === "focus") {
    setFocus(intent.index);
  } else {
    void pick(intent.index);
  }
});

list.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-cc-option]");
  if (li) void pick(items.indexOf(li));
});

// Take the keyboard as the page renders, so the first keystroke lands on an option
// instead of nowhere. `window.focus()` pulls focus into content, which is what makes this
// a dialog you can answer rather than a page you must click into — but only when this tab
// is the one on screen: a middle-clicked link puts the choice in a BACKGROUND tab
// (`supersede` inherits the source's `active`), and stealing focus to it would yank the
// user off the page they are reading. The element focus below is set either way, so
// switching to that tab later still arrives on an option.
if (!document.hidden) window.focus();
if (items.length) setFocus(0);
