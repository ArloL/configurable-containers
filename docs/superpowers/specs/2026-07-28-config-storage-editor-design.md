# Storage-Backed Config, Built-In Editor, and a Real Install Path — Design

**Date:** 2026-07-28
**Status:** Approved, pending implementation plan
**Topic:** Move the config from a build-time constant into `browser.storage.local`, add the
built-in text editor README promises, and set up a CalVer-tagged GitHub Actions release
that publishes CC as a **listed** add-on on addons.mozilla.org. The first slice whose goal
is *daily use* rather than routing behavior — and the one that turns a personal tool into
a published one.

## 1. Goal & scope

Every routing slice is implemented and L4-proven, but CC cannot be used. `src/extension/config.ts`
bakes the YAML in at build time and calls storage "a later slice"; the only way to run the
extension is `npm run manual`, a temporary install that dies with the browser window.

Three things stand between the current state and a tool the author uses every day:

1. The config lives in the bundle, so changing a rule means a rebuild.
2. There is no editor — README's "edited as text through a built-in editor" has no code.
3. There is no permanent install; unsigned XPIs cannot be permanently installed on
   release Firefox, so the extension dies with the browser window.

This slice closes all three. It is deliberately one slice because they are the same
dependency chain: an editor is pointless without storage, and storage is pointless
without an install that outlives the browser session.

Distribution is **listed** on AMO rather than a privately signed XPI, which raises the bar
in two places the design has to answer: the shipped seed can no longer be the author's
personal config (§4), and the release must produce a reviewable source archive (§8).

Daily use is also the *input* several deferred CONFIG.md open questions are waiting on
("multi-home default behavior — deferred to daily use"). Shipping this unblocks them.

### In scope

- A pure **`loadConfig(stored, seed)`** (`src/config/load.ts`) — the entire
  stored-vs-seed-vs-broken decision, testable with no browser.
- `src/extension/config.ts` becomes a thin L4 adapter: read storage, call `loadConfig`,
  seed storage on first run, open the options page on a parse failure.
- A new **options page** (`src/extension/options.ts` + `extensions/cc/options.html`), a
  third esbuild entry alongside `background` and `choice`.
- Manifest: add the `storage` permission, add `options_ui`, and change the extension ID
  to `configurable-containers@k5d.de`.
- A shipped **default seed config** (`src/config/default.yaml`) — exemption rules plus
  commented examples, not the author's personal config (§4).
- **Packaging + release**: `npm run package`, a GitHub Actions release workflow versioned
  by [`ArloL/calver-tag-action`](https://github.com/ArloL/calver-tag-action), and AMO
  submission on the **listed** channel (§8).
- Seeding the `tmpSuffix` counter from existing containers (see §9).
- **Harness**: `launch()` pins CC's extension origin via the `extensions.webextensions.uuids`
  pref and exports the constant; the probe gains an `open` command so tests can reach the
  options page (§10).
- Tests down the pyramid: pure `loadConfig`, four L4 cases covering seed, validation,
  storage → routing, and the bad-config failure.

### Out of scope (deferred)

- **Live config apply.** Save calls `browser.runtime.reload()`; siblings keep taking a
  `Config` value. Threading a `() => Config` accessor through engine, picker,
  cookie-seeder, script-injector and redirector-closer is a larger refactor with a new
  failure mode (a sibling capturing config at construction time) and buys little for a
  personal tool.
- **Export / import buttons.** Select-all-copy out of the textarea is enough.
- **A "reset to bundled seed" button.** Considered and declined; the seed's job ends at
  first run.
- **`storage.sync`.** Single-machine tool; `storage.local` only.
- **A self-hosted `update_url` / `updates.json`.** AMO distributes and auto-updates listed
  add-ons, and its linter rejects `update_url` on them outright.
- **A management-overview UI.** The YAML file *is* the overview — the config lists every
  container CC knows about, so a separate screen would restate it.
- **MAC / Temporary Containers import.** The author's setup is already converted; an
  end-user importer has no user.
- **Syntax highlighting / line numbers.** No editor library; a plain `<textarea>`.
- **A URL dry-run box** (type a URL, see which rule matches). Attractive and cheap —
  `matchRule` is pure — but a second component with its own tests. Deferred to a later
  slice; editing YAML against real navigation is the test for now.

## 2. Architecture & model

One new pure module, two thin L4 adapters, and **no change to the `BrowserPort` seam**.

```
src/config/load.ts        (pure, L1)   stored-vs-seed-vs-broken decision
src/extension/config.ts   (L4 adapter) browser.storage.local + openOptionsPage
src/extension/options.ts  (L4 page)    textarea, validate-on-input, save, reload
```

The engine seam does not move. Extension *pages* already touch `browser.*` directly —
`src/extension/choice.ts` does — so the storage read, `runtime.reload()`, and
`openOptionsPage()` live in the extension layer, not in `BrowserPort`. Consequences worth
stating plainly:

- `test/engine/mock-port.ts` gains nothing, so **no L3 test churn**.
- Unlike the choice page, the options page needs **no shared protocol module**. It talks
  to storage, never to the background, so there is no `picker-protocol.ts` analogue.

`__CC_CONFIG_YAML__` survives unchanged, with a new meaning: it is now the **first-run
seed**, not the live config. This is what keeps every existing e2e test passing
untouched — geckodriver gives each session a fresh temporary profile, so there is never
stored config, so the injected test config is always what loads.

### Startup becomes async

`background.ts` must `await` the storage read before wiring siblings, so listener
registration moves inside an async IIFE. A navigation firing in that window at browser
startup would go unrouted. `createScriptInjector` is already awaited, so this is not a
new shape — only a slightly wider window. Accepted; see §11.

## 3. The pure core

```ts
// src/config/load.ts
export interface LoadResult {
  config: Config;          // parsed, or { rules: [], groups: [] } on failure
  error?: ConfigError;     // set iff parsing failed
  seeded: boolean;         // true iff there was no stored config
}

export function loadConfig(stored: string | undefined, seed: string): LoadResult;
```

Rules, exhaustively:

| `stored` | parses? | result |
|---|---|---|
| `undefined` | yes | `{ config, seeded: true }` — first run, seed is used |
| `undefined` | no | `{ config: EMPTY, error, seeded: true }` — broken seed (a build bug) |
| present | yes | `{ config, seeded: false }` — the normal path |
| present | no | `{ config: EMPTY, error, seeded: false }` |

**Stored always wins over the seed** — including when stored is broken. A stored config
that fails to parse must *never* silently fall back to the seed: routing would then run
against rules that may be months stale, and the symptom (a site quietly going to the
wrong container) is one the author might not notice for weeks. Failing to the empty
config is loud and safe (§6).

`EMPTY` is `{ rules: [], groups: [] }` — no rule matches, so `resolve()` sends every
navigation down the disposable path.

## 4. Storage contract and first run

Single key, `configYaml`, a string, in `browser.storage.local`.

On first run (`seeded: true` and no error) the adapter writes the seed to storage
immediately. From that moment storage is the source of truth, which has one deliberate
consequence: **a future version shipping a different seed will never override an edited
config.** That is the intended semantics of "the editor is truth" — the seed is an
install-time convenience, and after install it goes stale by design.

### What the seed contains

CC is being **listed publicly on AMO** (§8), so the seed becomes every installer's
default. It is therefore a new file, `src/config/default.yaml`. When the only UI is a text
editor, the seed is the primary documentation a new user meets, so it carries that weight
rather than being blank: the commented examples demonstrate the syntax (a bare-domain
rule, a curated `open:`, a multi-host rule, a multi-`open` rule with a `default`, and a
group).

It also ships **active rules**, but only of one kind. The guarantee is not "routes
nothing" — it is that **every shipped rule is an exemption (`ignore`, `redirector`,
`inherit`) and never `open`.** That is the line worth holding: an exemption can only fail
to isolate, whereas an `open:` rule would put a real site's data into a named container
the installer never asked for. `test/config/default.test.ts` asserts the action kind of
*every* rule, so the guarantee survives later edits instead of being a one-off review.

What ships, and why each category earns its place:

- **`inherit`** on the identity providers (`accounts.google.com`, `login.microsoftonline.com`,
  `okta.com`, `auth0.com`, …). Without these, "Sign in with …" is broken out of the box:
  the auth hop reads as a cross-site navigation and gets a *fresh* throwaway, so the
  provider cannot see the session it just created. It does not widen exposure — the login
  page runs in whichever container initiated it, so a site in a throwaway still cannot
  reach Google cookies held in another container. Bare hosts cover subdomains, so one
  `okta.com` line covers every `<tenant>.okta.com`.
- **`redirector`** on link shims (TCP's `t.co`, `outgoing.prod.mozaws.net`,
  `slack-redir.net`, `away.vk.com`, plus the universal social shims).
- **`ignore`** on `addons.mozilla.org` and `accounts.firefox.com` — Firefox's own add-on
  and account pages misbehave when moved between containers.

Two deliberate omissions. **No region-specific hosts**, not even commented: the author's
German payment/eID entries are real but unverifiable by a stranger reading the file, and
every shipped domain is a claim the project implicitly vouches for. A generic comment
points at the payment step-up case without naming a host. **No `getpocket.com`**, despite
TCP's `IGNORED_DOMAINS_DEFAULT` still carrying it — Pocket shut down in July 2025, and a
dead claim is one more thing a new reader has to evaluate.

`configurable-containers.config.yaml` — the author's real config, with real work domains,
container names and cookie seeds — is **no longer shipped**. It stays in the repo purely
as the injection source for `npm run manual` and as the author's own backup; after
installing from AMO, the author pastes it into the editor once, and from then on their
config lives in storage like anyone else's.

Three consumers of `__CC_CONFIG_YAML__`, all distinct and none of them the others:

| Build | Seed injected |
|---|---|
| `npm test` (e2e) | the `TEST_CONFIG_YAML` constant in `build-extension.ts` |
| `npm run manual` | `configurable-containers.config.yaml` (the author's real config) |
| `npm run package` | `src/config/default.yaml` (the shipped example) |

## 5. The editor page

`extensions/cc/options.html` — a `<textarea>`, a Save button, an error region, and
`options.js`. Styled like `choice.html`: plain CSS in a `<style>` block, no framework.

`src/extension/options.ts`:

1. On load, read `storage.local.configYaml` into the textarea **and validate it
   immediately** — the text may already be broken (§6), in which case the page must show
   the error without waiting for a keystroke.
2. On every `input` event, run `parseConfig`. It is pure and sub-millisecond on a config
   this size, so there is **no debounce**.
   - Throws → render `err.message` (which already carries a `path` such as
     `rules[2].open`) in the error region and **disable Save**.
   - Parses → clear the error, enable Save.
3. On Save: write `storage.local.configYaml`, render "Saved — reloading", then call
   `browser.runtime.reload()` on a 100 ms `setTimeout`.

The delay is deliberate. `runtime.reload()` tears down all extension pages, so **the
options tab dies at the moment of save**; the delay ensures the status paints first, and
makes the teardown look like a consequence of the click rather than a crash. What Firefox
leaves in that tab afterward — blank, error page, or a re-navigated page — is pinned down
by the e2e (§10) rather than guessed at here.

Save is reachable only when the current text parses, so **storage can only ever be
written with a valid config by this page**. §6 exists for the paths that bypass it: hand-edited
storage, or a future version tightening the schema under a config written by an older one.

## 6. Failure behavior

When `loadConfig` returns an `error`, the adapter:

1. Wires all siblings with the **empty config** — nothing matches, so every site opens in
   a fresh throwaway.
2. Calls `browser.runtime.openOptionsPage()`.
3. Logs the `ConfigError` via `console.error`.

The options page loads the broken text from storage as usual and, because validation runs
on load as well as on input, immediately shows the parse error with Save disabled.

This failure mode is chosen because it cannot leak: with no rules, no site can be routed
into the *wrong* permanent container. It degrades to "Temporary Containers with extra
steps" — annoying, obvious, and fixable in the page that just opened itself.

## 7. Manifest and extension identity

```jsonc
"browser_specific_settings": { "gecko": { "id": "configurable-containers@k5d.de" } },
"permissions": [ ..., "storage" ],
"options_ui": { "page": "options.html", "open_in_tab": true }
```

- **The ID changes from `cc@configurable-containers.test`.** `.test` is a reserved TLD
  that signals "never meant to ship." AMO never resolves the domain or verifies
  ownership — the only hard requirement is global uniqueness — but a domain the author
  controls is a free uniqueness guarantee, which is why the email-like form is the
  convention (`uBlock0@raymondhill.net`, `addon@darkreader.org`). This must be settled
  before the first signed upload: §8.
- **`open_in_tab: true`** because the about:addons embedded frame is too cramped for a
  config file, and because a page CC opens *itself* on a bad config should be a visible
  tab rather than a pane the user has to go find.
- **No `update_url`.** AMO distributes and updates listed add-ons, and its linter rejects
  the field on them.
- `version` stays a placeholder here; the release pipeline injects the real one into a
  staged copy (§8).
- `extensions/probe/manifest.json` keeps its `.test` ID. The probe is never signed or
  distributed.
- The `id` strings in `docs/superpowers/plans/` and `specs/` are historical records of
  past slices and are **not** rewritten.

## 8. Packaging and release

CC is distributed **listed** on addons.mozilla.org: publicly available, installed with one
click from its listing page, and auto-updated by AMO. This is a change of posture from
README's "a personal tool first" and brings obligations a private XPI would not have —
they are spelled out below because they shape the work, not just the paperwork.

### Versioning

Versions come from [`ArloL/calver-tag-action`](https://github.com/ArloL/calver-tag-action):
`MAJOR_MINOR` is `date -u +"%y%m"` and the micro counts from 101, so the tag is
`v2607.0.101` and the action's `new_version` output is `2607.0.101`. The next release that
month is `.102`; August restarts at `2608.0.101`.

This satisfies AMO's version format (1–4 dot-separated numbers, each 0–999999999, no
leading zeros) and is monotonic across month and year boundaries, so Firefox's numeric
part-by-part comparison always orders releases correctly.

**`manifest.json` keeps a placeholder version and is never hand-edited.** Packaging stages
`extensions/cc/` into `dist/cc/`, rewrites `version` there from the action output (or a
local default for developer builds), and packages *that*. The tracked tree therefore stays
clean whether the build runs in CI or locally — which matters because `background.js` and
`choice.js` are already gitignored, leaving `manifest.json` as the only tracked file a
naive in-place bump would dirty.

### Scripts

`web-ext` becomes a devDependency. Long options throughout, per the author's global
preference.

- **`npm run package`** — `buildExtension({ configYaml: src/config/default.yaml })`, stage
  to `dist/cc/`, set the version, zip. Produces an unsigned XPI for inspection, temporary
  install, and CI artifacts. Parses the seed first and fails on a `ConfigError` (§11).
- **`npm run submit`** — the same staged build, then
  `web-ext sign --source-dir dist/cc --channel listed --api-key $WEB_EXT_API_KEY --api-secret $WEB_EXT_API_SECRET`.
  On the listed channel this *submits for review* rather than returning a signed file.

### Release workflow

A new workflow, separate from `ci.yml`, following its existing conventions (SHA-pinned
actions, least-privilege `permissions`):

1. `workflow_dispatch` trigger — releases are deliberate, not every push to main.
2. Checkout with full history and tags, `permissions: contents: write`. Note this must
   **not** set `persist-credentials: false` as `ci.yml` does: the action pushes a tag.
3. Run the full suite first. A release that has not passed e2e is not a release.
4. `ArloL/calver-tag-action` → `new_version`.
5. Package at that version, then `npm run submit`.
6. Attach the packaged XPI and the source archive to a GitHub Release for the tag.

Secrets (`WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET`) are repository secrets and never enter
the repo. `dist/` is gitignored.

### Obligations that come with listing

- **Source-code submission is required.** AMO requires it whenever shipped JS is bundled or
  minified, and `background.js` is an esbuild bundle. The release must therefore produce a
  source archive plus build instructions (`npm ci`, `npm run package`, the Node version)
  that let a reviewer reproduce the artifact byte-for-byte. This is a deliverable of this
  slice, not a later chore. **Producing the archive is not enough — it must be *uploaded*
  with the submission**, via `web-ext sign --upload-source-code`. Attaching it to the
  GitHub release satisfies nothing on AMO's side; a listed submission missing it simply
  sits in review. README's "Building from source" section rides along inside the archive
  and serves as the reviewer's build instructions.
- **Review is a gate, not a formality.** `<all_urls>` + `webRequestBlocking` + `cookies` is
  the permission profile most likely to draw human review, so the first submission may take
  days. Development is unaffected — the temporary-install path (`npm run manual`, the e2e
  harness) never touches AMO.
- **The extension ID binds to the AMO account on first submission.** Changing
  `configurable-containers@k5d.de` afterwards means a new listing. Hence §7 settling it
  before the first upload.
- **AMO never forgets a version**, so a resubmission always needs a new one. CalVer gives
  this for free: a re-run mints the next micro.
- **Listing metadata** — summary, description, category, license (the repo has `LICENSE`),
  and a data-collection declaration. CC collects and transmits nothing; the declaration
  should say so plainly.

## 9. Adjacent fix: the `tmpSuffix` counter

`background.ts` initializes `let n = 0`, so temporary containers are named from `tmp1`
each time the background starts. After a restart with live throwaways present, new temps
collide by name with existing ones — two containers both called `tmp1`. This is cosmetic
today (identity is by `cookieStoreId`, and `TMP_PREFIX` classification is unaffected)
and pre-existing.

This slice makes it worse: `runtime.reload()` on every save turns "once a day at browser
start" into "every time you edit the config."

Fix, at startup: seed the counter from the highest `tmp<N>` already present in
`queryIdentities()`. Roughly six lines, in the blast radius of this change, so it belongs
here rather than in a follow-up.

## 10. Testing (down the pyramid)

**Pure (L1) — `test/config/load.test.ts`.** The full §3 table: absent storage falls back
to the seed; stored beats seed; unparseable stored yields the empty config *and does not
revert to the seed*; a broken seed on first run also yields the empty config. Every branch
of the decision is covered here, without a browser.

### Reaching the options page at L4 — two findings, both verified in headless Firefox

The options page lives at `moz-extension://<uuid>/options.html`, and the uuid is normally
random per profile. Two experiments settled how a test addresses it.

**1. WebDriver cannot navigate to a `moz-extension://` URL.** `driver.get` on the page
fails with *"Navigation to moz-extension://…/choice.html is not allowed in this context"* —
the same phrasing CLAUDE.md records for `about:newtab`, i.e. Marionette's restriction on
non-web schemes. This holds even with the origin pinned, so the driver can never open an
extension page itself; it can only *operate* one that something else opened (which is how
`test/e2e/choice.test.ts` already works).

**2. The probe can open it, and the uuid can be pinned.** Both halves tested together:
with `extensions.webextensions.uuids` set to `{"<cc-addon-id>":"<fixed-uuid>"}`, the probe's
background called `browser.tabs.create({ url: "moz-extension://<fixed-uuid>/choice.html" })`
and the tab loaded (title `Choose container`). So:

- **Pinning works.** The pref fixes CC's origin to a constant the test can hard-code.
- **`web_accessible_resources` is not needed.** Firefox gates those on *web content*, not on
  other extensions — an installed extension may open another's pages by URL. The config
  editor therefore stays unreachable from any website, which it must.

Harness changes this implies: `launch()` sets the uuid pref and exports the constant; the
probe gains an `open` command in its existing `cc-probe-cmd` relay (`browser.tabs.create({url})`),
reached from tests through `probeCommand`. As CLAUDE.md notes, the driver must be parked on
a probe-reported http(s) page to issue a command. The pinned map keys on the **new** ID from
§7, `configurable-containers@k5d.de`.

### L4 cases — `test/e2e/options.test.ts`

With the probe as the door, these are independent cases rather than one forced flow:

1. **Seed is visible.** Default build; open the options page; the textarea contains the
   injected seed config.
2. **Invalid input is refused.** Type a malformed config; the parse error renders and Save
   is disabled.
3. **Storage → routing (the money test).** Type a valid config routing a new host to a
   named container; Save; the extension reloads; navigate that host and assert via the
   probe that it lands in that container. This is the one that proves the whole chain —
   storage write, `runtime.reload()`, re-parse at startup, routing — and it also captures
   what Firefox does to the options tab across the reload (§5).
4. **Bad stored config (§6).** Build with a deliberately broken seed
   (`buildExtension({ configYaml: <invalid> })`); assert CC opens the options page itself
   at startup with the error shown, and that an unmatched host lands in a `tmp` container
   (temporary-only, nothing routed to a permanent one).

**The good-seed path needs no test of its own.** Every existing e2e already exercises it: a
fresh profile has no storage, so the injected test config loads through the new
`loadConfig` path. If that path breaks, the whole existing e2e suite goes red.

**Per CLAUDE.md, every new test is revert-verified** — back the fix out, watch it go red,
restore it. This suite has shipped false greens twice.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Async startup window** — a navigation during the awaited storage read goes unrouted. | Single storage read, no other awaits before wiring. MV2 background *pages* load before session restore, so the window is milliseconds. Accepted, documented in CLAUDE.md. |
| **`runtime.reload()` kills the options tab**, and Firefox's behavior there is unverified. | Pinned by the L4 flow (§10), which continues working in that tab's aftermath. The 100 ms delay guarantees the "Saved" status paints first. |
| **Reload drops in-memory guards** — `freshlyReopened`, disposer timers. | Saving happens from the options page with no navigation in flight, so the F1 guard has nothing to protect. The disposer sweeps orphans immediately at startup (`disposer.ts:57`), so temps are self-healing. `tmpSuffix` is fixed in §9. |
| **A schema change strands a stored config**, leaving the author with temporary-only routing. | The §6 failure is safe and self-announcing: the options page opens with the error and the original text intact, so the fix is an edit, never a reinstall. |
| **AMO review rejects or delays the listing.** | Nothing in development depends on AMO: `npm run package` produces a working unsigned XPI, and `npm run manual` plus the e2e harness use temporary install. A rejection costs a resubmission, never a blocked branch. |
| **A bad seed ships in a release**, making every fresh install temporary-only. | `npm run package` parses `src/config/default.yaml` and fails on a `ConfigError` before invoking the build. The check belongs to **that script, not to `buildExtension`** — the L4 case in §10 depends on `buildExtension` accepting a deliberately invalid seed, so validating inside it would make that test unwritable. |
| **The source archive drifts from the shipped XPI**, so a reviewer cannot reproduce the build. | Both are produced by the same workflow run at the same tag, from the same staged directory — never assembled by hand. |
| **The author's personal config is in a public repo** that a listing will draw attention to. | Pre-existing and the author's call; noted because listing changes who looks. It is no longer *shipped* (§4), which is the part this slice controls. |

## 12. What this slice does *not* prove

- **That the config is any good.** Editing rules against real sites is the point of
  shipping this; the deferred CONFIG.md questions stay deferred until there is data.
- **Migration between config schema versions.** There is one schema. A breaking change
  surfaces via §6, which is the whole plan for now — and listing raises the stakes, since
  strangers' configs would break too.
- **That AMO approves the listing.** Review is outside this slice's control; §8 lists the
  obligations, it cannot guarantee the outcome.
- **That the config format is good enough for strangers.** Listing means users who never
  read CONFIG.md meet the seed and the error messages first. This slice makes both the
  primary documentation surface without any evidence that they are sufficient.
- **Multi-machine or multi-profile config sync.** `storage.local` only.
- **MV3 readiness.** `options_ui`, `storage.local`, and `runtime.reload()` all carry over,
  but the persistent-background assumption in §2 does not. F8 remains open.

## 13. Amendments made during implementation

Two things this design got wrong, corrected in the code and recorded here so the spec
does not mislead a later reader.

**§2 / §11 — "startup becomes async" is wrong.** The design had listener registration move
inside an async IIFE and rated the resulting window "milliseconds, accepted". It is not.
Wiring the siblings behind `await readStoredConfigYaml()` loses the session's **first
navigation** every time: Firefox dispatches it before `webRequest.onBeforeRequest` exists,
so the tab is never routed and stays in `firefox-default`. All four event-driven cases in
`test/e2e/auto-temp.test.ts` went red, deterministically.

What ships instead keeps every listener registered **synchronously** as `background.ts`
evaluates, and defers only the config: `config` is one object filled in place once storage
resolves (the siblings all read it at event time), and a `gatedPort` decorator makes the
blocking `onBeforeRequest` handler `await` a `configReady` promise, so an early navigation
is *delayed* rather than routed against the empty config. `createScriptInjector` — the one
eager consumer — is the only sibling that genuinely waits. The risk row "a navigation in
that window goes unrouted" is therefore retired, not mitigated.

**§4 / §6 — first run must seed storage even when the seed does not parse.** The design
wrote storage only on a clean parse, which left the broken-seed path with *nothing* stored:
the editor CC opens for it came up blank and valid, so the config appeared to have vanished
and there was nothing to fix. Storing the broken text is what makes §6's promise ("the
options page loads the broken text from storage as usual") true for a broken seed and not
just a broken stored config.
