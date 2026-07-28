// The shared protocol between the background `picker` and the `choice` page. Pure, no
// browser, no DOM — so the encode/decode/key logic is unit-testable at L1. See
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
