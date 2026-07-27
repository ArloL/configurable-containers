import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";
import { BUNDLED_CONFIG_YAML } from "../../src/extension/config";

describe("bundled extension config", () => {
  it("parses and routes work.example to the Work container", () => {
    const config = parseConfig(BUNDLED_CONFIG_YAML);
    const rule = matchRule("https://work.example/", config.rules);
    expect(rule).not.toBeNull();
    expect(rule!.action).toEqual({ kind: "open", containers: ["Work"] });
  });

  it("does not match an unrelated host", () => {
    const config = parseConfig(BUNDLED_CONFIG_YAML);
    expect(matchRule("https://nomatch.example/", config.rules)).toBeNull();
  });
});
