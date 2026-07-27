# Choice Screen + Reopen Picker — Design

**Date:** 2026-07-27
**Status:** Approved, pending implementation plan
**Topic:** The keyboard-driven picker for multi-`open` rules — both the **automatic
choice screen** (multi-`open` with no `default`, not already in an eligible container)
and the **manual reopen picker** (a keyboard command that re-offers the matching rule's
`open` list for the active tab). Proven pure/at L3 (mock `browser.*`) and confirmed in
real Firefox (L4). Closes the last unimplemented TESTS.md feature surface besides F9.

## 1. Goal & scope

CONFIG.md §"Choice screen and reopen picker" defines two UI surfaces, both
**keyboard-driven — non-negotiable**:

1. **Choice screen (automatic).** When a multi-`open` rule *without* `default` resolves
   and the tab is not already in an eligible container, the resolver returns
   `{ kind: "choice", options }` (`src/resolver/resolve.ts:70`). The engine already
   cancels the navigation and calls `onChoice(options, { tabId, url })`
   (`src/engine/engine.ts:92`), but `onChoice` is a **no-op stub**
   (`src/extension/background.ts:23`). This slice implements it.
2. **Reopen picker (manual).** A keyboard command re-offers the matching rule's `open`
   list for the *current* tab — e.g. youtube.com (defaulted to `Temporary`) escalated to
   `Personal`. CONFIG.md: "restricted to the matching rule's `open` list."

Both surfaces converge on one operation the engine already performs elsewhere: **reopen
a tab's URL into a chosen container** (create-in-target + remove-old), guarded against
the F1 reopen loop. The missing pieces are (a) the picker *page* (keyboard UI), (b) the
`onChoice`/command handlers that show it, (c) the selection message that drives the
reopen, and (d) exposing the engine's F1-guarded reopen so the picker can trigger it.

### In scope

- **Expose `reopen` from `createEngine`** — the F1-guarded reopen effect (the
  `freshlyReopened` guard is load-bearing; the picker's reopen *must* go through it).
- A new **`picker`** sibling (`src/engine/picker.ts`): owns the `onChoice` flow, the
  reopen-picker command, and the selection-message listener. Wired at `background.ts`
  beside the engine, disposer, cookie-seeder, script-injector, and redirector-closer.
- The **choice page**: `extensions/cc/choice.html` + `src/extension/choice.ts` (bundled
  to `choice.js`). Stateless extension page; keyboard-driven; reports the selection via
  `runtime.sendMessage`.
- `BrowserPort` additions: `updateTab`, `onMessage`, `onCommand`, `getActiveTab`.
- Tests down the pyramid: L3 (mock port) for the picker logic; L4 (real Firefox) for the
  choice screen + reopen picker end to end.

### Out of scope (deferred)

- **Config-from-storage / the text editor UI** — a later slice; the bundled config gains
  one choice rule + one default-Temporary rule for L4.
- **Mouse-only invocation surfaces** (toolbar popup, context-menu submenus) — the
  keyboard command is the sole invocation; the page accepts keyboard (primary) and click
  (secondary) selection.
- **Remembering choices** — explicitly forbidden by CONFIG.md; inherent (the resolver
  always re-emits `choice`), no caching added.
- **F9 redirect binding** — a separate, browser-real slice.
- **F8 MV3 service-worker persistence of an in-flight choice** — MV2 background is
  persistent; a choice is a sub-second interaction. Noted as residual risk (§9).

## 2. Architecture & model

A new **`picker`** owns both surfaces. It makes no routing decisions: routing already
resolved to `choice` (automatic) or to nothing (manual — the tab is already loaded). The
picker's job is to **show options and, on selection, trigger the engine's reopen**. Like
the other siblings, it is wired at `background.ts`, not nested in `createEngine`, so
`engine.ts` and `resolve()` stay focused on request-time routing.

```
 AUTOMATIC (choice screen)                    MANUAL (reopen picker)
 ──────────────────────────                   ──────────────────────
 onBeforeRequest → resolve → {choice}         keyboard command
 engine cancels, calls onChoice(options,nav)  onCommand("reopen-picker")
        │                                            │
        ▼                                            ▼
 picker.showChoice(tabId, url, options)       picker.showForActiveTab()
        │                                            │
        │  port.updateTab(tabId, choiceUrl)          │  port.getActiveTab() → rule lookup
        │  (params in URL hash)                      │  port.updateTab(tabId, choiceUrl)
        ▼                                            ▼
 choice.html renders options + key hints      choice.html (same page)
        │  user presses a key / clicks               │  user presses a key / clicks
        ▼                                            ▼
 runtime.sendMessage({type:"cc-pick",…})       runtime.sendMessage({type:"cc-pick",…})
        │                                            │
        ▼                                            ▼
 picker.onMessage → engine.reopen(tab,url,target)   (same path)
```

Both flows converge on `engine.reopen(oldTab, url, target)`, which is the engine's
existing reopen effect (now exposed) — guaranteeing the **F1 `freshlyReopened` guard**
fires for the reopened tab's first navigation. The picker never reopens a tab by hand;
it always goes through `engine.reopen`.

**Why the choice page is an extension page, not an injected content script.** The
triggering tab's URL is arbitrary (often `about:blank` for a fresh tab); injecting into
arbitrary pages needs host permissions and is fragile. An extension page
(`moz-extension://<id>/choice.html`) is the standard WebExtension pattern for in-
extension UI, loads with no host-permission fuss, and is skipped by the engine's
`onBeforeRequest` (non-`http(s)`), so it cannot loop.

**Why the triggering tab is reused (not a new tab).** The engine cancelled the
navigation, so the tab sits on its previous page. Navigating *that* tab to the choice
page replaces the dead page; on selection, `reopen` creates the destination tab in the
chosen container and removes the choice tab — exactly the engine's reopen placement
(same index/active). Reusing the tab avoids orphaning a blank tab and matches the user's
mental model ("this tab is going to figma.com").

**Stateless choice page.** The picker encodes `{ tabId, url, options }` into the page's
URL hash as one `encodeURIComponent(JSON.stringify(...))` payload. The page decodes it,
renders the options with key hints, and on selection sends
`runtime.sendMessage({ type: "cc-pick", tabId, url, container })`. The background holds
**no pending-choice state** — the message carries everything. This sidesteps F8 (nothing
to lose on restart) and keeps the page dumb. A restart mid-choice simply loses the
choice page itself (the tab reverts to its pre-choice page on a fresh load), which is
acceptable: the user re-navigates.

## 3. The reopen effect (extraction)

The engine's `case "reopen"` body (`src/engine/engine.ts:98-118`) becomes a method on
the object `createEngine` returns:

```ts
export interface Engine {
  reopen(tab: Tab, url: string, target: Target): Promise<void>;
}
export function createEngine(opts: EngineOptions): Engine { … }
```

`reopen` does exactly the current body, minus the request-time concerns (MAC check,
`handled`) that belong only to `onBeforeRequest`, and **throws on failure** (it does not
swallow) so callers can react:

1. `const store = await registry.toStoreId(target);`
2. `const created = await port.createTab({ url, cookieStoreId: store, index: tab.index, active: tab.active, openerTabId: tab.openerTabId });`
3. `freshlyReopened.add(created.id);` — **the load-bearing F1 guard** (CLAUDE.md).
4. `await port.removeTab(tab.id);`

The engine's own `case "reopen"` calls `this.reopen(tab, d.url, decision.into)` inside
the existing `try/catch` — DRY, one reopen path, and the catch preserves the current
fail-open (clear `handled`, warn, do not cancel). The `choice` case is unchanged (cancel
+ `onChoice`); the picker later calls `reopen`. The MAC check in the `choice` case stays
(F7 defer before showing the picker); `reopen` itself does not re-check MAC (the choice
already passed it). The picker's `onMessage` handler `await`s `reopen` and **returns
`{ok:true}` / `{ok:false}`** to the choice page, so the page can fail-open on a thrown
reopen (§4).

`Target` (`{kind:"default"} | {kind:"permanent",name} | {kind:"temporary"}`) is already
the resolver's reopen target type. The picker maps a chosen container name to a `Target`:
`"Temporary"` → `{kind:"temporary"}`, anything else → `{kind:"permanent",name}`.

## 4. The choice page (`extensions/cc/choice.html` + `src/extension/choice.ts`)

**URL:** `moz-extension://<id>/choice.html#<payload>` where
`payload = encodeURIComponent(JSON.stringify({ tabId, url, options }))`.

**Render:** a numbered list of `options`, each an `<li data-cc-option data-key="1"
data-container="Personal">1 · Personal</li>`. Keys are `1..9` then `a..z` for >9 (a
config won't exceed a handful; the fallback exists so the page never breaks). The page
also shows the destination URL for context.

**Selection (keyboard primary, click secondary):** on `keydown` of a key matching a
`data-key`, or `click` on an `<li>`, the page sends
`browser.runtime.sendMessage({ type: "cc-pick", tabId, url, container })` and **awaits
the response**. The picker's `onMessage` handler `await`s `engine.reopen(...)` and
returns `{ok:true}` on success or `{ok:false}` on a thrown reopen. On `{ok:true}` the
page shows "Opening <container>…" — the background's reopen then removes this tab (the
choice tab is the old tab `reopen` removes). On `{ok:false}` the page navigates back to
`url` (fail-open: the user is not stranded on the choice page, matching the engine's own
reopen fail-open).

**Esc:** dismisses the choice — the page navigates back to `url` (no reopen; the
navigation the engine cancelled is effectively abandoned, same as the user closing the
tab). The engine's `handled` guard already prevents a re-fire of the cancelled request.

**No remembering:** the page holds no storage; nothing persists between visits.

## 5. Port seam

`BrowserPort` gains four methods (real adapter in `browser-port.ts`, mock in the L3 test
double). All are mechanical, logic-free, mirroring the existing seams:

- **`updateTab(tabId, props: { url: string }): Promise<void>`** — real port binds
  `browser.tabs.update(tabId, { url })`. Used to navigate the triggering tab to the
  choice page. The mock stores the last update so a test can assert the choice URL.
- **`onMessage(handler: (msg: unknown) => unknown | Promise<unknown>): void`** — real
  port binds `browser.runtime.onMessage.addListener` and **returns the handler's result**
  so the choice page gets a response (`{ok:true}` / `{ok:false}`). The mock stores the
  handler so a test fires the selection message directly and reads the response.
- **`onCommand(handler: (name: string) => void): void`** — real port binds
  `browser.commands.onCommand.addListener`. The mock stores the handler.
- **`getActiveTab(): Promise<Tab | null>`** — real port does
  `(await browser.tabs.query({ active: true, currentWindow: true }))[0]` mapped to `Tab`;
  null if none. The reopen picker uses it.

The choice page itself uses `browser.runtime.sendMessage` directly (it is an extension
page with its own `browser` global) — **no `sendMessage` on the port**, which stays the
background-only seam.

## 6. Wiring

`background.ts`:

```ts
const engine = createEngine({ port, config, deps, onChoice: (options, nav) =>
  picker.showChoice(nav.tabId, nav.url, options) });
createPicker({ port, config, deps, reopen: engine.reopen });
```

`onChoice` is no longer a no-op: it forwards to `picker.showChoice`. The picker is
constructed with `engine.reopen` (dependency injection) so its reopens go through the
F1 guard. `createEngine` now returns `{ reopen }`, so `background.ts` captures the return
value (previously discarded).

`manifest.json` gains:

```json
"commands": {
  "reopen-picker": { "suggested_key": { "default": "Ctrl+Shift+O" }, "description": "Reopen this tab in a container" }
}
```

`build-extension.ts` adds `src/extension/choice.ts` as a second entry point (esbuild
multi-entry) output to `extensions/cc/choice.js`. `choice.html` references `choice.js`.
No `web_accessible_resources` — the extension opens its own page, so no web page loads
it.

The bundled config gains a choice rule and a default-Temporary rule (for the reopen
picker L4):

```yaml
- match: figma.example
  open: [Personal, Work]
- match: youtube.example
  open: [Temporary, Personal]
  default: Temporary
```

`harness/firefox.ts` adds `figma.example,youtube.example` to the
`network.dns.localDomains` pref (beside `work.example,nomatch.example,redirect.example`).

## 7. Testing (down the pyramid)

- **L3 picker (mock port):**
  - `showChoice` → `updateTab` called with the choice URL containing the encoded
    `{tabId,url,options}`.
  - `onMessage({type:"cc-pick", tabId, url, container:"Work"})` → `reopen` called with
    the old tab, `url`, `{kind:"permanent",name:"Work"}`; the choice tab is removed by
    `reopen`.
  - `container:"Temporary"` → `reopen` target `{kind:"temporary"}`.
  - Reopen picker: `onCommand("reopen-picker")` with an active tab on a multi-`open`
    rule → `updateTab` to the choice page with that rule's containers. Active tab on a
    single-`open` rule → no choice page (nothing to choose; reopen into the one container
    directly? No — do nothing; the picker is for *choosing*). Active tab on no rule →
    no-op (the undecided unmatched case; CONFIG.md leaves it open).
  - Esc is page-side; not asserted at L3 (no port effect beyond navigation, which the
    page does itself).
- **L3 engine (existing test update):** `createEngine` now returns `{ reopen }`; the
  existing choice test asserts `onChoice` fires (unchanged); a new test asserts
  `engine.reopen` performs create+guard+remove and that the reopened tab's first
  `onBeforeRequest` is left alone (F1, via the guard).
- **L4 real Firefox (choice screen):** navigate `figma.example` → the tab becomes the
  choice page; Selenium reads the `[data-cc-option]` list (asserts `Personal,Work`),
  sends the key for `Work` → `awaitContainerTab` for `figma.example` in the `Work`
  container. Then a fresh tab navigates `figma.example` again → choice page reappears
  (never remembered).
- **L4 real Firefox (reopen picker):** navigate `youtube.example` → routes to a fresh
  `tmp` (default `Temporary`); send the `Ctrl+Shift+O` command → choice page offers
  `Temporary,Personal`; choose `Personal` → `awaitContainerTab` for `youtube.example` in
  `Personal`.

## 8. Risks & mitigations

- **F1 (choice-driven reopen loops)** — mitigated by routing the picker's reopen through
  `engine.reopen`, which adds the new tab to `freshlyReopened`. L3 asserts the reopened
  tab's first `onBeforeRequest` is a no-op.
- **F2 (already eligible)** — the resolver returns `stay` for a tab already in an
  eligible container; the engine never calls `onChoice`; no choice page. L3 covers via
  the existing resolver tests; L4 covers by re-navigating from within `Work`.
- **Choice page not focused for keydown** — mitigated by reusing the *active* triggering
  tab (its `active` is preserved through `updateTab`), so the page has focus. L4 sends
  the key to the page body; if headless focus is flaky, the page also accepts `click`
  (secondary), and the L4 test clicks the `<li>` as a fallback.
- **Command L4 flakiness** — `Ctrl+Shift+O` may not fire `onCommand` reliably in headless
  Firefox if focus/timing is off. Mitigation: L3 covers the command *handler* logic
  fully; the L4 command test is the real-Firefox confirmation. If it proves flaky in CI,
  the command's `suggested_key` is the only knob — the handler is correct. (Accepted
  residual; F7/F1 are not in play for a manual user action.)
- **Choice URL length** — `tabId`+`url`+`options` encoded is short; no browser limit
  concern. Container names with special chars are JSON-encoded safely.
- **Multiple in-flight choices** — each is a distinct tab with its own encoded payload;
  the stateless design means they cannot interfere.

## 9. What this slice does *not* prove

Config-from-storage / the text editor UI, mouse-only invocation surfaces (toolbar popup,
context menu), F8 MV3 persistence of an in-flight choice (the stateless design makes this
moot), and F9 redirect binding. It proves the choice screen and reopen picker are now
*closed*: a multi-`open`-no-default navigation surfaces a keyboard picker, a manual
command re-offers the rule's list, both re-open into the chosen container through the
F1-guarded reopen — deterministically (L3) and once for real (L4).
