import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/load";
import { ConfigError } from "../../src/config/parse";

const SEED = `
rules:
  - match: seed.example
    open: Seed
`;

const STORED = `
rules:
  - match: stored.example
    open: Stored
`;

const BROKEN = `
rules:
  - match: 123
    open: Nope
`;

describe("loadConfig", () => {
  it("falls back to the seed when nothing is stored", () => {
    const r = loadConfig(undefined, SEED);
    expect(r.seeded).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.config.rules).toHaveLength(1);
    expect(r.config.rules[0].action).toEqual({ kind: "open", containers: ["Seed"] });
  });

  it("prefers the stored config over the seed", () => {
    const r = loadConfig(STORED, SEED);
    expect(r.seeded).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.config.rules[0].action).toEqual({ kind: "open", containers: ["Stored"] });
  });

  it("yields the empty config and the error when the stored config is broken", () => {
    const r = loadConfig(BROKEN, SEED);
    expect(r.seeded).toBe(false);
    expect(r.error).toBeInstanceOf(ConfigError);
    expect(r.config).toEqual({ rules: [], groups: [] });
  });

  // The crucial one: a broken stored config must NOT silently revert to the
  // seed, which would route against rules the user has not seen in months.
  it("does not fall back to the seed when the stored config is broken", () => {
    const r = loadConfig(BROKEN, SEED);
    expect(r.config.rules).toHaveLength(0);
  });

  it("yields the empty config when the SEED itself is broken on first run", () => {
    const r = loadConfig(undefined, BROKEN);
    expect(r.seeded).toBe(true);
    expect(r.error).toBeInstanceOf(ConfigError);
    expect(r.config).toEqual({ rules: [], groups: [] });
  });

  it("treats an empty stored config as valid and empty, not as absent", () => {
    const r = loadConfig("", SEED);
    expect(r.seeded).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.config).toEqual({ rules: [], groups: [] });
  });

  it("returns a fresh empty config object each time", () => {
    const a = loadConfig(BROKEN, SEED);
    const b = loadConfig(BROKEN, SEED);
    expect(a.config).not.toBe(b.config);
  });
});
