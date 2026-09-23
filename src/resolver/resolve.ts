import type { Action, Config, ContainerRef, Decision, Deps, NavContext } from "./types";
import { TEMPORARY } from "./types";

// Do two references denote the same container? Throwaways carry no identity in L1, so any
// two temporaries compare equal — the common inherit case is a same-tab hop where `current`
// already IS the initiator's throwaway.
function alreadyThere(current: ContainerRef | null, desired: ContainerRef): boolean {
  if (desired.kind === "permanent") {
    return current?.kind === "permanent" && current.name === desired.name;
  }
  return current?.kind === desired.kind;
}

// ContainerRef is structurally a Target, which is why `desired` needs no conversion.
function toward(current: ContainerRef | null, desired: ContainerRef): Decision {
  return alreadyThere(current, desired) ? { kind: "stay" } : { kind: "reopen", into: desired };
}

// The disposable path — spec §4 step 7.
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
    if (sameSite || inOneGroup(current.url, nav.targetUrl, config, deps)) return { kind: "stay" };
  }
  return { kind: "reopen", into: { kind: "temporary" } };
}

function inOneGroup(a: string, b: string, config: Config, deps: Deps): boolean {
  const g = deps.matchGroup(a, config.groups);
  return g !== null && g === deps.matchGroup(b, config.groups);
}

// A navigation no rule matches. A group says its hosts may share a session, and the
// disposable path honours that between throwaways; this honours it in a NAMED container
// too, which is where the session usually is. Jira in `Work` linking to the Atlassian
// profile on `home.atlassian.com` belongs in `Work` — a throwaway lands logged out.
//
// Unmatched only, never an `open: Temporary` rule: that rule says the host must be in SOME
// throwaway, and the group that lets YouTube keep a Google login in one must not carry
// YouTube into the Gmail container. A group only, never mere same-site: a group is
// declared, a registrable domain inferred, and `*.personio.com` is every Personio customer.
// A named container only: the default one is where a tab is before anything routed it.
function unmatched(nav: NavContext, config: Config, deps: Deps): Decision {
  const from = nav.current ?? nav.inheritedFrom;
  if (from?.container.kind === "permanent" && inOneGroup(from.url, nav.targetUrl, config, deps)) {
    return { kind: "stay" };
  }
  return disposablePath(nav, config, deps);
}

// `open:` is two actions wearing one key. With one container it names a target; with
// several it names an ELIGIBILITY SET, which a tab can already satisfy — and being in one
// of them outranks `default`, since the user put it there.
function openAction(
  action: Extract<Action, { kind: "open" }>,
  contained: ContainerRef | null,
  nav: NavContext,
  config: Config,
  deps: Deps,
): Decision {
  const { containers, default: def } = action;

  if (containers.length === 1) {
    if (containers[0] === TEMPORARY) return disposablePath(nav, config, deps);
    return toward(contained, { kind: "permanent", name: containers[0] });
  }

  if (contained?.kind === "permanent" && containers.includes(contained.name)) {
    return { kind: "stay" };
  }
  if (def !== undefined) {
    if (def === TEMPORARY) return disposablePath(nav, config, deps);
    return toward(contained, { kind: "permanent", name: def });
  }
  return { kind: "choice", options: containers };
}

export function resolve(nav: NavContext, config: Config, deps: Deps): Decision {
  const rule = deps.matchRule(nav.targetUrl, config.rules);

  // WHERE THE TAB IS, which is not the same question as what page it is on. A tab the
  // browser opened for a click has no page of its own, so `current` is null — but Firefox
  // has already put it in the opener's container, and `inheritedFrom` names it. Every
  // "already where the rule wants it?" test below reads this, or such a tab is treated as
  // being nowhere: a sign-in popup asked which container to open in while sitting in the
  // right one, and `inherit` sent it to the default container for want of an initiator.
  //
  // `current` still answers separately, because the two disagree on purpose: the disposable
  // path needs the SITE the tab was on, and the opener's page is not it.
  const contained = nav.current?.container ?? nav.inheritedFrom?.container ?? null;

  // No rule is the founding premise rather than a fallthrough: anything unmatched is
  // disposable, unless a group keeps it in the named container it is leaving.
  if (!rule) return unmatched(nav, config, deps);

  const action = rule.action;
  switch (action.kind) {
    case "ignore":
      return { kind: "leaveAlone" };

    case "redirector":
      return { kind: "stay" }; // hop is not isolated

    case "inherit":
      return toward(contained, nav.initiator ?? contained ?? { kind: "default" });

    case "open":
      return openAction(action, contained, nav, config, deps);
  }
}
