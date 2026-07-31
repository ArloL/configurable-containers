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
    // What this pins is that SEVERAL unrelated hosts collapse onto ONE curated
    // container name — not how many. The exact host list is config churn (adding a
    // work domain is not a parser regression), so an `=== 4` here just fails CI on
    // every edit; assert the shape and a host that must not silently drop out.
    expect(r!.match.length).toBeGreaterThan(1);
    expect(r!.match.map(hostOf)).toContain("haeger-consulting.atlassian.net");
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

  it("parses the youtube cookie overlays from the real config", () => {
    const cookies = ruleForHost("youtube.com")?.cookies;
    expect(cookies?.map((c) => c.name)).toEqual(["wide", "SOCS"]);
    expect(cookies?.[1]).toMatchObject({ name: "SOCS", secure: true, sameSite: "lax" });
  });

  it("parses the youtube script overlays from the real config", () => {
    const scripts = ruleForHost("youtube.com")?.scripts ?? [];
    // Identified by what each one does, not by position: adding a third overlay should
    // not fail this, and reordering the two should not either.
    expect(scripts.some((s) => s.run.includes("yt-player-sticky-caption"))).toBe(true);
    expect(scripts.some((s) => s.run.includes("getAvailableAudioTracks"))).toBe(true);
    for (const s of scripts) expect(s.at).toBe("document_start");
  });

  // The audio-track snippet is the one overlay written as a YAML block scalar.
  // Re-indenting or reflowing that block is an edit that looks harmless in YAML and
  // yields JavaScript the page cannot run — and nothing reports it, because the
  // injected script fails silently and the only symptom is a video playing German.
  it("keeps the multi-line audio snippet valid javascript", () => {
    const run = ruleForHost("youtube.com")!.scripts!.find((s) =>
      s.run.includes("getAvailableAudioTracks"),
    )!.run;
    expect(run.split("\n").length).toBeGreaterThan(1);
    expect(() => new Function(run)).not.toThrow();
  });

  it("parses the google and microsoft groups", () => {
    const hasHost = (g: { match: unknown[] }, h: string) => g.match.some((m) => hostOf(m) === h);
    expect(config.groups.some((g) => hasHost(g, "google.com") && hasHost(g, "youtube.com"))).toBe(true);
    expect(config.groups.some((g) => hasHost(g, "microsoft.com"))).toBe(true);
  });
});
