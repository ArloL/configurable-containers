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

const config = parseConfig(DEFAULT_YAML);

function actionFor(url: string) {
  const rule = matchRule(url, config.rules);
  expect(rule, `no rule matched ${url}`).not.toBeNull();
  return rule!.action;
}

describe("the shipped default config", () => {
  it("parses", () => {
    expect(() => parseConfig(DEFAULT_YAML)).not.toThrow();
  });

  // THE guard on this file. It ships to strangers, so a rule may only ever *exempt* a
  // host — an exemption can fail to isolate, but it can never put a site's data into a
  // named container the user did not ask for. The moment a shipped rule opens one,
  // that promise is gone, so the check is over every rule rather than a fixed list.
  it("only ever exempts — no shipped rule opens a container", () => {
    expect(config.rules.length).toBeGreaterThan(0);
    for (const rule of config.rules) {
      expect(["ignore", "redirector", "inherit"]).toContain(rule.action.kind);
    }
  });

  it("leaves an ordinary site unmatched, so it opens in a throwaway", () => {
    expect(matchRule("https://example.com/", config.rules)).toBeNull();
    expect(matchRule("https://github.com/", config.rules)).toBeNull();
  });

  it("keeps an SSO hop in the container that initiated it", () => {
    expect(actionFor("https://accounts.google.com/signin")).toEqual({ kind: "inherit" });
    expect(actionFor("https://login.microsoftonline.com/common/oauth2/authorize"))
      .toEqual({ kind: "inherit" });
  });

  // Bare hosts cover subdomains (matcher.ts: h === host || h.endsWith("." + host)),
  // which is the whole reason `okta.com` is enough to cover every customer tenant.
  it("covers per-tenant identity hosts through the bare-host shorthand", () => {
    expect(actionFor("https://acme.okta.com/app/signin")).toEqual({ kind: "inherit" });
    expect(actionFor("https://acme.auth0.com/authorize")).toEqual({ kind: "inherit" });
  });

  it("leaves the add-on store and the Firefox account alone entirely", () => {
    expect(actionFor("https://addons.mozilla.org/en-US/firefox/")).toEqual({ kind: "ignore" });
    expect(actionFor("https://accounts.firefox.com/signin")).toEqual({ kind: "ignore" });
  });

  it("treats known link shims as redirectors", () => {
    expect(actionFor("https://t.co/abc123")).toEqual({ kind: "redirector" });
    expect(actionFor("https://l.facebook.com/l.php?u=x")).toEqual({ kind: "redirector" });
  });

  // Pocket shut down in July 2025. TCP's IGNORED_DOMAINS_DEFAULT still carries it; we
  // deliberately do not, so a new reader has one less dead claim to evaluate.
  it("does not carry TCP's stale getpocket.com ignore", () => {
    expect(DEFAULT_YAML).not.toContain("getpocket.com");
  });

  it("ships no groups — isolation continuity is the user's call", () => {
    expect(config.groups).toEqual([]);
  });

  it("documents the syntax a new user needs", () => {
    expect(DEFAULT_YAML).toContain("rules:");
    expect(DEFAULT_YAML).toContain("match:");
    expect(DEFAULT_YAML).toContain("open:");
    expect(DEFAULT_YAML).toContain("groups:");
  });
});
