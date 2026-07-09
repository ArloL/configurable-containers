import { describe, it, expect } from "vitest";
import { resolve } from "../../src/resolver/resolve";
import { makeDeps, config, nav, def, temp, perm } from "./helpers";
import type { Rule } from "../../src/resolver/types";

const deps = makeDeps();

const gmail: Rule = { match: ["mail.google.com"], action: { kind: "open", containers: ["Gmail"] } };
const inheritGoogle: Rule = { match: ["accounts.google.com"], action: { kind: "inherit" } };
const ignorePocket: Rule = { match: ["getpocket.com"], action: { kind: "ignore" } };
const redirTco: Rule = { match: ["t.co"], action: { kind: "redirector" } };
const pinterestTemp: Rule = { match: ["pinterest.com"], action: { kind: "open", containers: ["Temporary"] } };

describe("resolve — exemptions & single open", () => {
  it("single open reopens a blank tab into the named container", () => {
    expect(resolve(nav("https://mail.google.com/"), config([gmail]), deps))
      .toEqual({ kind: "reopen", into: { kind: "permanent", name: "Gmail" } });
  });

  it("single open stays when already in the target container (F2 guard)", () => {
    expect(resolve(
      nav("https://mail.google.com/", { url: "https://mail.google.com/", container: perm("Gmail") }),
      config([gmail]), deps,
    )).toEqual({ kind: "stay" });
  });

  it("inherit keeps the initiating container", () => {
    expect(resolve(
      nav("https://accounts.google.com/", { url: "https://x.com/", container: perm("Work") }, perm("Work")),
      config([inheritGoogle]), deps,
    )).toEqual({ kind: "stay" });
  });

  it("inherit reopens into the initiator when the tab is elsewhere", () => {
    expect(resolve(
      nav("https://accounts.google.com/", { url: "https://x.com/", container: def }, perm("Work")),
      config([inheritGoogle]), deps,
    )).toEqual({ kind: "reopen", into: { kind: "permanent", name: "Work" } });
  });

  it("inherit from a blank tab with no initiator resolves to default", () => {
    expect(resolve(nav("https://accounts.google.com/"), config([inheritGoogle]), deps))
      .toEqual({ kind: "reopen", into: { kind: "default" } });
  });

  it("ignore leaves the tab alone", () => {
    expect(resolve(
      nav("https://getpocket.com/", { url: "https://x.com/", container: perm("Work") }, perm("Work")),
      config([ignorePocket]), deps,
    )).toEqual({ kind: "leaveAlone" });
  });

  it("redirector does not isolate the hop (stays in current)", () => {
    expect(resolve(
      nav("https://t.co/abc", { url: "https://x.com/", container: temp }, temp),
      config([redirTco]), deps,
    )).toEqual({ kind: "stay" });
  });
});

describe("resolve — disposable path + continuity", () => {
  it("unmatched blank tab opens a fresh temporary", () => {
    expect(resolve(nav("https://reddit.com/"), config(), deps))
      .toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("same registrable domain keeps the current temporary", () => {
    expect(resolve(
      nav("https://old.reddit.com/", { url: "https://reddit.com/", container: temp }),
      config(), deps,
    )).toEqual({ kind: "stay" });
  });

  it("different site isolates into a new temporary", () => {
    expect(resolve(
      nav("https://imgur.com/", { url: "https://reddit.com/", container: temp }),
      config(), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("group members share continuity across registrable domains", () => {
    const cfg = config([], [{ match: ["google.com", "youtube.com"] }]);
    expect(resolve(
      nav("https://youtube.com/", { url: "https://google.com/", container: temp }),
      cfg, deps,
    )).toEqual({ kind: "stay" });
  });

  it("open:Temporary from a permanent container isolates", () => {
    expect(resolve(
      nav("https://pinterest.com/", { url: "https://work.example/", container: perm("Work") }, perm("Work")),
      config([pinterestTemp]), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });
});

describe("resolve — multi-open", () => {
  const withDefault: Rule = {
    match: ["trello.com"],
    action: { kind: "open", containers: ["Personal", "Work"], default: "Work" },
  };
  const noDefault: Rule = {
    match: ["figma.com"],
    action: { kind: "open", containers: ["Personal", "Work"] },
  };
  const tempDefault: Rule = {
    match: ["youtube.com"],
    action: { kind: "open", containers: ["Temporary", "Personal"], default: "Temporary" },
  };

  it("multi-open with default auto-opens the default", () => {
    expect(resolve(nav("https://trello.com/"), config([withDefault]), deps))
      .toEqual({ kind: "reopen", into: { kind: "permanent", name: "Work" } });
  });

  it("multi-open stays when already in an eligible container", () => {
    expect(resolve(
      nav("https://figma.com/", { url: "https://figma.com/", container: perm("Work") }),
      config([noDefault]), deps,
    )).toEqual({ kind: "stay" });
  });

  it("multi-open without default shows a choice screen", () => {
    expect(resolve(nav("https://figma.com/"), config([noDefault]), deps))
      .toEqual({ kind: "choice", options: ["Personal", "Work"] });
  });

  it("multi-open default:Temporary takes the disposable path", () => {
    expect(resolve(
      nav("https://youtube.com/", { url: "https://work.example/", container: perm("Work") }, perm("Work")),
      config([tempDefault]), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("multi-open default:Temporary honours group continuity (age gate)", () => {
    const cfg = config([tempDefault], [{ match: ["google.com", "youtube.com"] }]);
    expect(resolve(
      nav("https://youtube.com/", { url: "https://accounts.google.com/", container: temp }),
      cfg, deps,
    )).toEqual({ kind: "stay" });
  });
});
