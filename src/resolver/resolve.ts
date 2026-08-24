import type { Config, ContainerRef, Decision, Deps, NavContext } from "./types";
import { TEMPORARY } from "./types";

// Do two references denote the same container? Throwaways carry no identity in L1, so any
// two temporaries compare equal — the common inherit case is a same-tab hop where `current`
// already IS the initiator's throwaway.
function alreadyThere(current: ContainerRef | null, desired: ContainerRef): boolean {
  if (desired.kind === "permanent") {
    return current?.kind === "permanent" && current.name === desired.name;
  }
  return current?.kind === desired.kind; // default==default, temporary==temporary
}

// Reopen into `desired` unless already there. ContainerRef is structurally a Target.
function toward(current: ContainerRef | null, desired: ContainerRef): Decision {
  return alreadyThere(current, desired) ? { kind: "stay" } : { kind: "reopen", into: desired };
}

// Disposable path (spec §4 step 7): keep the current throwaway if the navigation stays
// within the same registrable domain or group; otherwise a fresh one.
function disposablePath(nav: NavContext, config: Config, deps: Deps): Decision {
  // Which throwaway session does this navigation belong to? The page the tab is on — or,
  // for a tab the browser opened FOR a link, the page that link was on. Both name a
  // container the tab is ALREADY in, which is what makes "stay" a decision performed by
  // doing nothing.
  //
  // Without the second half, "open link in a new tab" answered differently from clicking in
  // place: a new tab has no page of its own, so every one of them, even a link back to the
  // site it came from, bought a throwaway and opened logged out.
  const current = nav.current ?? nav.inheritedFrom;
  if (current && current.container.kind === "temporary") {
    // A throwaway nobody has browsed in yet — auto-temp puts every new tab in one, on
    // about:newtab / about:home. Its first navigation belongs here: there is no earlier
    // site to isolate it from, and the comparisons below have nothing to compare against,
    // so they would strand the tab in a second, pointless throwaway.
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
        if (current?.kind === "permanent" && containers.includes(current.name)) {
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
