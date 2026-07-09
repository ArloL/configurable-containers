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
  const current = nav.current;
  if (current && current.container.kind === "temporary") {
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
        // Single-container open here; multi-open is added in Task 4.
        if (action.containers.length === 1) {
          if (action.containers[0] === TEMPORARY) return disposablePath(nav, config, deps);
          return toward(current, { kind: "permanent", name: action.containers[0] });
        }
        break; // multi-open falls through to Task 4's branch (not yet reachable by tests)
      }
    }
  }

  return disposablePath(nav, config, deps);
}
