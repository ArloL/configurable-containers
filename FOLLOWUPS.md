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
