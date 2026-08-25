# Configuration

The design of the user configuration: a snapshot of the decisions made so far, with open
questions at the end. The format is **YAML**, parsed by `src/config/parse.ts`, seeded and
stored as text, and shipped that way since the first release. A bare hostname is shorthand
for `*://*.<host>/*`.

See [`configurable-containers.config.yaml`](configurable-containers.config.yaml) for the
author's real config, generated from Multi-Account Containers and Temporary Containers
exports.

## What the config is (and isn't)

- **Two top-level lists.** `rules` map sites to containers; `groups` declare
  isolation-continuity sets (see [Groups](#groups-isolation-continuity)). A rule may also
  carry the optional overlay keys `cookies` and `scripts` (see
  [Overlays](#overlays-cookies--scripts)). There is no container-definition block:
  containers are named by the rules that target them. Any other top-level key is refused as
  a typo — `rulez:` would otherwise leave nothing matching anything, sending every site to a
  throwaway with the editor reporting no problem at all. One exception: a key starting with
  **`x-`** is yours, ignored without comment. That is where a YAML anchor lives, since an
  anchor needs a node to attach to and every node here is spoken for:

  ```yaml
  x-shared: &work Work
  rules:
    - match: example.com
      open: *work
  ```
- **Routing-first, not a container manifest.** The job is mapping sites to containers, not
  owning container lifecycle. A container is created on demand the first time a rule
  routes to its name; one no rule mentions is never managed and never deleted. **A
  container's name is its identity** — renaming a target creates a new, empty container
  and strands the old one's cookies. Overlays act *within* whatever container a tab is
  already in.
- **Temporary by default.** Anything no rule matches opens in a fresh **Temporary**
  container. That is the founding premise, so there is no `default:` for it.
- **Text-edited.** The config is edited as text in a simple editor built into the
  extension. There is no form-based settings UI.
- **One derived key.** A `version:` line may appear above the lists. Nobody types it: Save
  writes what the config's features need, and it exists so a machine running an older
  build can tell a feature it has never heard of from a typo. See
  [Machines on different versions](#machines-on-different-versions).

## The rule

Every rule is a `match` plus **at most one** action:

| Action          | Meaning                                                                        |
|-----------------|--------------------------------------------------------------------------------|
| *(none)*        | Open in a container **named after the host** (the **first** host when `match` is a list). |
| `open: X`       | Open matching sites in container `X`.                                           |
| `open: [A, B]`  | Eligible containers. With `default:` one auto-opens; without, a choice screen.  |
| `inherit: true` | Never route on its own; stay in the container that initiated the navigation.    |
| `ignore: true`  | Engine does nothing: no routing, isolation or side-effects.                     |
| `redirector: true` | Transient link shim: don't isolate the hop; auto-close the tab if it is left stranded on the shim. |

Isolation-continuity sets are not a rule action; they live in the separate `groups` list.

Overlays may accompany any action except `ignore`, whose contract is that the engine does
nothing at all. They never decide the container — only a within-container side-effect once
routing has happened.

A rule with **no action** is the common case: `- match: wohnsinn.com` opens in a container
called `wohnsinn.com`. With a list of plain hostnames the container takes the **first**
name, so `- match: [notion.com, notion.so]` opens in `notion.com`. Use `open:` to give the
container a different name (`Gmail` rather than `mail.google.com`) or to target a shared
one. Auto-naming needs a plain-hostname `match`: a pattern or regex has no single host to
name a container after, so an action-less rule written in either is refused.

`default:` (optional, only with a multi-value `open`) names which listed container
auto-opens; the others become manual **switch / reopen** targets. Omit it for a choice
screen.

### What a `match` list means depends on the action

Under `open`, including the auto-named form, the listed hosts **share the one container**
the rule names — the point of `- match: [notion.com, notion.so]`. Under `inherit` /
`ignore` / `redirector` there is no container to share, so a list is a plain
**enumeration**: each host behaves as if it had its own rule. Sites that should stay in
the *same* throwaway as you move between them are a `groups` entry, never a `match` list.

Two things a collapsed rule still shares, and they are the reason to split hosts apart
when either applies:

- **Overlays.** `cookies` / `scripts` have no `match` of their own, so they apply to
  *every* host in the list.
- **Position.** One rule is one slot in the first-match order, so the hosts cannot be
  interleaved with more specific rules.

Neither bites for a block of exemptions kept above the routing rules, which is why the
shipped default groups its SSO hosts, link shims and ignored hosts into one rule each.

**`Temporary` is a reserved value**, not a container you define. It may appear anywhere a
container name is accepted (`open: Temporary`, `open: [Temporary, X]`, `default:
Temporary`) and means "a fresh throwaway". You cannot create a permanent container named
`Temporary`.

"Fresh" is relative to a **site boundary**, not to every navigation: a rule resolving to
`Temporary` isolates exactly as the unmatched path does. Staying within the same
registrable domain, or the same `group`, keeps the current throwaway, and only crossing a
real boundary spins up a new one (see [mechanism 2](#resolution-engine)). Without this,
clicking around an `open: Temporary` site would churn a throwaway per click.

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

`match` is deliberately flexible, and matches against the **full URL** — scheme, host,
path, query — so path-based routing is possible. Three forms, plus lists:

```yaml
- match: company.com                          # shorthand -> *://*.company.com/*
- match: "https://app.example.com/work/*"     # WebExtension match pattern
- match: { regex: "^https://(app|api)\\.x\\.com/" }   # regex escape hatch
- match: [trello.com, "https://*.atlassian.net/*"]    # any-of list
```

The parser tells them apart by shape: a mapping is the regex form, a string containing
`://` is a match pattern (the scheme is what makes one), and anything else is a bare
hostname. A malformed entry is a config error naming the entry — never a rule that loads
and quietly matches nothing.

### Bare hostname

`company.com` covers `company.com` and every subdomain, on http and https, at any path.
Case, a trailing dot and IDN/punycode are normalized on both sides, so `BandCamp.COM.` and
`münchen.de` match as expected. A port is not part of a host: `company.com:8443` is an
error, and `https://company.com:8443/` matches `company.com` like any other URL of that
host.

It is the only form that **auto-names a container**; a pattern or regex has no single host
to take a name from, so an action-less rule in either is refused and the fix is `open:`.

### Match pattern

The [WebExtension match-pattern](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns)
grammar, `<scheme>://<host><path>`, with two narrowings, both refused loudly rather than
accepted and left inert:

- **Scheme** is `http`, `https` or `*` (meaning those two). Firefox also has `ws`, `file`,
  `ftp` and `data`, but a rule naming one could never fire — routing only sees top-level
  http(s) navigations.
- **Host** is a hostname, a hostname with a leading `*.` (that host *and* everything under
  it), or a bare `*`. A wildcard anywhere else — `*.google.*`, `*google.com` — is not a
  match pattern in Firefox either, and is what the regex form exists for.

Note the difference from the shorthand: in a pattern a bare host is **only** that host, so
`https://example.com/*` does not match `www.example.com`. Write `https://*.example.com/*`
for the subtree.

The **path** is required (`https://example.com` is an error) and is a glob whose only
metacharacter is `*` — any run of any characters, `/` included. Everything else is
literal, so `/a.b` matches `/a.b` and not `/axb`, and it is anchored at both ends, so
`/work` is not answered by `/workshop`. It matches the path **and query** —
`https://example.com/s?q=cats*` works — but never the fragment, which is not sent to the
server.

**A path-scoped rule is decided per navigation, and an in-app route change is not one.**
A single-page app that rewrites its own path client-side (`/work` → `/personal` with no
request) is never re-decided: the tab stays where the navigation it *did* make put it.
Scope a rule by path when the paths are separate page loads; a rule that has to follow an
SPA's own routing cannot be written here at all.

### Regex

The escape hatch, for sets neither other form can describe. Matched against the **whole
canonical URL** (`https://www.google.de/search?q=x`) and, like every form, only against an
http(s) one. Compiled when the config is read, so a broken expression is a config error
rather than a navigation that never completes. No flags; the scheme and host it sees are
already lowercase.

Prefer **single quotes** in YAML, where a backslash is a backslash — in a double-quoted
scalar every `\` must be written `\\` before the regex sees it.

The canonical case is a company with one registrable domain per country, where the
[Public Suffix List](#same-site-is-the-registrable-domain-via-the-public-suffix-list)
makes each ccTLD a different site, so a redirect between two would cost the throwaway you
were signed into:

```yaml
groups:
  # google.com, google.de, google.be, google.co.uk, … — ~190 domains in one line
  - [{ regex: '^https?://([^/]+\.)?google\.[a-z]{2,3}(\.[a-z]{2})?/' }, youtube.com]
```

Two things to know first. A regex this loose is **deliberately approximate** —
`google.zz` is in the group whether or not Google owns it, which costs nothing for a
continuity group and would be worth tightening for an `open:` rule. And the expression
runs inside the blocking request handler on **every** navigation: a catastrophically
backtracking one (nested quantifiers over a long URL) hangs the tab, with no timeout to
save you, because a JavaScript regex cannot be interrupted.

**First match wins**; order is significant. Put specific matches above broad ones. This
applies **independently to each list**: the first matching `rule` decides routing, the
first matching `group` decides membership. The two never shadow one another — a domain can
match both, and both are honoured.

### "Same site" is the registrable domain, via the Public Suffix List

Temporary continuity (mechanism 2) asks, on every unmatched navigation, whether two URLs
are the same site. **Same site** is the **registrable domain** (eTLD+1) from the **Public
Suffix List**, not a last-two-labels guess. That is mandatory: naive matching treats every
`*.co.uk` (and `com.au`, `co.jp`, …) as one site, so browsing `bbc.co.uk` then
`theguardian.co.uk` would keep the same throwaway and share its cookies across unrelated
sites. Only the PSL knows where the public suffix ends. (The bare-host shorthand is
separate: `bandcamp.com` expands to the literal subtree `*://*.bandcamp.com/*` and never
consults the PSL.)

**The PSL's *private* section counts too**, not ICANN-only. It lists company-operated
suffixes like `github.io`, `vercel.app`, `*.blogspot.com`, `*.myshopify.com`, so
`foo.github.io` and `bar.github.io` are different sites and never share a throwaway — the
more correct isolation. A PSL snapshot is bundled at build time and refreshed on a cadence.

## Resolution engine

Every top-level (`main_frame`) navigation is evaluated fresh. Three mechanisms, in order:

1. **Rule match — enforced on every navigation.** If the target matches a rule, its
   container is enforced: the tab is reopened there unless it is already there. This is
   *not* subject to same-site continuity — a rule's reach is exactly what its `match`
   covers, so `www.google.com` (unmanaged) → `mail.google.com` (→ Gmail) switches into
   Gmail. Exception: when the resolved container is `Temporary`, enforcement means "must be
   in *some* temporary container", and which one is mechanism 2's decision.

2. **Temporary isolation — same-site continuity.** For a navigation matching no rule, or
   matching one that resolves to `Temporary` (together, the disposable path), a *new*
   temporary container is created only on cross-site navigation. Staying within the same
   registrable domain, or within a declared `group`, keeps the current one, so moving
   around an unmanaged site doesn't churn throwaways. Mirrors Temporary Containers'
   `notsamedomain` isolation. A link **opened in a new tab** is asked the same question
   about the page it was clicked on: the browser starts that tab in the clicked page's
   container, so a same-site or same-group link keeps the session it came from.

3. **Explicit exemptions (`inherit` / `ignore` / `redirector`).** Exempt from both above.
   `inherit: true` keeps the tab in whichever container *initiated* the navigation — the
   SSO mechanism; the navigation is otherwise handled normally, overlays included.
   `ignore: true` goes further: no routing, no isolation, no overlays, and the domain is
   not treated as a "site" for continuity. `redirector: true` marks a transient link shim
   (`t.co`, `slack-redir.net`): the hop is not isolated, and the tab is **auto-closed** if,
   after a short delay (~2s), it is *still stranded on the shim domain*. That stranding is
   what `inherit` alone cannot clean up: when the destination is reopened into another
   container, the reopen does not dispose the shim tab. The close is **conditional on still
   being on the shim**, so a tab that redirected onward in place is never killed.

   Use `inherit` to carry identity across an auth hop, `ignore` for plumbing domains the
   engine should never touch (`getpocket.com`, `addons.mozilla.org`), and `redirector` for
   pass-through shims.

There is deliberately **no automatic "inherit the container I came from"** for unmarked
domains: a link from a permanent container to an unmanaged domain lands in a fresh
temporary one. The accepted cost is that SSO, auth and payment-redirect domains break
until configured as `inherit`, which is already the workflow — Temporary Containers keeps
an equivalent exclusion list by hand. There is **no auth-flow auto-detection**; the sole
user knows which domains need `inherit`.

## Choice screen and reopen picker

- A **choice screen** appears when a multi-`open` rule without `default` resolves and the
  tab is not already in one of the eligible containers. It is **fully keyboard-driven —
  non-negotiable**, because the founding use case is the same site in personal and work
  containers, and a mouse-only screen would reintroduce the friction that keeps manual
  container switching unused today. Choices are **never remembered**.
- It opens with its first option focused and answers in one keystroke: the **positional
  key** printed beside an option (`1`…`9`, then `a`…`z`), or the **underlined initial** of
  the container's name (`w` for `Work`) where that letter is free. `↑`/`↓` (wrapping),
  `Home`/`End` move the highlight, `Enter`/`Space` open, `Esc` closes the screen and
  leaves the page you were on alone. Modified keystrokes (`Ctrl+W`, `Alt+←`) stay the
  browser's.
- The manual **reopen picker** is **restricted to the matching rule's `open` list**, which
  is how a site restricts its escalation targets (`youtube.com` offers only `Personal`).

## Single sign-on and shared redirectors

An identity provider or shared payment redirector is configured one of two ways:

```yaml
- match: login.company.com
  open: SSO            # pinned: all apps share one login session (one cookie store)

- match: login.company.com
  inherit: true        # isolated: stays in whichever container started the login
```

`inherit: true` is the only way a container carries across a site boundary, and because
there is no automatic inheritance every auth and payment domain must opt in. In the
author's data that is a real list: `accounts.google.com`, `login.microsoftonline.com`,
`credorax.net`, `payment.unzer.com`, and other 3DS processors.

Since an `inherit` list shares nothing between its hosts
([above](#what-a-match-list-means-depends-on-the-action)), the whole list belongs in
**one** rule:

```yaml
- match:
  - accounts.google.com
  - login.microsoftonline.com
  - appleid.apple.com
  - okta.com                 # a bare host covers <tenant>.okta.com too
  - payment.unzer.com
  inherit: true
```

Keep that rule **above** any rule for the same site's main domain: `accounts.spotify.com`
has to win over a later `spotify.com` rule, or the login lands in the Spotify container
instead of the one that started it, and fails.

### A form submission is never moved between containers

A navigation carrying a body — a SAML assertion posted back to an app, a 3DS processor
returning to a shop — is **never reopened**. Moving a tab means opening a new one, which
can only issue a GET, so the body would be dropped silently: the login fails, or the
payment never confirms.

So CC leaves it where it is, and if a **rule of yours** named where it should have gone,
raises a notification saying so ("stayed in tmp9 instead of Haeger"). That rule genuinely
did not apply to that navigation, and it is usually why a login just failed.

CC stays **silent** when the submission would only have been isolated into a fresh
throwaway: both containers are throwaways, and no rule went unapplied. That is the common
case — a card payment at a site you have no rule for, where the processor posts back
cross-site and staying put is what lets checkout complete.

For an SSO chain, this is the signal to add `inherit: true` to the identity provider. The
IdP then sits in the app's own container, the assertion posts back to it, and there is no
boundary to cross.

## Groups (isolation continuity)

`groups` is a **separate top-level list**, parallel to `rules`. A group is a set of
matchers that count as **one site** for the temporary-isolation path only: navigating
between members keeps the current throwaway instead of spawning a new one. A group
**never routes** and **never overrides** an `open` or `inherit` rule; it only affects
members that would otherwise be temporary, and it is **symmetric** within the set.

```yaml
groups:
  - [google.com, google.de, youtube.com]
  - [oracle.com, oraclecloud.com, identity.oraclecloud.com]
  - [check24.de, check24.com]
```

Groups use the **same match grammar as rules** and are **order-significant with first-match
wins**. Membership is therefore a total function — a URL resolves to at most one group, the
first it matches — so overlapping groups need no union or disjointness rule. Two URLs share
continuity iff they resolve to the same group.

### Engine constraint: group membership is a separate lookup

Membership is evaluated **independently of routing** and always by the **target URL**. A
domain can match a higher-precedence `open`/`inherit` rule *and* belong to a group, and
its membership is honoured for continuity even though that rule won the routing decision.
The engine asks "do the originating and target URLs resolve to the same group?" against
the `groups` list directly, never through whichever rule either side routed by — so a
member reached via an `inherit` hop, like `accounts.google.com`, is still looked up
correctly.

Get this wrong and it fails silently. The worked example is disposable,
signed-in-for-age-gate YouTube:

1. Blank tab → `youtube.com` → a fresh temporary container **T**.
2. Age-gate → sign in → `accounts.google.com`. It matches `inherit` first, so it stays in
   **T**; the Google cookie is written in **T**.
3. Redirect back to `youtube.com`. Different registrable domains, so plain isolation would
   spawn a new temp and drop the login — but both are in the `[google.com, …, youtube.com]`
   group, so the navigation is same-site, stays in **T**, and the video plays.
4. When **T** is disposed, 15 minutes after its last tab closes, the login evaporates.

Step 3 works only if `accounts.google.com`'s group membership is still recognised even
though it resolved via `inherit` in step 2 — hence the constraint. **Residual risk:** a
login hop through a domain *outside* the group (a stray `*.googleusercontent.com`) still
isolates; the fix is to add that domain to the group.

## Overlays (`cookies` / `scripts`)

Two optional keys a rule may carry alongside its action, carrying over per-domain
conveniences from the previous Temporary Containers setup. Unlike actions they do **not**
decide a tab's container or lifecycle: they overlay a within-container side-effect on top
of whatever routing already happened, and never cross a container boundary. An overlay has
no `match` of its own — it fires whenever its rule matches, whatever the action resolved
to, except on an `ignore` rule where the engine does nothing at all. The routing model
stands without them; they exist for drop-in parity. (The third TC carry-over, redirector
auto-close, *is* a lifecycle decision, so it is the `redirector` action, not an overlay.)

### `cookies` — seed cookies into the tab's container

Ensure named cookies exist when a domain loads, before the page reads them — to
pre-dismiss a consent banner (`klaro`) or set a UI pref (YouTube `wide`). The cookie is
written into the **tab's own cookie store**, so it honours the
[identity boundary](#identity-and-cookies-a-boundary-not-a-feature) and never copies a
cookie between containers.

```yaml
- match: youtube.com
  open: Temporary
  cookies:
    - { name: wide, url: "https://www.youtube.com/", value: "1" }
    - { name: SOCS, url: "https://www.youtube.com/", value: "…", secure: true, sameSite: lax }
```

Seeded on load into the resolved container when the cookie is absent. `url` scopes it
(domain, path, scheme); `secure`, `sameSite`, `httpOnly` and `expirationDate` are optional
and default to a session cookie.

### `scripts` — per-domain content injection

Inject a snippet at `document_start` when the rule's domain loads — to dismiss a modal or
set a `localStorage` pref before the page runs. Runs in the page's container like any
content script.

```yaml
- match: youtube.com
  open: Temporary
  scripts:
    - at: document_start
      run: "localStorage.setItem('yt-player-sticky-caption', JSON.stringify({…}));"
```

**Not available on a `regex` rule.** A content script is registered against URL patterns
before any navigation, and a regex has no pattern form. Accepting one would mean
registering `*://*/*` — the snippet on every page you open — or covering some subset of
what the rule routes, so the config is refused instead: give the script's hosts a rule of
their own. `cookies` are seeded per navigation and are unaffected.

**Capability note:** this is arbitrary code execution in the page and needs broad host
permissions; under MV3 it is delivered via the `userScripts` API. A power-user escape
hatch, justified only because this is a single-user personal tool replicating an existing
setup.

## Identity and cookies (a boundary, not a feature)

Cookie sharing is a *different axis* from routing, and no routing construct crosses it —
that is what containers exist to prevent. Consequences:

- Cookies set during a login (Google setting a `youtube.com` cookie) are written via
  subresources and stay in the **tab's** container. They do not leak into a separate
  temporary YouTube, and routing only reopens top-level navigations.
- **YouTube stays disposable, signed-out by default.** No `Google` identity container, no
  persistent YouTube login. `mail.google.com` → Gmail and `accounts.google.com` →
  `inherit` stay as they are.
- Age-restricted videos are handled by **logging in *within* the throwaway**: the sign-in
  chain stays in that temp container (protected by the google group), and the login is
  discarded when the container is disposed. Disposable identity on demand, with no
  permanent Google session anywhere.

## Syncing between machines

The config follows you. CC mirrors it into `browser.storage.sync`, so editing it on one
machine publishes it to every other machine signed into the same Firefox Account, where it
is picked up and applied the same way a Save applies one locally. Nothing to turn on, no
file to copy.

What travels is the config text and nothing else. Container *contents* — cookies, logins,
the throwaways themselves — are Firefox's containers, not CC's, and never leave the
machine; neither does the disposer's record of which throwaway went empty when.
`storage.sync` is the user's own account, end-to-end encrypted between their machines. The
add-on has no server.

Three consequences worth knowing before they surprise you:

- **The last edit wins, and the one it replaced is kept.** There is no merge — the config
  is a hand-written file with comments, and merging two of them means conflict markers in
  a textarea. If an incoming config replaces yours, the editor says so and offers the
  replaced text back with one click. Conflicts are decided by wall-clock time, so a
  machine with a badly wrong clock can win an edit it should have lost.
- **A machine that has never been edited always loses.** A fresh install joining an
  established account pulls the real config rather than pushing the shipped seed over it.
- **There is a size limit.** Firefox caps extension sync storage; the config is split
  across as many entries as it needs, up to about 48 000 characters. The editor shows how
  many it is using and says plainly when a config is too large to sync, rather than
  syncing part of it.

A machine not signed into Firefox Sync is not broken — Firefox keeps the record locally
and uploads it if an account is ever connected.

### Machines on different versions

Machines update on their own schedule, so a config written on an updated one arrives on a
machine whose CC has never heard of half of it. That machine keeps routing.

The mechanism is the derived `version:` line. Save writes it whenever a config uses a
feature added after version 1 — today that means a match pattern or a regex, which are
version 2 — and removes it again when nothing needs it. A build reading a config that
declares a version **above its own** knows it is the older machine, and treats what it
does not recognise as a feature rather than a mistake:

- an unknown key is ignored, and the rest of that rule applies;
- a rule it cannot parse at all is skipped, so the sites it names fall back to a
  throwaway rather than the whole config collapsing;
- the editor lists what it ignored, and still lets you edit and save — including saving
  the `version:` line back untouched, since a build that cannot see those features must
  not decide the config no longer needs its marker.

A config that declares **no** future version is held to the current grammar exactly as
before: an unknown key there is a typo, and it is refused with the line it is on. That is
the whole reason the marker exists — without it, "a key from next year" and "a key with a
letter missing" are the same observation.

What this does not cover: a build older than the marker itself refuses an unknown key
whatever a config declares, and a feature filed at the wrong version tells older machines
nothing. The version table lives beside the keys in `src/config/parse.ts`, pinned by an
exact inventory in `test/config/parse.version.test.ts`, so filing one is a decision
someone makes rather than forgets.

## Importing from MAC + Temporary Containers

- Site assignments live in MAC's storage under `siteContainerMap@@_*`; container
  appearance in Firefox `contextualIdentities`. Neither is a clean export.
- **Both extensions share Firefox's one container pool**, so MAC's export alone cannot
  distinguish permanent containers from Temporary Containers' live throwaways — filter
  those out by TC's `namePrefix`/`color`.
- The generated config records its own judgment calls (Google split, `credorax`
  generalization, Spotify blanket rule, dropped source junk) as comments.

---

## Open questions

**Config surface**
- **A per-machine sync opt-out** — syncing is on for every install with no off switch. A
  machine that should keep its config to itself has no way to say so short of
  uninstalling. Deferred until something says the default is wrong.

**Vocabulary / schema**
- **`default` vs `auto`** — the rule-level auto-select key reuses `default`, a word
  previously retired as a top-level global; may mislead.
- **`Temporary` is reserved by interpretation, not by validation** — `parseConfig` accepts
  it as a container name and the resolver reads it as "disposable"
  (`src/resolver/types.ts` `TEMPORARY`), so a user meaning a permanent container of that
  name gets throwaways instead, with no error. It is the last of its shape: the `tmp<N>`
  collision beside it *is* validated now (a container named like a throwaway is refused,
  because the disposer would delete it), as are at-most-one action, `default` being a
  member of its `open` list, and no `cookies` / `scripts` on an `ignore` rule.

**Groups**
- **Symmetric group vs directional "target domains"** — groups are symmetric; a
  directional form was floated but no real asymmetric case found.

**Resolution details**
- **Reopen picker for unmatched sites** — restricted to what when no rule matches? All
  containers, or a pinned subset? Restriction is opt-in via `open` today.
- **Multi-home default behavior** — whether a multi-`open` site should default to a choice
  screen or auto-open; deferred to daily use.
- **Full-URL / path matching reach** — accepted, and live since match patterns shipped.
  The SPA half of the risk is stated where it bites, under
  [Match pattern](#match-pattern). What stays open is whether it ever wants more than a
  documented limit.

**Temporary Containers parity — resolved**
- Redirector auto-close → the `redirector` rule action.
- Cookie seeding, content-script injection → the
  [overlays](#overlays-cookies--scripts).
- Fully ignored domains (`getpocket.com`, `addons.mozilla.org`) → the `ignore` action.
- Mouse-click isolation (left / middle / ctrl+left) → **out of scope**: unused in the
  author's setup, deliberately not modelled.

**Temporary Containers parity — outstanding**
- **Automatic mode is implemented** (`src/engine/auto-temp.ts`) for `about:newtab` /
  `about:home`. One case is not covered and cannot be: a user who disables the new-tab
  page (`browser.newtabpage.enabled=false`) gets `about:blank` on Ctrl+T, and Firefox
  reports every tab as `about:blank` until its navigation commits, so a blank new tab is
  indistinguishable from one on its way to a real page. TCP has the same limitation. No
  config key; not a deferred slice.
