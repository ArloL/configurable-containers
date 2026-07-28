import { describe, it, expect } from "vitest";
import { highestTmpSuffix } from "../../src/engine/registry";

describe("highestTmpSuffix", () => {
  it("is 0 when no containers exist", () => {
    expect(highestTmpSuffix([])).toBe(0);
  });

  it("is 0 when no container is a throwaway", () => {
    expect(highestTmpSuffix(["Work", "Personal", "Banking"])).toBe(0);
  });

  it("finds the highest numeric suffix", () => {
    expect(highestTmpSuffix(["tmp1", "tmp7", "tmp3"])).toBe(7);
  });

  it("compares numerically, not lexicographically", () => {
    expect(highestTmpSuffix(["tmp9", "tmp10"])).toBe(10);
  });

  it("ignores tmp-prefixed names without a numeric suffix", () => {
    expect(highestTmpSuffix(["tmp", "tmpfoo", "tmp2"])).toBe(2);
  });

  it("ignores permanent containers that merely contain 'tmp'", () => {
    expect(highestTmpSuffix(["my-tmp-box", "Work"])).toBe(0);
  });
});
