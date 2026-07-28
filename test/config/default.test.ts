import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";

// ESM: no __dirname. Same pattern as test/config/parse.real.test.ts:7.
const DEFAULT_YAML = readFileSync(
  fileURLToPath(new URL("../../src/config/default.yaml", import.meta.url)),
  "utf8",
);

describe("the shipped default config", () => {
  it("parses", () => {
    expect(() => parseConfig(DEFAULT_YAML)).not.toThrow();
  });

  // It ships to strangers: a default that silently routed real domains would be
  // hostile, so every rule must be commented out.
  it("routes nothing", () => {
    const config = parseConfig(DEFAULT_YAML);
    expect(config.rules).toEqual([]);
    expect(config.groups).toEqual([]);
    expect(matchRule("https://example.com/", config.rules)).toBeNull();
  });

  it("documents the syntax a new user needs", () => {
    expect(DEFAULT_YAML).toContain("rules:");
    expect(DEFAULT_YAML).toContain("match:");
    expect(DEFAULT_YAML).toContain("open:");
    expect(DEFAULT_YAML).toContain("groups:");
  });
});
