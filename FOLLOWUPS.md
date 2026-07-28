# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry
once it is resolved.

## A `window.open` popup loses its window (2026-07-28)

A share button of the `window.open(url, "name", "width=640,height=480")` shape
opens a popup window, and CC destroys it: the popup's tab is pre-commit, so
`reopen` replaces it, and `tabs.create` is never told which window to use — the
replacement lands in the last focused *normal* window and the popup closes.
Nothing in `BrowserPort` carries a window at all (`src/engine/port.ts`: neither
`Tab` nor `CreateTabProps` has `windowId`), so no reopen can preserve one; the
same gap would teleport a tab reopened in a window that is not focused.

Seen with psychologytoday.com's LinkedIn *share* button — not the footer link,
which is an ordinary same-tab link and is fixed. Decide first whether Firefox
will create a tab in a popup window at all, or whether popup navigations should
be left alone: they already inherit their opener's container.

## The choice screen still destroys the page you were on (2026-07-28)

`showChoice` (`src/engine/picker.ts`) navigates the *triggering* tab to the
choice page, so a multi-container rule loses the page before the user has picked
anything — exactly the loss that keeping the source tab removed for
single-container rules (CLAUDE.md, "A reopen KEEPS a source tab that is on a
page"). The two paths should agree; that means showing the choice somewhere
other than the user's own tab.

## Behaviour described in TESTS.md but not asserted anywhere (2026-07-28)

TESTS.md was deleted when the tests became the only behaviour spec
(`docs/superpowers/specs/2026-07-28-bdd-test-naming-design.md`). Its 47 decided
scenarios were audited against the suite first; these three had no test, and are kept
here so the intent is not lost with the file. Each needs a failing test written first —
they are coverage gaps, not renames.

- **Two blank tabs to the same unmatched site are isolated.** Every existing isolation
  test drives one tab, or a link from an opener. Nothing asserts that two *independent*
  blank tabs navigating to the same unmatched host get separate throwaways. `resolve` is
  pure and takes one navigation, so this is only expressible at L3 or L4.
- **Rule enforcement overrides same-site continuity.** `resolve` consults `matchRule`
  before `disposablePath`, so a matched rule structurally always wins — but no test pins
  it. The scenario is the `www.google.com` (throwaway) → `mail.google.com` (Gmail rule)
  hop: same registrable domain, yet it must still switch container.
- **A group does not override an open rule.** The mirror of the above for groups: a
  domain in both a group and an `open` rule must follow the rule. The existing group
  tests all cover continuity *within* the disposable path, which is the other direction.

## Nothing pins the literal value of TMP_PREFIX (2026-07-28)

`test/engine/registry.test.ts` imports `TMP_PREFIX` and interpolates it, so changing
`"tmp"` to anything else moves both sides of every assertion and the suite stays green
(verified by mutation). The behaviour — prefix-based identification — *is* covered; the
value is not. That value is load-bearing across a background restart: CC recognises its
own throwaways by name, so changing the prefix would silently orphan every `tmp…`
container in a live profile. A test asserting the literal would catch it.

## What the L5 and Mutation columns of the coverage matrix mean (2026-07-28)

`TESTING.md`'s subtle-bug matrix ticks L5 for F3, F4, F5, F6, F9, F11 and F12, and
Mutation for F3, F4, F5 and F6. There is no acceptance suite and no Stryker config, so
the ticks encode something other than "a test exists at this level" — the author did not
recall what, and the prose that would have defined it was rewritten when TESTS.md went.
The matrix was deliberately left untouched rather than guessed at. Resolve it by deciding
what the columns should mean, then making them true.

## Notification volume on declined POSTs (2026-07-28)

Every cross-site form POST that would change container now raises a notification,
deduplicated per host per background session. Payment-gateway returns are the common
case, and there staying put is the *desirable* outcome — so the toast may prove to be
noise. The narrower trigger (notify only when the denied target was a **permanent**
container, i.e. a rule that went unapplied) is a one-line change at the same site in
`src/engine/engine.ts`. Revisit after real use.

Not done here either: **replaying** the POST into the target container via a generated
auto-submitting form page. It is the only option that would actually route the
assertion, and neither Temporary Containers nor Multi-Account Containers attempts it.
It needs the `requestBody` webRequest opt-in, urlencoded and multipart handling, and a
`moz-extension:` page forging a cross-origin POST. See
`docs/superpowers/specs/2026-07-28-f9-redirect-binding-design.md` §1.

## `overrides` in package.json (2026-07-28)

`adm-zip` and `shell-quote` are forced past what their own dependents declare
(`firefox-profile` asks for `~0.5.x`, `fx-runner` pins `1.8.4` exactly) to clear
two Dependabot alerts on transitive **dev** dependencies of `web-ext`. Nothing
here ships — `npm audit --omit=dev` is clean and the xpi is an esbuild bundle of
`src/` — so these are a standing compatibility risk rather than a fix:
`firefox-profile` was written against `adm-zip` 0.5.

Drop them once a `web-ext` release past 10.5.0 pulls in dependents that already
ask for the patched versions. After any change here `npm run lint:ext` is the
check that matters — web-ext is the only thing that consumes these packages.

`npm audit` also reports `brace-expansion` advisories under `eslint →
addons-linter`. Left alone: the installed `1.x` is already the newest of its
line, and the advisory is only fixed in `5.x`, which `minimatch@3` cannot take.
GitHub raises no Dependabot alert for it either.
