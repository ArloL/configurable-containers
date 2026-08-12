import type { Config, ContainerRef, Decision, Deps, NavContext } from "./types";
import { TEMPORARY } from "./types";

// Do two container references denote the same container? Temporary throwaways carry
// no identity in L1, so any two temporaries compare equal — the common inherit case
// is a same-tab hop where `current` already IS the initiator's throwaway.
function alreadyThere(current: ContainerRef | null, desired: ContainerRef): boolean {
  if (!current || current.kind !== desired.kind) return false;
  if (current.kind === "permanent" && desired.kind === "permanent") {
    return current.name === desired.name;
  }
  return true; // default==default, temporary==temporary
}

// Reopen into `desired` unless already there. ContainerRef is structurally a Target.
function toward(current: ContainerRef | null, desired: ContainerRef): Decision {
  return alreadyThere(current, desired) ? { kind: "stay" } : { kind: "reopen", into: desired };
}

// Disposable path (spec §4 step 7): keep the current throwaway iff it exists and the
// nav stays within the same registrable domain or the same group; else fresh temp.
function disposablePath(nav: NavContext, config: Config, deps: Deps): Decision {
  // Which throwaway session, if any, does this navigation belong to? The page the tab is
  // on — or, for a tab the browser opened FOR a link and put in the clicked page's
  // container, that page. Both name a container the tab is ALREADY in, which is what
  // makes "stay" a decision the engine performs by doing nothing.
  //
  // Without the second half, "open link in a new tab" answered differently from clicking
  // the same link in place: the new tab has no page of its own, so every one of them —
  // including a link to the site the click came from — bought a throwaway of its own and
  // opened logged out. Reported for a YouTube search result opening a video.
  const current = nav.current ?? nav.inheritedFrom;
  if (current && current.container.kind === "temporary") {
    // A throwaway the user has not browsed in yet — auto-temp puts every new tab in
    // one, sitting on about:newtab / about:home. Its first navigation belongs here:
    // there is no earlier site to isolate it from, and the comparisons below have
    // nothing meaningful to compare against (no registrable domain, no group), so
    // they would strand the tab in a second, pointless temporary.
    if (!/^https?:/.test(current.url)) return { kind: "stay" };

    const sameSite = deps.sameSite(current.url, nav.targetUrl);
    const gA = deps.matchGroup(current.url, config.groups);
    const gB = deps.matchGroup(nav.targetUrl, config.groups);
    const sameGroup = gA !== null && gA === gB;
    if (sameSite || sameGroup) return { kind: "stay" };
  }
  return { kind: "reopen", into: { kind: "temporary" } };
}

export function resolve(nav: NavContext, config: Config, deps: Deps): Decision {
  const rule = deps.matchRule(nav.targetUrl, config.rules);
  const current = nav.current?.container ?? null;

  if (rule) {
    const action = rule.action;
    switch (action.kind) {
      case "ignore":
        return { kind: "leaveAlone" };

      case "redirector":
        return { kind: "stay" }; // hop is not isolated

      case "inherit": {
        const desired: ContainerRef = nav.initiator ?? current ?? { kind: "default" };
        return toward(current, desired);
      }

      case "open": {
        const { containers, default: def } = action;

        // Single container.
        if (containers.length === 1) {
          if (containers[0] === TEMPORARY) return disposablePath(nav, config, deps);
          return toward(current, { kind: "permanent", name: containers[0] });
        }

        // Multi-open: already in an eligible (permanent) container -> stay.
        if (current && current.kind === "permanent" && containers.includes(current.name)) {
          return { kind: "stay" };
        }
        // A configured default decides automatically.
        if (def !== undefined) {
          if (def === TEMPORARY) return disposablePath(nav, config, deps);
          return toward(current, { kind: "permanent", name: def });
        }
        // No default -> choice screen over the configured containers.
        return { kind: "choice", options: containers };
      }
    }
  }

  return disposablePath(nav, config, deps);
}
