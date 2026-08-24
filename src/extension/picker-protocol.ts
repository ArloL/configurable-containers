// The protocol between the background `picker` and the `choice` page. Pure — no browser, no
// DOM — so the encode/decode/key logic is testable at L1. See
// docs/superpowers/specs/2026-07-27-choice-screen-design.md §3–§4.

// No tabId: the background takes the tab from the message SENDER, so the page cannot
// name a tab it is not (the hash a choice page decodes is attacker-reachable).
export interface PickMessage {
  type: "cc-pick";
  url: string;
  container: string;
}

export interface PickResponse {
  ok: boolean;
}

export interface ChoicePayload {
  url: string;
  options: string[];
}

export function encodePayload(p: ChoicePayload): string {
  return encodeURIComponent(JSON.stringify(p));
}

export function decodePayload(s: string): ChoicePayload {
  return JSON.parse(decodeURIComponent(s)) as ChoicePayload;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

// Keyboard hints for the choice page: 1..9 then a..z (enough for any realistic rule).
export function choiceKeys(n: number): string[] {
  const all = [...DIGITS, ...LETTERS];
  if (n > all.length) throw new Error(`too many options (${n}); max ${all.length}`);
  return all.slice(0, n);
}

// What one option offers the keyboard: its positional key, always, plus a mnemonic when the
// name yields one nobody has claimed — the container's initial, which is what people
// remember ("w for Work"). `at` is that letter's offset, so the page can underline the
// character it bound instead of leaving the mnemonic undiscoverable.
export interface ChoiceHint {
  key: string;
  mnemonic?: string;
  at?: number;
}

// The first ASCII letter of a name, lowercased, with its offset: "2FA" binds "f"; a name
// with no ASCII letter binds nothing and keeps its positional key.
function initialOf(name: string): { letter: string; at: number } | undefined {
  for (let i = 0; i < name.length; i++) {
    const c = name[i].toLowerCase();
    if (c >= "a" && c <= "z") return { letter: c, at: i };
  }
  return undefined;
}

// Positional keys first, then mnemonics into what is left, so a mnemonic never displaces
// the key printed beside another option. Two containers sharing an initial leave it with the
// first, which is the one the page underlines. Order is the config's, so the same rule
// always yields the same keys.
export function choiceHints(options: string[]): ChoiceHint[] {
  const keys = choiceKeys(options.length);
  const taken = new Set(keys);
  return options.map((name, i) => {
    const initial = initialOf(name);
    if (!initial || taken.has(initial.letter)) return { key: keys[i] };
    taken.add(initial.letter);
    return { key: keys[i], mnemonic: initial.letter, at: initial.at };
  });
}

// Every key that selects an option, mapped to its index. A Map, not an object: the lookup
// key is whatever the user pressed, and an object answers `"constructor"` with something
// truthy that is not an index.
export function choiceBindings(hints: ChoiceHint[]): Map<string, number> {
  const map = new Map<string, number>();
  hints.forEach((h, i) => {
    map.set(h.key, i);
    if (h.mnemonic) map.set(h.mnemonic, i);
  });
  return map;
}

// What a keystroke means: `pick` opens a container, `focus` moves the highlight, `cancel`
// dismisses, null means "not ours — leave it to the browser".
export type ChoiceIntent =
  | { kind: "pick"; index: number }
  | { kind: "focus"; index: number }
  | { kind: "cancel" };

// The parts of a KeyboardEvent this needs, so the rule stays pure (L1) instead of reachable
// only through a DOM the unit tests do not have.
export interface ChoiceKeyEvent {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

// The whole keyboard grammar of the choice page, as a function of the keystroke and where
// the highlight is (`focused` is -1 for nowhere).
//
// A modified keystroke is never ours: Ctrl+W, Alt+Left and Cmd+L belong to the browser, and
// swallowing them would make the page a trap. Shift does not count — it is how a capital is
// typed, and `key` is matched case-insensitively.
export function choiceIntent(
  e: ChoiceKeyEvent,
  bindings: Map<string, number>,
  count: number,
  focused: number
): ChoiceIntent | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  // Esc answers even with nothing to choose from — it is the way out of the page.
  if (e.key === "Escape") return { kind: "cancel" };
  if (count < 1) return null;
  switch (e.key) {
    case "Enter":
    case " ":
      return focused >= 0 && focused < count ? { kind: "pick", index: focused } : null;
    // Wrapping: the list is short, and a wrapped arrow is one keystroke where hitting the
    // end and reversing is three.
    case "ArrowDown":
      return { kind: "focus", index: focused < 0 ? 0 : (focused + 1) % count };
    case "ArrowUp":
      return { kind: "focus", index: focused <= 0 ? count - 1 : focused - 1 };
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: count - 1 };
  }
  const index = bindings.get(e.key.toLowerCase());
  return index === undefined ? null : { kind: "pick", index };
}
