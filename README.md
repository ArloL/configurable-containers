# Configurable Containers

One config to route every site to the right container.

It combines the two things Firefox's container ecosystem does separately today —
persistent, named identity containers (like **Multi-Account Containers**) and
disposable, auto-created ones (like **Temporary Containers**) — and puts a
single, user-defined configuration in charge of both.

You describe, in one place, how domains should map to containers. Configurable
Containers does the rest: routing each site into the right permanent container,
spinning up a temporary one when nothing matches, and keeping single-sign-on
flows from breaking along the way.

## Goals

- **Domain → container mapping.** Declare which domains open in which
  container — the feature Multi-Account Containers is most missing.
- **Minimal ceremony.** The common case is one line: a bare domain opens a
  container named after it. You add detail only when you want something
  other than the default — a curated name, several domains sharing one
  container (named after the first), or a choice between containers.
- **One text-edited config.** Everything lives in a single file, edited as
  text through a built-in editor. There is no form-based settings UI to
  click through, and the config only *routes* — it never owns container
  lifecycle. Containers are created on demand by name; ones no rule
  mentions are left untouched.
- **The config is the overview.** Every container CC routes to is named in that one
  file, so the whole mapping already reads at a glance — no dashboard to click
  through, and none planned. This is the answer to MAC's per-site UI friction, not
  a smaller version of it.
- **SSO that just works.** Make single-sign-on providers painless to use within
  permanent containers, instead of the fiddly setup Temporary Containers Plus
  requires.
- **Temporary by default, permanent by choice.** Anything no rule matches
  opens in a fresh throwaway container; long-lived named containers are
  opt-in, one rule at a time.
- **Continuity without leakage.** Isolation-continuity groups keep related
  sites in the same throwaway as you move between them, while crossing to
  an unrelated site still spins up a clean container — disposable sessions
  that survive a redirect but never bleed across a real boundary.

## Configuration

How domains map to containers is defined in a single user configuration. See
[CONFIG.md](CONFIG.md) for the design.

## Install

Configurable Containers is published on addons.mozilla.org. Install it from its
listing page; Firefox keeps it updated.

On first run it seeds a starter config. Nothing is routed into a named container until
you say so — every site opens in a fresh temporary container. The rules that do ship
only mark the handful of hosts where isolating would break something: SSO and identity
providers stay in whichever container started the login, known link shims aren't
isolated and close themselves, and Firefox's own add-on and account pages are left
alone. Commented examples below them show the syntax. Edit the config in the
add-on's preferences (about:addons → Configurable Containers → Preferences), which
opens a full-tab text editor. Saving reloads the extension.

## Building from source

Requires Node 22 or newer (verified on 24). Building needs nothing else; the
end-to-end tests additionally need a system Firefox.

```
npm ci
npm run package -- <version>   # -> dist/configurable-containers-<version>.xpi
```

That is the whole build. `npm run package` bundles the three entry points
(`src/extension/background.ts`, `options.ts`, `choice.ts`) with esbuild — **unminified** —
and stages them, with `extensions/cc/manifest.json` and the two HTML pages, into
`dist/cc/`, stamping the version there so the tracked manifest keeps a placeholder.
Only `background.js`, `options.js` and `choice.js` are generated; everything else is
copied verbatim.

**Reproducible.** The archive is written with [fflate](https://github.com/101arrowz/fflate)
rather than a system `zip`, so the deflate implementation is pinned by
`package-lock.json` instead of varying with the machine's zlib. Entries go in sorted
order with an explicit timestamp each, so the same commit produces a byte-identical
`.xpi`. Set `BUILD_TIMESTAMP` (a unix epoch or any parsable date) to control the
recorded time; it defaults to 1980-01-01. Releases stamp the build time and publish the
value in the release notes, since zip stores mtimes and nothing in the source lets you
derive them.

The rest of the checks:

```
npm run typecheck
npm run lint:ext  # addons-linter, the validator AMO runs
npm test          # unit + e2e; launches real Firefox via Selenium
```

Releases are cut by `.github/workflows/release.yaml`, which stamps the version from a
CalVer tag and submits to AMO.

## Status

Published, and still shaped by the author's daily use. Built on Firefox's container
APIs, with the door left open to other browsers later.
