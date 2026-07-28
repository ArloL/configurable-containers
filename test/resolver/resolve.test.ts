import { describe, it, expect } from "vitest";
import { resolve } from "../../src/resolver/resolve";
import { realMatchers, aConfigOf, aNavigation, theDefaultContainer, aThrowaway, theContainerNamed } from "./helpers";
import type { Rule } from "../../src/resolver/types";

const deps = realMatchers();

const gmail: Rule = { match: ["mail.google.com"], action: { kind: "open", containers: ["Gmail"] } };
const inheritGoogle: Rule = { match: ["accounts.google.com"], action: { kind: "inherit" } };
const ignorePocket: Rule = { match: ["getpocket.com"], action: { kind: "ignore" } };
const redirTco: Rule = { match: ["t.co"], action: { kind: "redirector" } };
const pinterestTemp: Rule = { match: ["pinterest.com"], action: { kind: "open", containers: ["Temporary"] } };

describe("resolve — exemptions & single open", () => {
  it("single open reopens a blank tab into the named container", () => {
    expect(resolve(aNavigation("https://mail.google.com/"), aConfigOf([gmail]), deps))
      .toEqual({ kind: "reopen", into: { kind: "permanent", name: "Gmail" } });
  });

  it("single open stays when already in the target container (F2 guard)", () => {
    expect(resolve(
      aNavigation("https://mail.google.com/", { url: "https://mail.google.com/", container: theContainerNamed("Gmail") }),
      aConfigOf([gmail]), deps,
    )).toEqual({ kind: "stay" });
  });

  it("inherit keeps the initiating container", () => {
    expect(resolve(
      aNavigation("https://accounts.google.com/", { url: "https://x.com/", container: theContainerNamed("Work") }, theContainerNamed("Work")),
      aConfigOf([inheritGoogle]), deps,
    )).toEqual({ kind: "stay" });
  });

  it("inherit reopens into the initiator when the tab is elsewhere", () => {
    expect(resolve(
      aNavigation("https://accounts.google.com/", { url: "https://x.com/", container: theDefaultContainer }, theContainerNamed("Work")),
      aConfigOf([inheritGoogle]), deps,
    )).toEqual({ kind: "reopen", into: { kind: "permanent", name: "Work" } });
  });

  it("inherit from a blank tab with no initiator resolves to default", () => {
    expect(resolve(aNavigation("https://accounts.google.com/"), aConfigOf([inheritGoogle]), deps))
      .toEqual({ kind: "reopen", into: { kind: "default" } });
  });

  it("ignore leaves the tab alone", () => {
    expect(resolve(
      aNavigation("https://getpocket.com/", { url: "https://x.com/", container: theContainerNamed("Work") }, theContainerNamed("Work")),
      aConfigOf([ignorePocket]), deps,
    )).toEqual({ kind: "leaveAlone" });
  });

  it("redirector does not isolate the hop (stays in current)", () => {
    expect(resolve(
      aNavigation("https://t.co/abc", { url: "https://x.com/", container: aThrowaway }, aThrowaway),
      aConfigOf([redirTco]), deps,
    )).toEqual({ kind: "stay" });
  });
});

describe("resolve — disposable path + continuity", () => {
  it("unmatched blank tab opens a fresh temporary", () => {
    expect(resolve(aNavigation("https://reddit.com/"), aConfigOf(), deps))
      .toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("same registrable domain keeps the current temporary", () => {
    expect(resolve(
      aNavigation("https://old.reddit.com/", { url: "https://reddit.com/", container: aThrowaway }),
      aConfigOf(), deps,
    )).toEqual({ kind: "stay" });
  });

  it("different site isolates into a new temporary", () => {
    expect(resolve(
      aNavigation("https://imgur.com/", { url: "https://reddit.com/", container: aThrowaway }),
      aConfigOf(), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("group members share continuity across registrable domains", () => {
    const cfg = aConfigOf([], [{ match: ["google.com", "youtube.com"] }]);
    expect(resolve(
      aNavigation("https://youtube.com/", { url: "https://google.com/", container: aThrowaway }),
      cfg, deps,
    )).toEqual({ kind: "stay" });
  });

  // An auto-aThrowaway tab sits on about:newtab in a fresh throwaway. The user's first
  // navigation belongs in that container — there is no earlier site to isolate it
  // from, and reopening would strand the tab in a second, pointless temporary.
  it("the first navigation from a new-tab page keeps its temporary", () => {
    expect(resolve(
      aNavigation("https://kottke.org/", { url: "about:newtab", container: aThrowaway }),
      aConfigOf(), deps,
    )).toEqual({ kind: "stay" });
  });

  it("the first navigation from about:home keeps its temporary", () => {
    expect(resolve(
      aNavigation("https://kottke.org/", { url: "about:home", container: aThrowaway }),
      aConfigOf(), deps,
    )).toEqual({ kind: "stay" });
  });

  it("a *permanent* container on a new-tab page is not affected", () => {
    expect(resolve(
      aNavigation("https://kottke.org/", { url: "about:newtab", container: theContainerNamed("Work") }, theContainerNamed("Work")),
      aConfigOf(), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("open:Temporary from a permanent container isolates", () => {
    expect(resolve(
      aNavigation("https://pinterest.com/", { url: "https://work.example/", container: theContainerNamed("Work") }, theContainerNamed("Work")),
      aConfigOf([pinterestTemp]), deps,
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
    expect(resolve(aNavigation("https://trello.com/"), aConfigOf([withDefault]), deps))
      .toEqual({ kind: "reopen", into: { kind: "permanent", name: "Work" } });
  });

  it("multi-open stays when already in an eligible container", () => {
    expect(resolve(
      aNavigation("https://figma.com/", { url: "https://figma.com/", container: theContainerNamed("Work") }),
      aConfigOf([noDefault]), deps,
    )).toEqual({ kind: "stay" });
  });

  it("multi-open without default shows a choice screen", () => {
    expect(resolve(aNavigation("https://figma.com/"), aConfigOf([noDefault]), deps))
      .toEqual({ kind: "choice", options: ["Personal", "Work"] });
  });

  it("multi-open default:Temporary takes the disposable path", () => {
    expect(resolve(
      aNavigation("https://youtube.com/", { url: "https://work.example/", container: theContainerNamed("Work") }, theContainerNamed("Work")),
      aConfigOf([tempDefault]), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("multi-open default:Temporary honours group continuity (age gate)", () => {
    const cfg = aConfigOf([tempDefault], [{ match: ["google.com", "youtube.com"] }]);
    expect(resolve(
      aNavigation("https://youtube.com/", { url: "https://accounts.google.com/", container: aThrowaway }),
      cfg, deps,
    )).toEqual({ kind: "stay" });
  });
});
