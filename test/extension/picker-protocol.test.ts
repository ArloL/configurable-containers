import { describe, it, expect } from "vitest";
import { encodePayload, decodePayload, choiceKeys } from "../../src/extension/picker-protocol";

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
