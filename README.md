# Configurable Containers

One config to route every site to the right container.

It combines the two things Firefox's container ecosystem does separately today —
persistent, named identity containers (like **Multi-Account Containers**) and disposable,
auto-created ones (like **Temporary Containers**) — and puts a single, user-defined
configuration in charge of both.

You describe, in one place, how domains map to containers. Configurable Containers does
the rest: routing each site into the right permanent container, spinning up a temporary
one when nothing matches, and keeping single-sign-on flows from breaking on the way.

## Goals

- **Domain → container mapping.** Declare which domains open in which container — the
  feature Multi-Account Containers is most missing.
- **Minimal ceremony.** The common case is one line: a bare domain opens a container named
  after it. Add detail only for something other than the default — a curated name, several
  domains sharing one container, or a choice between containers.
- **One text-edited config.** Everything lives in a single file, edited as text in a
  built-in editor. No form-based settings UI, and the config only *routes* — it never owns
  container lifecycle. Containers are created on demand by name; ones no rule mentions are
  left untouched.
- **The config is the overview.** Every container CC routes to is named in that one file,
  so the whole mapping reads at a glance. No dashboard, and none planned — that is the
  answer to MAC's per-site UI friction, not a smaller version of it.
- **SSO that just works.** Single-sign-on providers are painless inside permanent
  containers, instead of the fiddly setup Temporary Containers Plus requires.
- **Temporary by default, permanent by choice.** Anything no rule matches opens in a fresh
  throwaway; long-lived named containers are opt-in, one rule at a time.
- **Continuity without leakage.** Isolation-continuity groups keep related sites in the
  same throwaway as you move between them, while crossing to an unrelated site still spins
  up a clean container.

## Configuration

How domains map to containers is defined in a single user configuration. See
[CONFIG.md](CONFIG.md) for the design.

### Working out what a flow needs

Some flows — a checkout that hands off to a payment provider, a login that bounces through
several identity hosts — break the first time, because a domain nobody has configured gets
isolated into a fresh container and the session is lost.

Before entering a flow you don't trust, **pause** the container you are in: the toolbar
button does it for the current tab, and the options page lists every container that has
tabs open. While paused, CC routes nothing inside that container, so the flow completes —
and it records each site it saw with the action it would have taken. Afterwards the
recording sits beside the config editor, so you can read off the hosts that mattered and
write the rules yourself. CC never proposes one.

A pause ends when you resume it, or when the container's last tab closes. The toolbar
badge shows how many containers are paused.

## Install

Configurable Containers is published on addons.mozilla.org. Install it from its listing
page; Firefox keeps it updated.

On first run it seeds a starter config. Nothing is routed into a named container until you
say so — every site opens in a fresh temporary container. The rules that ship only mark
the handful of hosts where isolating would break something: SSO and identity providers
stay in whichever container started the login, known link shims aren't isolated and close
themselves, and Firefox's own add-on and account pages are left alone. Commented examples
below them show the syntax. Edit the config in the add-on's preferences (about:addons →
Configurable Containers → Preferences), which opens a full-tab text editor. Saving applies
the config straight away.

The config follows your Firefox Account: an edit on one machine reaches every other
machine signed into the same account, with nothing to turn on and no file to copy. The
last edit wins, and if an incoming one replaces yours the editor offers the replaced text
back. See [CONFIG.md](CONFIG.md#syncing-between-machines).

## Building from source

Requires Node 22 or newer (verified on 24). Building needs nothing else; the end-to-end
tests additionally need a system Firefox.

```
npm ci
npm run package -- <version>   # -> dist/configurable-containers-<version>.xpi
```

That is the whole build. `npm run package` bundles the three entry points
(`src/extension/background.ts`, `options.ts`, `choice.ts`) with esbuild — **unminified** —
and stages them, with `extensions/cc/manifest.json` and the two HTML pages, into
`dist/cc/`, stamping the version there so the tracked manifest keeps a placeholder. Only
`background.js`, `options.js` and `choice.js` are generated; everything else is copied
verbatim.

**Reproducible.** The archive is written with [fflate](https://github.com/101arrowz/fflate)
rather than a system `zip`, so the deflate implementation is pinned by `package-lock.json`
instead of varying with the machine's zlib. Entries go in sorted order with an explicit
timestamp each, so the same commit produces a byte-identical `.xpi`. Set `BUILD_TIMESTAMP`
(a unix epoch or any parsable date) to control the recorded time; it defaults to
1980-01-01. Releases stamp the build time and publish the value in the release notes,
since zip stores mtimes and nothing in the source lets you derive them.

The rest of the checks:

```
npm run typecheck
npm run lint:ext      # addons-linter, the validator AMO runs
npm test              # unit + e2e; launches real Firefox via Selenium
npm run test:mutation # nightly guard rail: mutates the pure modules, gated at 100%
```

Releases are cut by `.github/workflows/release.yaml`, which stamps the version from a
CalVer tag and submits to AMO.

### Running an unreleased build

Release Firefox permanently installs signed add-ons only — `xpinstall.signatures.required`
is honoured on Developer Edition, Nightly and ESR, but ignored on release and beta. A
listed submission is no help while it waits: AMO signs a listed version at **approval**,
not at upload, so the queued file downloads back exactly as you sent it, without a
`META-INF/`.

Two ways around that:

- **Temporary install.** `npm run package -- 0.0.0`, then
  `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/cc/manifest.json`.
  Full permissions, no signing, gone at the next restart.
- **The dev build**, which auto-updates. Every merge to `main` signs one on AMO's
  **unlisted** channel — signed automatically in minutes, no review — and publishes it as
  an immutable `v<version>` GitHub **prerelease**. Install the newest one by hand once;
  Firefox picks up every later build on its own (about:addons → gear → Check for Updates
  forces a poll). Locally it is `VERSION=<version> npm run sign:dev`, which also needs
  `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` — the version comes from the environment,
  not an argument, and the script refuses to start without all three. Like a listed
  submission it uploads a source archive, because AMO's requirement follows the esbuild
  bundle rather than the channel — and that archive is built from **HEAD**, so commit
  before signing or AMO gets source that does not rebuild what you signed (the script
  warns).

The dev build is a **separate add-on** (`configurable-containers-dev@k5d.de`), which is
the point twice over: its uploads land on their own AMO record and cannot disturb a listed
version under review, and it gets its own `storage.local`, so installing it beside the
real add-on cannot overwrite your config. It also starts from the shipped seed config
rather than yours.

Versions come from `ArloL/calver-tag-action`, the same action that versions releases, so
dev builds and listed releases draw from **one** `v<YYMM>.0.<micro>` tag sequence and a
version is never reused — which AMO requires, since it rejects a version string it has
already seen. So the tag cannot tell you which channel a release belongs to: the
**prerelease flag** does, and it is what `scripts/dev-updates.js` filters on. Signing
locally takes an explicit version for the same reason — nothing outside the tag action may
allocate one.

Self-distribution splits across two places for one reason: **releases are immutable, and
the update manifest is not.** This repo has GitHub's immutable releases enabled, so a
published release and its assets cannot be changed — the asset is uploaded in the same
call that creates the release, and the URL Firefox downloads from can never serve
different bytes. The manifest pointing at those releases has to change on every merge, so
it lives on GitHub Pages at a constant URL (`scripts/dev-updates.js` rebuilds it from the
releases API and `ci.yml` deploys it). Rolling back means **deleting** a dev release and
re-running the manifest job, never editing a published one.

That Pages URL is baked into every signed build and polled forever, so it cannot be
changed retroactively — moving it would strand every installed dev build on a URL nothing
publishes to. `test/extension/sign-dev.test.ts` pins it as a literal.

## Status

Published, and still shaped by the author's daily use. Built on Firefox's container APIs,
with the door left open to other browsers later.
