import { describe, it, expect } from "vitest";
import {
  encodePayload,
  decodePayload,
  choiceKeys,
  choiceHints,
  choiceBindings,
  choiceIntent,
} from "../../src/extension/picker-protocol";

describe("picker-protocol", () => {
  it("encodes and decodes a payload round-trip", () => {
    const p = { tabId: 7, url: "http://figma.example:1234/", options: ["Personal", "Work"] };
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });

  it("survives container names with spaces and special chars", () => {
    const p = { tabId: 1, url: "http://x.test/", options: ["My Container", "a,b"] };
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });

  it("choiceKeys: 1..9 then a..z", () => {
    expect(choiceKeys(2)).toEqual(["1", "2"]);
    expect(choiceKeys(9)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(choiceKeys(11)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b"]);
  });

  it("choiceKeys throws for more than 35 options (unrealistic)", () => {
    expect(() => choiceKeys(36)).toThrow();
  });
});

describe("choice hints: the key a user actually remembers", () => {
  it("gives every option its positional key and, where free, the initial of its name", () => {
    expect(choiceHints(["Personal", "Work"])).toEqual([
      { key: "1", mnemonic: "p", at: 0 },
      { key: "2", mnemonic: "w", at: 0 },
    ]);
  });

  it("two containers sharing an initial: the first keeps it, the second stays positional", () => {
    // Both must remain reachable, and which one "p" opens must not depend on anything
    // but config order — a mnemonic that moved between sessions is worse than none.
    expect(choiceHints(["Personal", "Play"])).toEqual([{ key: "1", mnemonic: "p", at: 0 }, { key: "2" }]);
  });

  it("a mnemonic never displaces the positional key printed beside another option", () => {
    // With >9 options the positional keys reach into a..z; "Alpha" cannot take "a" there
    // because "a" is already the tenth option's printed key.
    const hints = choiceHints([...Array.from({ length: 9 }, (_, i) => `C${i}`), "Tenth", "Alpha"]);
    expect(hints[9]).toEqual({ key: "a", mnemonic: "t", at: 0 });
    expect(hints[10]).toEqual({ key: "b" }); // "a" belongs to the option printed "a"
    expect(choiceBindings(hints).get("a")).toBe(9);
  });

  it("binds the first ASCII letter, not the first character, and skips names that have none", () => {
    expect(choiceHints(["2FA", "日本"])).toEqual([{ key: "1", mnemonic: "f", at: 1 }, { key: "2" }]);
  });

  it("bindings answer both keys of an option, and nothing else", () => {
    const bindings = choiceBindings(choiceHints(["Personal", "Work"]));
    expect(bindings.get("1")).toBe(0);
    expect(bindings.get("p")).toBe(0);
    expect(bindings.get("2")).toBe(1);
    expect(bindings.get("w")).toBe(1);
    expect(bindings.get("z")).toBeUndefined();
    // A Map, not an object: an object would answer this with Object's constructor, and
    // the caller would treat a function as an option index.
    expect(bindings.get("constructor")).toBeUndefined();
  });
});

describe("choiceIntent: the choice page's keyboard grammar", () => {
  const bindings = choiceBindings(choiceHints(["Personal", "Work"]));
  const intent = (key: string, focused = -1, mods: Record<string, boolean> = {}) =>
    choiceIntent({ key, ...mods }, bindings, 2, focused);

  it("a hotkey picks its option from anywhere, whatever the focus", () => {
    expect(intent("2")).toEqual({ kind: "pick", index: 1 });
    expect(intent("w", 0)).toEqual({ kind: "pick", index: 1 });
  });

  it("matches a hotkey case-insensitively — Shift is how a capital is typed", () => {
    expect(intent("W")).toEqual({ kind: "pick", index: 1 });
  });

  it("Enter and Space open the focused option, and do nothing when nothing is focused", () => {
    expect(intent("Enter", 1)).toEqual({ kind: "pick", index: 1 });
    expect(intent(" ", 0)).toEqual({ kind: "pick", index: 0 });
    expect(intent("Enter", -1)).toBeNull();
  });

  it("arrows move the highlight and wrap, starting at an end when nothing is focused", () => {
    expect(intent("ArrowDown", -1)).toEqual({ kind: "focus", index: 0 });
    expect(intent("ArrowDown", 0)).toEqual({ kind: "focus", index: 1 });
    expect(intent("ArrowDown", 1)).toEqual({ kind: "focus", index: 0 });
    expect(intent("ArrowUp", -1)).toEqual({ kind: "focus", index: 1 });
    expect(intent("ArrowUp", 0)).toEqual({ kind: "focus", index: 1 });
    expect(intent("ArrowUp", 1)).toEqual({ kind: "focus", index: 0 });
    expect(intent("Home", 1)).toEqual({ kind: "focus", index: 0 });
    expect(intent("End", 0)).toEqual({ kind: "focus", index: 1 });
  });

  it("Esc cancels, even with no options to choose from", () => {
    expect(intent("Escape", -1)).toEqual({ kind: "cancel" });
    expect(choiceIntent({ key: "Escape" }, new Map(), 0, -1)).toEqual({ kind: "cancel" });
  });

  it("leaves a modified keystroke to the browser — the page must not be a trap", () => {
    // Ctrl+W closes the tab, Cmd+L focuses the address bar, Alt+Left goes back. Claiming
    // any of them (they all carry a bound `key`) would strand the user on this page.
    expect(intent("w", 0, { ctrlKey: true })).toBeNull();
    expect(intent("w", 0, { metaKey: true })).toBeNull();
    expect(intent("ArrowDown", 0, { altKey: true })).toBeNull();
  });

  it("ignores a key that is nobody's — Tab still leaves the list, F5 still reloads", () => {
    expect(intent("Tab", 0)).toBeNull();
    expect(intent("F5", 0)).toBeNull();
    expect(intent("Shift", 0)).toBeNull();
    expect(intent("z", 0)).toBeNull();
  });

  it("with an empty option list only Esc answers", () => {
    const empty = new Map<string, number>();
    expect(choiceIntent({ key: "Enter" }, empty, 0, -1)).toBeNull();
    expect(choiceIntent({ key: "ArrowDown" }, empty, 0, -1)).toBeNull();
  });
});
