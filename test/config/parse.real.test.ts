import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../../src/config/parse";
import type { Config, Action } from "../../src/resolver/types";

const yamlPath = fileURLToPath(new URL("../../configurable-containers.config.yaml", import.meta.url));
const config: Config = parseConfig(readFileSync(yamlPath, "utf8"));

// Matchers are opaque at the resolver boundary but are HostMatchers here.
const hostOf = (m: unknown) => (m as { host: string }).host;
const ruleForHost = (h: string) => config.rules.find((r) => r.match.some((m) => hostOf(m) === h));
const containers = (a: Action) => (a.kind === "open" ? a.containers : []);

describe("parseConfig — real configurable-containers.config.yaml", () => {
  it("parses without error and yields many rules + several groups", () => {
    expect(config.rules.length).toBeGreaterThan(30);
    expect(config.groups.length).toBeGreaterThanOrEqual(6);
  });

  it("auto-names a bare rule (adventofcode.com)", () => {
    expect(ruleForHost("adventofcode.com")?.action).toEqual({ kind: "open", containers: ["adventofcode.com"] });
  });

  it("maps the Haeger multi-host rule to open [Haeger]", () => {
    const r = ruleForHost("haegerconsulting.atlassian.net");
    expect(r).toBeTruthy();
    expect(r!.action).toEqual({ kind: "open", containers: ["Haeger"] });
    expect(r!.match.length).toBe(4);
  });

  it("keeps outlook.cloud.microsoft as a choice (open [Haeger, HSP], no default)", () => {
    expect(ruleForHost("outlook.cloud.microsoft")?.action).toEqual({ kind: "open", containers: ["Haeger", "HSP"] });
  });

  it("has inherit / ignore / redirector rules", () => {
    const kinds = config.rules.map((r) => r.action.kind);
    expect(kinds).toContain("inherit");
    expect(kinds).toContain("ignore");
    expect(kinds).toContain("redirector");
  });

  it("tolerates youtube overlays and maps it to open [Temporary]", () => {
    expect(containers(ruleForHost("youtube.com")!.action)).toContain("Temporary");
  });

  it("parses the google and microsoft groups", () => {
    const hasHost = (g: { match: unknown[] }, h: string) => g.match.some((m) => hostOf(m) === h);
    expect(config.groups.some((g) => hasHost(g, "google.com") && hasHost(g, "youtube.com"))).toBe(true);
    expect(config.groups.some((g) => hasHost(g, "microsoft.com"))).toBe(true);
  });
});
