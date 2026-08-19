# Scripts Overlay — Design

**Date:** 2026-07-27
**Status:** Implemented
**Topic:** Inject a rule's configured `scripts` snippets at `document_start` so they
run *before* the page's own scripts (F12) — the sibling of the `cookies` overlay. Full
parity with the Temporary Containers `scripts` carry-over. Proven pure/at L3 (mock
`browser.*`) and confirmed once in real Firefox (L4).

## 1. Goal & scope

CONFIG.md's `scripts` overlay lets a rule inject a snippet at `document_start` when its
domain loads — to dismiss a modal or set a `localStorage` pref before the page runs.
Today the parser **allow-lists the `scripts` key but silently drops it**
(`ALLOWED_RULE_KEYS` includes it, but `parseRule` never reads it), the `Rule` type has
no field for it, and the engine has no injection step. This slice implements the overlay
end to end, mirroring the cookies-overlay slice that preceded it.

The overlay is **not a routing action**: it never decides a tab's container or lifecycle.
It applies a within-container side-effect *after* routing has put the tab wherever it
belongs. It fires whenever its rule matches, whatever the rule's action resolved to
(`open` / `inherit` / `redirector` / auto-name), **except `ignore`** — there the engine
does nothing at all (the parser rejects `scripts` on an `ignore` rule, same as `cookies`).

### In scope

- A new **`script-injector`** module (`src/engine/script-injector.ts`), a sibling of the
  engine, disposer, and cookie-seeder, wired at `background.ts`.
- A pure **`scriptsFor(url, config)`** overlay-matching function plus a pure
  **`scriptRegistrations(config)`** that flattens all rules' scripts into
  `browser.contentScripts.register` argument shape.
- A pure **`matcherToPatterns(m)`** in the matcher module — `HostMatcher → WebExtension
  match patterns` — so the injector can register against URL patterns (not per-URL).
- Config-parser + type changes: a `ScriptSpec` type, `Rule.scripts?`, and real parsing +
  validation of the `scripts` key (including rejecting it on an `ignore` rule).
- `BrowserPort` addition: `registerContentScript` (+ the detail/handle types).
- Tests down the pyramid: pure (`scriptsFor`, `matcherToPatterns`,
  `scriptRegistrations`), config-parse validation, L3 injector against the mock port,
  one L4 real-Firefox F12 confirmation.

### Out of scope (deferred)

- **MV3 / `userScripts` migration** — CONFIG.md notes scripts are "delivered via the
  `userScripts` API" under MV3. The extension is MV2 today (like the cookies slice), so
  this slice uses Firefox's MV2 **`browser.contentScripts.register`** with inline `code`.
  The `ScriptSpec` and `scriptRegistrations` pure core are delivery-agnostic; an MV3
  slice would only swap the port-adapter method body for `userScripts.register` (and
  gain a `world: "MAIN"` option). No behavioral change to the overlay.
- **Main-world execution** — `contentScripts.register` runs in the content-script
  isolated world (shared DOM + `localStorage`, not JS context). Both real-config scripts
  are `localStorage.setItem(...)`, which works in the isolated world. A future script
  needing the page's JS context is the MV3 slice's problem.
- **Config-change hot-reload** — registration happens once at startup. Reloading
  registrations on a config edit is deferred with the config-from-storage slice.
- **The `cookies` overlay** — already shipped; this slice adds `scripts` alongside it
  (a rule may carry both, as `youtube.com` does in the real config).

## 2. Architecture & model

A new **`script-injector`** owns script injection. Unlike the cookie-seeder (a
**per-request** blocking `onBeforeSendHeaders` listener, because cookies must be written
into the store and onto the wire *before* the request is released), the injector is
**registration-based**: at startup it registers each script via
`browser.contentScripts.register`, and Firefox injects it at `runAt` for matching pages
automatically. There is no per-request listener and no interaction with the routing
`Decision` at all.

**Why registration, not per-request.** `document_start` injection can't be reliably hit
from a background event (`tabs.executeScript` fires too late); the WebExtension-native
way to inject at a specific `runAt` is `contentScripts.register`, which Firefox schedules
relative to the document lifecycle. A `document_start` registered script runs **before**
the page's own `<script>`s — the F12 guarantee — and Firefox, not our code, enforces the
timing. Like the seeder, the injector is a **sibling** wired at `background.ts`, not
nested in `createEngine`, so `engine.ts` and `resolve()` stay untouched.

**Why decoupling from the reopen decision is correct.** When a rule reopens a tab into a
different container, the engine *cancels* the original `onBeforeRequest`; the canceled
page never loads, so no registered script fires for it. The **new** tab re-navigates and
the registered script fires in the **final** container — exactly where it should. The
`stay` / already-contained cases load in place and the script fires there too. The
injector never inspects the `Decision`; it registers patterns, and Firefox + routing
together ensure the right tab gets the script.

```
  startup:  for each rule with scripts:
              registerContentScript({ matches: matcherToPatterns(rule.match),
                                       js: [{ code: spec.run }],
                                       runAt: spec.at ?? "document_start" })

  navigation (any tab, any container):
    Firefox injects registered scripts whose `matches` cover the URL, at `runAt`.
    A document_start script runs before the page's own <script>s.   (F12)
    The script runs in the tab's page context → the tab's OWN container storage. (F11)
```

## 3. The pure core

Kept out of the engine per the CLAUDE.md layering rule (matching logic lives in the
matcher, never the engine):

- **`matcherToPatterns(m: Matcher): string[]`** (in `src/matcher/matcher.ts`) — converts
  a `HostMatcher { host }` into the two WebExtension match patterns that exactly cover
  its `matches()` semantics (`h === host || h.endsWith("." + host)` for http/https):
  `["*://<host>/*", "*://*.<host>/*"]`. Future matcher variants switch on `m.kind` here;
  today only `host` exists. This is the matcher's job — it owns the `Matcher` grammar.

- **`scriptsFor(url, config, matchRule): ScriptSpec[]`** (in `src/overlays/scripts.ts`)
  — returns the `scripts` list of the **first rule** whose `match` covers `url`, or `[]`
  when no rule matches or the matched rule's action is `ignore`. Routed through the
  injected `matchRule` (first-match precedence), so it inherits routing precedence and
  can't drift — the same pattern as `cookiesFor`. Used for pure testability; the injector
  itself does **not** call it (registration is pattern-based, not per-URL).

- **`scriptRegistrations(config): ScriptRegistration[]`** (in `src/overlays/scripts.ts`)
  — flattens every rule's `scripts` into the `browser.contentScripts.register` argument
  shape: `{ matches, js: [{ code }], runAt }`. Skips rules with no `scripts` and rules
  whose action is `ignore` (defensive — the parser already rejects `scripts`-on-`ignore`).
  One registration per `(rule, script)` pair, so a rule with two scripts registers twice.
  This is what the injector calls.

## 4. Behavior: registration at startup, Firefox injects at runAt

The injector mirrors the cookie-seeder's "do nothing the config doesn't ask for" stance,
but with no per-request work:

```
createScriptInjector({ port, config }):
  for reg of scriptRegistrations(config):
    await port.registerContentScript({ matches: reg.matches,
                                        js: [{ code: reg.code }],
                                        runAt: reg.runAt })
```

That's the entire runtime. No listener, no event handler, no per-navigation logic. The
F12 timing guarantee is structural: Firefox injects a `document_start` registered
script before the page's own scripts, every time, with no race.

**F11 (identity boundary):** the registered script carries **no `cookieStoreId`** — it
runs in every matching tab, in whatever container that tab is in. A script can only
touch the page/DOM/storage of the tab it's injected into; there is no code path that
reads or writes across containers. (Containers partition `localStorage`, so a script's
`localStorage.setItem` lands in the tab's own container partition, never another's.)

**`runAt` default.** `ScriptSpec.at` is optional and defaults to `"document_start"` —
CONFIG.md's only documented injection point and the F12-critical one. The real config
specifies `at: document_start` explicitly on both entries.

## 5. Config parser & types

- **`ScriptSpec`** (new; mirrors the `browser.contentScripts` `js`/`runAt` surface):
  - `run: string` — **required**, non-empty. The JS source to inject (inline `code`).
  - `at?: "document_start" | "document_end" | "document_idle"` — optional, defaults to
    `"document_start"`. The WebExtension `RunAt` values.
- **`Rule.scripts?: ScriptSpec[]`** — the resolver keeps ignoring it (its type comment
  already notes overlays exist on the real rule but `resolve()` ignores them). This is
  the `scripts` field the cookies slice's comment said "will add its own field the same
  way."
- **`parseRule`** now reads the `scripts` key (today allow-listed but dropped) and
  validates each entry, raising `ConfigError` with a path on:
  - `scripts` not a list, or an entry that isn't a mapping;
  - missing/empty/non-string `run`;
  - `at` outside the allowed set;
  - unknown keys inside a script entry;
  - **`scripts` present on an `ignore` rule** — CONFIG.md forbids overlays on `ignore`.
  - A rule may carry **both** `cookies` and `scripts` (as `youtube.com` does) — both
    parse independently and neither blocks the other.

No manifest change: `browser.contentScripts.register` needs no separate permission
beyond the host permissions (`<all_urls>`) already in `extensions/cc/manifest.json`.

## 6. Port seam

`BrowserPort` gains one method (real adapter in `browser-port.ts`, mock in the L3 test
double):

- **`registerContentScript(details): Promise<RegisteredContentScript>`** — real port
  calls `browser.contentScripts.register(details)` and returns a thin handle wrapping
  the returned `unregister()`. The mock stores the details list so a test can assert
  `matches`/`js`/`runAt` and returns a no-op handle.

New detail types in `port.ts`:
- `RunAt = "document_start" | "document_end" | "document_idle"` (exported; reused as
  `ScriptSpec["at"]`).
- `RegisterContentScriptDetails = { matches: string[]; js: { code: string }[]; runAt: RunAt }`
  (a deliberately narrow slice of Firefox's `RegisteredContentScriptOptions` — only the
  fields this slice uses; `cookieStoreId`/`allFrames`/etc. are omitted so the seam can't
  accidentally scope a script to a container, preserving F11).
- `RegisteredContentScript = { unregister(): Promise<void> }`.

The adapter method is mechanical and logic-free, like the rest of `browser-port.ts`.

## 7. Wiring

`background.ts` adds one line beside the engine, disposer, and cookie-seeder:

```ts
createScriptInjector({ port, config });
```

`config` is the same parsed config the engine and seeder use. No `deps` needed —
`scriptRegistrations` uses `matcherToPatterns` (a pure import) directly, not an injected
matcher, because registration covers **all** rules' patterns rather than resolving a
single URL's first match (no precedence to drift). No change to `createEngine`,
`createDisposer`, or `createCookieSeeder`.

## 8. Testing (down the pyramid)

- **Pure (no browser):**
  - `matcherToPatterns` — a host produces `["*://host/*", "*://*.host/*"]`; the two
    patterns together match exactly what `matches()` does for http(s) (bare host and
    every subdomain).
  - `scriptsFor` — returns the matched rule's `scripts`; `[]` for no-match and for an
    `ignore` rule; first-match precedence (a broad rule below a specific one doesn't
    win). (Mirrors the `cookiesFor` test.)
  - `scriptRegistrations` — flattens a multi-rule config into the register-arg shape;
  skips rules without `scripts` and `ignore` rules; one registration per `(rule, script)`;
  `at` defaults to `"document_start"` when omitted.
- **Config parse:** `scripts` parsed into `Rule.scripts`; each validation error above,
  asserted by message/path; a valid multi-script rule; `scripts`-on-`ignore` rejected;
  a rule carrying both `cookies` and `scripts` parses both. The real config's `youtube`
  + `kraftfuttermischwerk` `scripts` now parse (asserted in `parse.real.test.ts`).
- **L3 (mock port):** the injector against the mock `registerContentScript` —
  - registers each script with the right `matches`/`js`/`runAt`;
  - `at` defaults to `"document_start"` when omitted;
  - no-op (no `registerContentScript` calls) for a config with no scripts;
  - an `ignore` rule's scripts are skipped (defensive, even though the parser rejects
    them — reached only by a hand-built `Config`);
  - multiple scripts on one rule each register separately.
- **L4 real Firefox (F12 timing):** the bundled `work.example` rule gets a
  `document_start` script that sets `localStorage.cc_script = "1"`. The test server's
  page carries an inline `<script>` that records — into a `data-cc-script-at-start`
  attribute — whether `cc_script` was **already** set when the page's own script first
  runs. The L4 test asserts both: `localStorage.cc_script === "1"` (the script ran) and
  `data-cc-script-at-start === "1"` (it ran **before** the page's own script — the F12
  timing half). The script runs in the routed Work container (the engine reopens
  `work.example` into Work; the canceled original never loads, so the script fires only
  in the final tab). One confirmation, tolerant of headless timing per the existing L4
  conventions.

## 9. Risks & mitigations

- **F12 timing race** — mitigated structurally: `document_start` registered content
  scripts run before the page's own scripts by WebExtension contract; no `await` ordering
  to get wrong. L4 proves it by recording the page's own first-read result.
- **Script fires in the wrong container** — impossible by construction: no
  `cookieStoreId` is set, so the script runs wherever the URL loads (i.e. in the tab's
  own container after routing). F11 is preserved because scripts touch only the page
  they're injected into; containers partition storage, so a `localStorage` write lands
  in the tab's own partition.
- **Injector fires once at startup, then never again** — correct for a bundled config;
  a config-edit reload is deferred to the config-from-storage slice (it would
  `unregister()` the handles and re-register). The injector keeps no handles in this
  slice (no reload path yet); a later slice adds handle retention.
- **`contentScripts.register` availability** — Firefox 59+, permissionless (needs only
  host permissions, already present). Inline `code` in `js` is Firefox-supported (Chrome
  rejects it; this is a Firefox-only extension). If a future Firefox deprecates `code`,
  the MV3 `userScripts` slice (out of scope) takes over with the same `ScriptSpec`.
- **Matcher extension** — when `PatternMatcher`/`RegexMatcher` arrive, `matcherToPatterns`
  switches on `m.kind`; a regex matcher has no match-pattern equivalent (would need
  `includeGlobs` or a different registration), flagged then. Today only `host` exists.
```
