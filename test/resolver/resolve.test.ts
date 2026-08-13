import { describe, it, expect } from "vitest";
import { resolve } from "../../src/resolver/resolve";
import {
  realMatchers,
  aConfigOf,
  aNavigation,
  aNavigationFromALinkOn,
  theDefaultContainer,
  aThrowaway,
  theContainerNamed,
} from "./helpers";
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

  // The mirror of the F2 guard: "already contained" is the container's identity, not its
  // kind. Comparing only the kind would answer "stay" for every permanent container there
  // is, and a rule would move a tab exactly once — the first time it left the default
  // container — and never again.
  it("single open reopens a tab that is in a *different* named container", () => {
    expect(resolve(
      aNavigation("https://mail.google.com/", { url: "https://mail.google.com/", container: theContainerNamed("Work") }, theContainerNamed("Work")),
      aConfigOf([gmail]), deps,
    )).toEqual({ kind: "reopen", into: { kind: "permanent", name: "Gmail" } });
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

  // The common inherit case, and the one where "already there" has no name to compare:
  // a same-tab hop inside the throwaway the initiator is browsing in. Two throwaways are
  // indistinguishable to the resolver, so a comparison that demanded an identity here
  // would reopen an SSO hop into a *second* throwaway and log the user out mid-flow.
  it("inherit stays in the throwaway the initiator is already browsing in", () => {
    expect(resolve(
      aNavigation("https://accounts.google.com/", { url: "https://x.com/", container: aThrowaway }, aThrowaway),
      aConfigOf([inheritGoogle]), deps,
    )).toEqual({ kind: "stay" });
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

  // `stay` for a redirector means *this tab, wherever it is* — not "wherever the click
  // came from". The distinction only shows when the two differ, which is precisely the
  // shim-in-another-container case: routing the hop would spend a reopen on a url the
  // user will never see, and the destination is decided one navigation later anyway.
  it("redirector stays put even when the initiator is somewhere else", () => {
    expect(resolve(
      aNavigation("https://t.co/abc", { url: "https://x.com/", container: theContainerNamed("Work") }, theContainerNamed("Personal")),
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

  // http is a browsed page like any other. Reading only https as one would send every
  // plain-http tab down the "nobody has browsed here yet" branch, where a throwaway is
  // kept no matter where the tab is going: one LAN box or one un-upgraded site, and a
  // throwaway would follow the user across the web.
  it("a plain-http page still answers the continuity question", () => {
    expect(resolve(
      aNavigation("https://imgur.com/", { url: "http://reddit.com/", container: aThrowaway }),
      aConfigOf(), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  // `view-source:https://reddit.com/` is the shape that makes the anchor load-bearing:
  // an unanchored test finds "https:" inside it and reads the tab as being ON reddit.com.
  // The tab is showing source, not browsing; there is nothing to compare, so it keeps the
  // container it is in rather than buying a throwaway off a comparison against a url
  // that names no page.
  it("a tab showing source is not read as a page on the site it prints", () => {
    expect(resolve(
      aNavigation("https://imgur.com/", { url: "view-source:https://reddit.com/", container: aThrowaway }),
      aConfigOf(), deps,
    )).toEqual({ kind: "stay" });
  });

  it("group members share continuity across registrable domains", () => {
    const cfg = aConfigOf([], [{ match: ["google.com", "youtube.com"] }]);
    expect(resolve(
      aNavigation("https://youtube.com/", { url: "https://google.com/", container: aThrowaway }),
      cfg, deps,
    )).toEqual({ kind: "stay" });
  });

  // An auto-temp tab sits on about:newtab in a fresh throwaway. The user's first
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

  // A link opened in a NEW tab. The tab has no page of its own, so `current` cannot
  // answer the continuity question — but the browser put it in the container of the page
  // the click came from, and that page can. Without this, "open in a new tab" answered
  // differently from clicking the same link in place: reported for a video opened from a
  // YouTube search result, which landed in a throwaway of its own and logged out.
  it("a link opened in a new tab keeps the throwaway it was clicked from, when same-site", () => {
    expect(resolve(
      aNavigationFromALinkOn({ url: "https://youtube.com/results", container: aThrowaway }, "https://youtube.com/watch?v=1"),
      aConfigOf(), deps,
    )).toEqual({ kind: "stay" });
  });

  it("a link opened in a new tab to another site still gets its own throwaway", () => {
    expect(resolve(
      aNavigationFromALinkOn({ url: "https://daringfireball.net/", container: aThrowaway }, "https://x.com/gruber"),
      aConfigOf(), deps,
    )).toEqual({ kind: "reopen", into: { kind: "temporary" } });
  });

  it("a link opened in a new tab keeps the throwaway across a group boundary", () => {
    const cfg = aConfigOf([], [{ match: ["google.com", "youtube.com"] }]);
    expect(resolve(
      aNavigationFromALinkOn({ url: "https://google.com/", container: aThrowaway }, "https://youtube.com/"),
      cfg, deps,
    )).toEqual({ kind: "stay" });
  });

  it("a link opened in a new tab from a PERMANENT container is isolated as before", () => {
    expect(resolve(
      aNavigationFromALinkOn({ url: "https://work.example/", container: theContainerNamed("Work") }, "https://work.example/wiki"),
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

// A rule is enforcement, not a preference: `resolve` consults `matchRule` before the
// disposable path, so a matched host leaves its throwaway even when everything the
// continuity checks look at says it could stay. Structurally true — these pin it, because
// swapping those two steps is a one-line change that no other case notices.
describe("resolve — a rule outranks continuity", () => {
  it("a matched rule switches container within the same registrable domain", () => {
    // www.google.com and mail.google.com are one site by every continuity test there is;
    // the Gmail rule must still take the hop out of the throwaway it was browsed in.
    expect(resolve(
      aNavigation("https://mail.google.com/", { url: "https://www.google.com/", container: aThrowaway }),
      aConfigOf([gmail]), deps,
    )).toEqual({ kind: "reopen", into: { kind: "permanent", name: "Gmail" } });
  });

  it("a group does not override an open rule", () => {
    // The mirror of the above for groups: youtube.com and mail.google.com share a group
    // and nothing else, so the group is the only thing that could have said "stay".
    const cfg = aConfigOf([gmail], [{ match: ["google.com", "youtube.com"] }]);
    expect(resolve(
      aNavigation("https://mail.google.com/", { url: "https://youtube.com/", container: aThrowaway }),
      cfg, deps,
    )).toEqual({ kind: "reopen", into: { kind: "permanent", name: "Gmail" } });
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
