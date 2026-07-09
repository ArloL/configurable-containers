# Configuration

This document is the design of the user configuration. It is a snapshot of
decisions made so far; open questions are collected at the end. The config
**format** (YAML / JSON / JSON5 / TOML) is not yet chosen — examples use YAML for
readability, and a bare hostname is shorthand for `*://*.<host>/*`.

See [`configurable-containers.config.yaml`](configurable-containers.config.yaml)
for the author's real config, generated from Multi-Account Containers + Temporary
Containers exports.

## What the config is (and isn't)

- **Two top-level lists.** `rules` map sites to containers and `groups` declare
  isolation-continuity sets (see [Groups](#groups-isolation-continuity)). A rule
  may additionally carry two optional overlay keys — `cookies` and `scripts` —
  which carry over per-domain conveniences from the previous Temporary
  Containers setup (see [Overlays](#overlays-cookies--scripts)). There is no separate
  container-definition block: containers are named by the rules that target them.
- **Routing-first, not a container manifest.** The core job is mapping sites to
  containers; it does **not** own container lifecycle. A container is created on
  demand the first time a rule routes to its name; a container that no rule
  mentions is left untouched (never managed, never deleted). **A container's name
  is its identity** — renaming a target creates a new, empty container and
  strands the old one's cookies. The overlay keys act *within* whatever
  container a tab is already in and never move identity across one.
- **Temporary by default.** Anything no rule matches opens in a fresh
  **Temporary** container. This is the founding premise, so there is no
  `default:` for it — stating it would be redundant.
- **Text-edited.** The config is edited as text through a simple editor built
  into the extension. There is no form-based settings UI.

## The rule

Every rule is a `match` plus **at most one** action:

| Action          | Meaning                                                                        |
|-----------------|--------------------------------------------------------------------------------|
| *(none)*        | Open in a container **named after the host** (the **first** host when `match` is a list). |
| `open: X`       | Open matching sites in container `X` (a name that differs from the host).        |
| `open: [A, B]`  | Eligible containers. With `default:` one auto-opens; without, a choice screen. |
| `inherit: true` | Never route on its own; stay in the container that initiated the navigation.    |
| `ignore: true`  | Engine does nothing: no routing, isolation, or side-effects — leave the tab as-is. |
| `redirector: true` | Transient link shim: don't isolate the hop; auto-close the tab if it's left stranded on the shim after redirecting. |

Isolation-continuity sets are **not** a rule action; they live in a separate
top-level `groups` list (see [Groups](#groups-isolation-continuity)).

A rule may also carry the `cookies` / `scripts` **overlay keys** alongside its
action. Overlays are not actions: they never decide the container, only apply a
within-container side-effect once routing has happened (see
[Overlays](#overlays-cookies--scripts)). They may accompany any action except
`ignore`, whose contract is that the engine does nothing at all.

A rule with **no action** is the common case: `- match: wohnsinn.com` opens in a
container called `wohnsinn.com`. When `match` is a list of plain hostnames the
container is named after the **first** one, so `- match: [notion.com, notion.so]`
opens in `notion.com` — later hosts are additional matchers, not names. Use
`open:` only to give the container a name that differs from that host (`Gmail`
rather than `mail.google.com`, `Atlassian` rather than `atlassian.com`), or to
target a shared container. Auto-naming needs a plain-hostname `match` — a pattern
or regex match has no host to name the container after, so it needs `open:`.

`default:` (optional, only with a multi-value `open`) names which listed container
auto-opens; the others become manual **switch / reopen** targets. Omit it to get a
choice screen instead.

**`Temporary` is a reserved value**, not a container you define. It may appear
anywhere a container name is accepted (`open: Temporary`, `open: [Temporary, X]`,
`default: Temporary`) and means "a fresh throwaway container." You cannot create a
permanent container named `Temporary`.

"Fresh" is relative to a **site boundary**, not to every navigation. A rule that
resolves to `Temporary` behaves exactly like the unmatched path for isolation:
staying within the same registrable domain (or the same `group`) keeps the
current temporary container, and only crossing a real boundary spins up a new
one (see [mechanism 2](#resolution-engine)). Without this, clicking around an
`open: Temporary` site would churn a new throwaway per click.

```yaml
rules:
  - match: github.com
    open: GitHub                    # single container

  - match: trello.com
    open: [Personal, Work]
    default: Work                   # auto-open Work; Personal is a switch target

  - match: figma.com
    open: [Personal, Work]          # no default -> choice screen every entry

  - match: youtube.com
    open: [Temporary, Personal]
    default: Temporary              # disposable by default; escalate to Personal

  - match: accounts.google.com
    inherit: true                   # SSO: stay in whoever initiated

groups:
  - [google.com, youtube.com]       # one site for temp continuity
```

## Matching

`match` is deliberately flexible (the audience edits config directly). It matches
against the **full URL** — scheme, host, path, query — so path-based routing is
possible. Three forms, plus lists:

```yaml
- match: company.com                          # shorthand -> *://*.company.com/*
- match: "https://app.example.com/work/*"     # WebExtension match pattern
- match: { regex: "^https://(app|api)\\.x\\.com/" }   # regex escape hatch
- match: [trello.com, "https://*.atlassian.net/*"]    # any-of list
```

**First match wins**; order is significant. Put specific matches above broad ones.
This applies **independently to each list**: the first matching `rule` decides
routing, and the first matching `group` decides membership (see
[Groups](#groups-isolation-continuity)). The two lists never shadow one another —
a domain can match a `rule` and a `group` at the same time, and both are honoured.

### "Same site" is the registrable domain, via the Public Suffix List

Temporary same-site continuity (mechanism 2 below) asks, on every unmatched
navigation, "are these two URLs the same site?" **Same site** is the **registrable
domain** (eTLD+1) from the **Public Suffix List** — not a naive last-two-labels
guess. This is mandatory, not a preference: on the disposable path, naive matching
treats every `*.co.uk` (and `com.au`, `co.jp`, …) as one site, so browsing
`bbc.co.uk` then `theguardian.co.uk` would wrongly *keep the same throwaway* and
share its cookies across unrelated sites. Only the PSL knows where the public
suffix ends. (The bare-host shorthand is separate: `bandcamp.com` expands to the
literal subtree `*://*.bandcamp.com/*` and doesn't consult the PSL — it merely
happens to cover "the whole site" when the host you write is already the
registrable domain.)

**Decision: honour the PSL's *private* section too** (not ICANN-only). The private
section lists company-operated suffixes like `github.io`, `vercel.app`,
`*.blogspot.com`, `*.myshopify.com`. Including it means `foo.github.io` and
`bar.github.io` resolve to **different** sites and never share a throwaway — the
more correct isolation, which is what we want by default. A PSL snapshot is bundled
at build time and refreshed on a cadence.

## Resolution engine

Every top-level (`main_frame`) navigation is evaluated fresh. Three mechanisms, in
order:

1. **Rule match — enforced on every navigation.** If the target matches a rule,
   its container is enforced (the tab is reopened there if it isn't already). This
   is *not* subject to any "same site" continuity: a rule's reach is exactly what
   its `match` covers. Navigating `www.google.com` (unmanaged) → `mail.google.com`
   (→ Gmail) switches into Gmail. Registrable domain is irrelevant here.
   Exception: when the resolved container is the reserved `Temporary`,
   enforcement means "must be in *some* temporary container" — *which* one is
   mechanism 2's continuity decision.

2. **Temporary isolation — same-site continuity.** For navigation matching no
   rule — or matching a rule that resolves to `Temporary` — (together, the
   disposable path), a *new* temporary container is created only on
   cross-site navigation. Staying within the same registrable domain (PSL-derived —
   see [Same site](#same-site-is-the-registrable-domain-via-the-public-suffix-list))
   — or within a declared `group` — keeps the current temporary container, so
   moving around an unmanaged site doesn't churn throwaways. Mirrors Temporary
   Containers' `notsamedomain` isolation.

3. **Explicit exemptions (`inherit` / `ignore` / `redirector`).** Exempt from both
   above. `inherit: true` keeps the tab in whichever container *initiated* the
   navigation — the SSO mechanism; the navigation is otherwise handled normally
   (rule overlays still apply). `ignore: true` goes further: the engine does
   **nothing** — no routing, no isolation, no overlays, and the domain is not treated
   as a "site" for continuity — the tab is simply left where it is.
   `redirector: true` marks a transient link shim (`t.co`, `slack-redir.net`): the
   hop is not isolated (like `inherit`), and the tab is **auto-closed** if — after a
   short delay (~2s) — it is *still stranded on the shim domain*. The stranding is
   the case `inherit` alone can't clean up: when the destination is reopened into
   another container (a **permanent**-container route, not just a temp), that reopen
   doesn't dispose the shim tab, so it lingers on `t.co`. The close is **conditional
   on still being on the shim** — a tab that redirected onward in-place to a real
   destination is left alone, so a successful in-tab navigation is never killed. Use
   `inherit` to carry identity across an auth hop, `ignore` for plumbing domains you
   never want the engine to touch (`getpocket.com`, `addons.mozilla.org`), and
   `redirector` for pass-through shims.

There is deliberately **no automatic "inherit the container I came from"** for
unmarked domains. A link from a permanent container to an unmanaged domain lands
in a fresh temporary container, for isolation. The accepted cost: SSO / auth /
payment-redirect domains break until configured as `inherit` — which is already
the workflow (Temporary Containers keeps an equivalent exclusion list by hand).
There is **no auth-flow auto-detection**; the sole user knows which domains need
`inherit`.

## Choice screen and reopen picker

- A **choice screen** appears when a multi-`open` rule (without `default`) resolves
  and the tab is not already in one of the rule's eligible containers. It is
  **fully keyboard-driven — non-negotiable** (number/letter keys), because the
  founding use case is the same site in personal and work containers, and a
  mouse-only screen would reintroduce the friction that keeps manual container
  switching unused today. Choices are **never remembered**.
- The manual **reopen picker** ("reopen this tab in container X") is **restricted
  to the matching rule's `open` list**. This is how a site restricts its escalation
  targets (e.g. `youtube.com` offers only `Personal`).

## Single sign-on and shared redirectors

An identity provider or shared payment redirector is configured one of two ways:

```yaml
- match: login.company.com
  open: SSO            # pinned: all apps share one login session (one cookie store)

- match: login.company.com
  inherit: true        # isolated: stays in whichever container started the login
```

`inherit: true` is the only way a container carries across a site boundary.
Because there is no automatic inheritance, every auth / payment domain must opt in
explicitly. In the author's data this is a real list: `accounts.google.com`,
`login.microsoftonline.com`, `credorax.net`, `payment.unzer.com`, and other 3DS
processors.

## Groups (isolation continuity)

`groups` is a **separate top-level list**, parallel to `rules`. A group is a set
of matchers that count as **one site** for the temporary-isolation path only:
navigating between members keeps the current temporary container instead of
spawning a new one. A group **never routes** — it resolves to no container — and
**never overrides** an `open` or `inherit` rule; it only affects members that
would otherwise be temporary. It is **symmetric within the set** (every member ↔
every member).

```yaml
groups:
  - [google.com, google.de, youtube.com]
  - [oracle.com, oraclecloud.com, identity.oraclecloud.com]
  - [check24.de, check24.com]
```

Groups use the **same match grammar as rules** (hostname shorthand, match
patterns, regex, and any-of lists) and are **order-significant with first-match
wins**, exactly like `rules`. Membership is therefore a **total function**: a URL
resolves to **at most one group** — the first it matches — so overlapping groups
need no union or disjointness rule. Put specific groups above broad ones. Two URLs
share continuity **iff they resolve to the same group**.

### Engine constraint: group membership is a separate lookup

Group membership is evaluated **independently of routing**, and always by the
**target URL** of the navigation. A domain can match a higher-precedence
`open`/`inherit` rule *and* still belong to a group; its membership is honoured for
continuity even though that rule "won" the routing decision. The engine answers
"do the originating URL and the target URL resolve to the same group?" by testing
the `groups` list directly — never by looking at whichever rule either side routed
through. Because membership is keyed on the target URL alone, a member reached via
an `inherit` hop (like `accounts.google.com`) is still looked up correctly.

Get this wrong and it fails silently. The worked example is disposable,
signed-in-for-age-gate YouTube:

1. Blank tab → `youtube.com` → a fresh temporary container **T** (disposable).
2. Age-gate → click sign-in → `accounts.google.com`. It matches `inherit`
   (first), so it stays in **T**; the Google cookie is written in **T**.
3. Redirect `accounts.google.com` → `youtube.com`. These are different
   registrable domains, so plain isolation would spawn a *new* temp and drop the
   login. But both are in the `[google.com, …, youtube.com]` group, so the
   navigation is same-site → stays in **T**, logged in, video plays.
4. When **T** is disposed (15 min after its last tab closes), the login
   evaporates. Exactly the intended disposable-login behaviour.

Step 3 only works if `accounts.google.com`'s membership in the google group is
still recognised even though it resolved via `inherit` in step 2 — hence the
constraint above. **Residual risk:** a login hop through a domain *outside* the
group (e.g. a stray `*.googleusercontent.com`) would still isolate; the fix is to
add that domain to the group.

## Overlays (`cookies` / `scripts`)

Two optional keys a rule may carry alongside its action, carrying over per-domain
conveniences from the previous Temporary Containers setup. Unlike actions, they do
**not** decide a tab's container or lifecycle — they *overlay* a within-container
side-effect on top of whatever routing already happened, and never cross a
container boundary. An overlay has no `match` of its own: it fires whenever its
rule matches, whatever the rule's action resolved to (`ignore` rules excepted —
there the engine does nothing, overlays included). The routing model above stands
on its own without them; they exist for drop-in parity. (The third TC carry-over,
redirector auto-close, *is* a container/lifecycle decision, so it is the
`redirector` action — see [The rule](#the-rule) — not an overlay.)

### `cookies` — seed cookies into the tab's container

Ensure named cookies exist when a domain loads, before the page reads them — to
pre-dismiss a consent banner (`klaro`) or set a UI pref (YouTube `wide`). The
cookie is written into the **tab's own cookie store**, so this is a within-container
write that honours the [identity boundary](#identity-and-cookies-a-boundary-not-a-feature):
it never copies a cookie from one container to another.

```yaml
- match: youtube.com
  open: Temporary
  cookies:
    - { name: wide, url: "https://www.youtube.com/", value: "1" }
    - { name: SOCS, url: "https://www.youtube.com/", value: "…", secure: true, sameSite: lax }
```

Seeded on load into the resolved container when the cookie is absent. `url` scopes
it (domain + path + scheme); `secure`, `sameSite`, `httpOnly`, `expirationDate` are
optional and default to a session cookie.

### `scripts` — per-domain content injection

Inject a snippet at `document_start` when the rule's domain loads — to dismiss a
modal or set a `localStorage` pref before the page runs. Runs in the page's
container like any content script.

```yaml
- match: youtube.com
  open: Temporary
  scripts:
    - at: document_start
      run: "localStorage.setItem('yt-player-sticky-caption', JSON.stringify({…}));"
```

**Capability note:** this is arbitrary code execution in the page and needs broad
host permissions; under MV3 it's delivered via the `userScripts` API. It is a
power-user escape hatch — justified here only because this is a single-user personal
tool replicating an existing setup, not a feature to expose casually.

## Identity and cookies (a boundary, not a feature)

Cookie sharing is a *different axis* from routing, and no routing construct
crosses it — that is what containers exist to prevent. Practical consequences:

- Cookies set during a login (e.g. Google setting a `youtube.com` cookie) are
  written via subresources and stay in the **tab's** container. They do not leak
  into a separate temporary YouTube, and routing (which only reopens top-level
  navigations) never reroutes them.
- **Decided: YouTube stays disposable, signed-out by default.** No `Google`
  identity container, no persistent YouTube login. `mail.google.com` → Gmail and
  `accounts.google.com` → `inherit` stay as they are.
- Age-restricted videos are handled by **logging in *within* the throwaway
  container**: the sign-in redirect chain stays in that temp container (protected
  by the google group — see [Engine constraint](#engine-constraint-group-membership-is-a-separate-lookup)),
  and the login is discarded when the container is disposed. Disposable identity,
  on demand, no permanent Google session anywhere.

## Importing from MAC + Temporary Containers

- Site assignments live in MAC's storage under `siteContainerMap@@_*`; container
  appearance in Firefox `contextualIdentities`. Neither is a clean export.
- **Both extensions share Firefox's one container pool**, so MAC's export alone
  can't distinguish permanent containers from Temporary Containers' live
  throwaways — filter those out by TC's `namePrefix`/`color`.
- The generated config records its own judgment calls (Google split, `credorax`
  generalization, Spotify blanket rule, dropped source junk) as comments.

---

## Open questions

**Config surface**
- **Config format** — YAML / JSON / JSON5 / TOML. YAML is provisional.

**Vocabulary / schema**
- **`default` vs `auto`** — the rule-level auto-select key reuses `default`, a word
  previously retired as a top-level global; may mislead.
- **Validity rules to codify** — a rule's action must be at most one of
  `open` / `inherit` / `ignore` / `redirector`; a `default` must be a member of its
  `open` list; `Temporary` is a reserved name; the `cookies` / `scripts` overlay
  keys may accompany any action except `ignore`.

**Groups**
- **Symmetric group vs directional "target domains"** — groups are symmetric
  within a set; a directional form was floated but no real asymmetric case found.

**Resolution details**
- **Reopen picker for unmatched sites** — restricted to what when no rule matches?
  All containers, or a "pinned" subset? Restriction is opt-in via `open` today.
- **Multi-home default behavior** — whether a multi-`open` site should default to
  a choice screen or auto-open; deferred to daily use.
- **Full-URL / path matching reach** — accepted, but path/query matching plus
  client-side SPA path mutation is a known risk surface.

**Temporary Containers parity — resolved**
- Redirector auto-close → the `redirector` rule action (a container/lifecycle
  decision, so it lives in `rules`).
- Cookie seeding, content-script injection → the rule-attached
  [overlays](#overlays-cookies--scripts) (`cookies`, `scripts`).
- Fully ignored domains (`getpocket.com`, `addons.mozilla.org`) → the `ignore`
  action (engine does nothing; leave the tab as-is).
- Mouse-click isolation (left / middle / ctrl+left) → **out of scope**: unused in
  the author's setup (all `never`), deliberately not modeled.
