# Storage-Backed Config, Built-In Editor, and a Real Install Path — Design

**Date:** 2026-07-28
**Status:** Approved, pending implementation plan
**Topic:** Move the config from a build-time constant into `browser.storage.local`, add
the built-in text editor README promises, and produce a signed XPI that installs
permanently on release Firefox. The first slice whose goal is *daily use* rather than
routing behavior.

## 1. Goal & scope

Every routing slice is implemented and L4-proven, but CC cannot be used. `src/extension/config.ts`
bakes the YAML in at build time and calls storage "a later slice"; the only way to run the
extension is `npm run manual`, a temporary install that dies with the browser window.

Three things stand between the current state and a tool the author uses every day:

1. The config lives in the bundle, so changing a rule means a rebuild.
2. There is no editor — README's "edited as text through a built-in editor" has no code.
3. There is no permanent install; unsigned XPIs cannot be permanently installed on
   release Firefox.

This slice closes all three. It is deliberately one slice because they are the same
dependency chain: an editor is pointless without storage, and storage is pointless
without an install that outlives the browser session.

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
- **Packaging + signing**: `npm run package` and `npm run sign` (web-ext, AMO unlisted
  channel), producing a signed XPI installable on release Firefox.
- Seeding the `tmpSuffix` counter from existing containers (see §9).
- Tests down the pyramid: pure `loadConfig`, one L4 flow proving storage → routing.

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
config.** That is the intended semantics of "the editor is truth" — the packaged
`configurable-containers.config.yaml` is an install-time convenience, and after install
it goes stale by design.

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
- `extensions/probe/manifest.json` keeps its `.test` ID. The probe is never signed or
  distributed.
- The `id` strings in `docs/superpowers/plans/` and `specs/` are historical records of
  past slices and are **not** rewritten.

## 8. Packaging and signing

`web-ext` becomes a devDependency. Two scripts, both using long options per the author's
global preference:

- **`npm run package`** — `buildExtension({ configYaml: <configurable-containers.config.yaml> })`,
  then zip `extensions/cc/` into `dist/`. Produces an unsigned XPI (temporary install,
  CI artifacts, inspection).
- **`npm run sign`** — the same build, then
  `web-ext sign --source-dir extensions/cc --channel unlisted --api-key $WEB_EXT_API_KEY --api-secret $WEB_EXT_API_SECRET`,
  output to `dist/`.

AMO's unlisted channel signs automatically with no human review. The resulting XPI
installs permanently on **release** Firefox via about:addons → Install Add-on From File,
and survives restarts — which `xpinstall.signatures.required=false` cannot do, since
release Firefox ignores that pref (CLAUDE.md records the long detour that established
this).

Two one-way doors:

- **The ID is bound to the AMO account on the first signed upload.** Changing it later
  means a new AMO listing and a manual uninstall/reinstall. Hence §7 settling it first.
- **AMO rejects a version it has already seen**, so every signed build needs a
  `manifest.json` version bump. Kept manual and documented — auto-incrementing would
  burn version numbers on failed builds.

API keys come from the environment and never enter the repo. `dist/` is gitignored.

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

**L4 — `test/e2e/options.test.ts`.** One flow, because the options page has an addressing
problem: it lives at `moz-extension://<uuid>/options.html`, and a test cannot know that
uuid. The probe cannot help — storage and extension URLs are per-extension.

So the test uses CC's own failure path as the door. Build with a **deliberately broken
seed** (`buildExtension({ configYaml: <invalid> })`); CC opens the options page itself at
startup (§6). From that one auto-opened page, in order:

1. The parse error is rendered and Save is disabled.
2. Replace the text with a valid config routing a new host to a named container.
   The error clears and Save enables.
3. Click Save. The extension reloads.
4. Navigate that host; assert via the probe that it lands in the named container.

That single flow proves storage → routing end to end — the seed path, the editor, the
storage write, `runtime.reload()`, and re-parse on restart — with no debug hooks and no
uuid. It also captures what Firefox does to the options tab across the reload (§5).

**The good-seed path needs no new test.** Every existing e2e already exercises it: a
fresh profile has no storage, so the injected test config loads through the new
`loadConfig` path. If that path breaks, the whole existing e2e suite goes red.

**Why not pin the uuid — tested, does not work.** Pinning CC's origin via the
`extensions.webextensions.uuids` pref (`{"<addon-id>":"<uuid>"}`) in `launch()` would let
a test open the options page directly and split the flow above into independent cases.
Tried in headless Firefox against the pinned origin: `driver.get` fails with
*"Navigation to moz-extension://…/choice.html is not allowed in this context"* — the same
error phrasing CLAUDE.md records for `about:newtab`, i.e. Marionette's restriction on
navigating to non-web schemes, which fires before the uuid can matter. **WebDriver cannot
navigate to a `moz-extension://` URL at all**, pinned or not.

The driver can still *operate* an extension page that something else opened — that is how
`test/e2e/choice.test.ts` works, since CC navigates the tab to the choice page itself. So
"CC opens the page, the test switches to it" is not a workaround for a missing uuid; it is
the only available door, which is why the broken-seed flow above is the design rather than
a fallback. Making `options.html` a `web_accessible_resource` would let a content page
reach it, but that exposes the config editor to every website — not a trade worth making
for test convenience.

**Per CLAUDE.md, every new test is revert-verified** — back the fix out, watch it go red,
restore it. This suite has shipped false greens twice.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Async startup window** — a navigation during the awaited storage read goes unrouted. | Single storage read, no other awaits before wiring. MV2 background *pages* load before session restore, so the window is milliseconds. Accepted, documented in CLAUDE.md. |
| **`runtime.reload()` kills the options tab**, and Firefox's behavior there is unverified. | Pinned by the L4 flow (§10), which continues working in that tab's aftermath. The 100 ms delay guarantees the "Saved" status paints first. |
| **Reload drops in-memory guards** — `freshlyReopened`, disposer timers. | Saving happens from the options page with no navigation in flight, so the F1 guard has nothing to protect. The disposer sweeps orphans immediately at startup (`disposer.ts:57`), so temps are self-healing. `tmpSuffix` is fixed in §9. |
| **A schema change strands a stored config**, leaving the author with temporary-only routing. | The §6 failure is safe and self-announcing: the options page opens with the error and the original text intact, so the fix is an edit, never a reinstall. |
| **AMO signing fails or the ID is rejected.** | `npm run package` produces a working unsigned XPI regardless; the temporary-install path (`npm run manual`) is untouched, so a signing problem never blocks development. |
| **A bad seed ships in a signed build**, making a fresh install temporary-only. | `npm run package` / `sign` parse the config file and fail on a `ConfigError` before invoking the build. The check belongs to **those scripts, not to `buildExtension`** — the L4 test in §10 depends on `buildExtension` accepting a deliberately invalid seed, so validating inside it would make that test unwritable. |

## 12. What this slice does *not* prove

- **That the config is any good.** Editing rules against real sites is the point of
  shipping this; the deferred CONFIG.md questions stay deferred until there is data.
- **Migration between config schema versions.** There is one schema and one user. A
  breaking change surfaces via §6, which is the whole plan for now.
- **Multi-machine or multi-profile config sync.** `storage.local` only.
- **MV3 readiness.** `options_ui`, `storage.local`, and `runtime.reload()` all carry over,
  but the persistent-background assumption in §2 does not. F8 remains open.
