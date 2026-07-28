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
- **A management overview.** See and manage many containers at a glance, without
  the friction of MAC's current UI.
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

On first run it seeds a commented example config that routes nothing — every site
opens in a fresh temporary container until you add rules. Edit the config in the
add-on's preferences (about:addons → Configurable Containers → Preferences), which
opens a full-tab text editor. Saving reloads the extension.

## Building from source

Requires Node 22 and a system Firefox for the end-to-end tests.

```
npm ci
npm run typecheck
npm test        # unit + e2e; launches real Firefox via Selenium
npm run package # -> dist/configurable-containers-<version>.xpi
```

`npm run package` bundles `src/extension/background.ts` and the two page scripts with
esbuild and stages them, with `extensions/cc/manifest.json`, into `dist/cc/`. Releases
are cut by `.github/workflows/release.yaml`, which stamps the version from a CalVer tag
and submits to AMO.

## Status

Published, and still shaped by the author's daily use. Built on Firefox's container
APIs, with the door left open to other browsers later.
