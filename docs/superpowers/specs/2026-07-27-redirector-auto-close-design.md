# Redirector Auto-Close — Design

**Date:** 2026-07-27
**Status:** Implemented
**Topic:** Close a `redirector`-rule tab after a short delay **iff it is still stranded on
the shim domain** — the third Temporary Containers carry-over alongside the `cookies`
and `scripts` overlays. Proven pure/at L3 (mock `browser.*` + fake clock) and confirmed
once in real Firefox (L4).

## 1. Goal & scope

CONFIG.md's `redirector: true` action marks a transient link shim (`t.co`,
`slack-redir.net`, `outgoing.prod.mozaws.net`): the hop is not isolated (like
`inherit`), **and** the tab is auto-closed if — after a short delay (~2s) — it is
*still stranded on the shim domain*. The resolver already returns `{ kind: "stay" }`
for `redirector` (the hop is not isolated); the engine correctly does nothing. What is
missing is the **auto-close**: no module today watches for tabs that complete loading on
a redirector domain and closes them after the delay if they haven't moved on.

This slice implements that auto-close end to end.

The auto-close is **not a routing decision**: it never decides a tab's container (the
`redirector` action already did that — `stay`). It applies a within-tab lifecycle
side-effect *after* routing has left the tab where it is. It fires whenever a tab
completes loading on a URL whose first-matching rule's action is `redirector`.

### In scope

- A new **`redirector-closer`** module (`src/engine/redirector-closer.ts`), a sibling of
  the engine, disposer, cookie-seeder, and script-injector, wired at the extension entry
  (`background.ts`).
- A pure **`isRedirectorUrl(url, config)`** check (does this URL match a `redirector`
  rule?) routed through the same injected `matchRule` as the router.
- `BrowserPort` addition: `onTabUpdated` (+ `TabUpdateInfo` type). The closer is the
  first consumer of `tabs.onUpdated`.
- The `Clock` interface (already present for the disposer) is reused for the delay — no
  new timing seam.
- Tests down the pyramid: pure (`isRedirectorUrl`), L3 closer against the mock port +
  fake clock, one L4 real-Firefox confirmation.

### Out of scope (deferred)

- **The choice screen / picker UI** — a separate, larger slice; `onChoice` remains a
  no-op stub.
- **Configurable delay** via user config — fixed/injected constant here (same as the
  disposer's grace).
- **History / cookie clearing on close** — we only close the tab; the disposer handles
  container cleanup.
- **`redirector` chains** (e.g. `t.co` → `slack-redir.net`) — each hop is independently
  closed after its own delay; no chain-aware logic.

## 2. Architecture & model

A new **`redirector-closer`** owns the auto-close. It makes no routing decisions and
never opens or moves a tab — it only closes a tab that is still on a shim domain after
the delay. Like the disposer, it is a **sibling** of the interception engine: both are
wired at `background.ts`, not nested, so `engine.ts` and `resolve()` stay untouched and
the close logic is tested independently of routing.

The closer owns **one `tabs.onUpdated` listener**. It fires on `status: 'complete'`
(the page finished loading), checks whether the tab's URL matches a `redirector` rule,
and if so schedules a delayed close. After the delay it **re-checks** the tab's URL:
only if the tab is *still* on a redirector domain does it close the tab. A tab that
redirected onward in-place (the URL changed to a non-redirector domain) is left alone.

```
  tabs.onUpdated (closer)  ◄──── fires on every tab update
        │  if info.status != "complete": return             (pure early-out)
        │  if !isRedirectorUrl(tab.url, config): return      (pure; non-redirector ⇒ skip)
        ▼
  clock.setTimeout(closeAfterDelay, ~2s)
        │
        ▼  (delay elapses)
  tab = getTab(tabId); if !tab: return                      (tab already closed — fine)
  if !isRedirectorUrl(tab.url, config): return              (navigated onward — leave it)
  removeTab(tabId)                                          (still stranded — close)
```

**Why the re-check is the safety mechanism — not timer cancellation.** A tab may fire
`complete` on a redirector domain and then redirect onward before the delay elapses
(server-side 301, client-side JS redirect, meta refresh). The `Clock` interface returns
`void` (no cancellation), so the timer always fires — but the re-check inside the
callback reads the tab's *current* URL and skips the close if it has moved on. This is
deterministic (no race between cancel and fire) and matches TCP's
`maybeCloseRedirectorTab`, which re-reads the tab URL after the delay rather than
cancelling.

**Why `complete` and not `onBeforeRequest`.** The engine's `onBeforeRequest` fires
before the page loads; a redirector tab at that point hasn't loaded yet and may still
redirect. `tabs.onUpdated` with `status: 'complete'` fires after the page has fully
loaded — the point at which a shim that hasn't redirected is genuinely stranded. TCP
uses the same trigger.

**Decoupling from the routing `Decision` is correct.** The `redirector` action returns
`stay`; the engine does nothing (the tab loads the shim page). The closer independently
observes `tabs.onUpdated` and acts on the tab's *current URL* — it never inspects the
`Decision` or the rule's action via the engine. A reopened tab (the destination's
reopen) is closed by the engine's `removeTab`; the closer's `getTab` then returns null
for that tab id, so the closer never double-closes it.

## 3. The pure core

- **`isRedirectorUrl(url, config, matchRule): boolean`** — returns `true` iff the
  **first rule** whose `match` covers `url` has action `redirector`. Uses the injected
  `matchRule` (first-match precedence), so it inherits the exact routing precedence and
  can't drift from it. Returns `false` for no-match, and for any other action (`open` /
  `inherit` / `ignore`). This is the whole "does the auto-close apply?" decision — pure,
  no browser.

## 4. Behavior: TC parity (delayed conditional close)

The closer mirrors TCP's `maybeCloseRedirectorTab` (`tcp/src/background/tabs.ts`):

```
onTabUpdated((tab, info):
  if info.status != "complete": return
  if !isRedirectorUrl(tab.url, config, matchRule): return   # pure early-out
  tabId = tab.id
  clock.setTimeout(async () => {
    current = await port.getTab(tabId); if !current: return  # tab gone — fine
    if !isRedirectorUrl(current.url, config, matchRule): return  # moved on — leave it
    await port.removeTab(tabId)                              # still stranded — close
  }, delayMs)
```

Three-pronged F12 guarantee, matching TCP and CONFIG.md:

1. **The close never fires before the delay** — the `clock.setTimeout` schedules it;
   L3 tests with the fake clock assert nothing happens before `advance(delayMs)`.
2. **A tab that redirected onward in-place is never closed** — the re-check reads the
   tab's current URL; if it's no longer a redirector domain, the close is skipped.
3. **A stranded shim tab is closed** — if the tab is still on the shim domain after the
   delay, `removeTab` fires. This is the case `inherit` alone can't clean up: the shim
   tab lingered because its destination was reopened into another container (or it never
   redirected at all).

**No timer cancellation needed.** If the tab closes before the timer fires (user
action, engine reopen), `getTab` returns `null` and the callback returns. If the tab
navigates onward, the re-check returns. Multiple `complete` events on the same tab
(e.g. a reload) schedule multiple timers; the first to fire closes the tab, subsequent
ones find `getTab` returns `null` and return — no double-close, no error.

## 5. Port seam

`BrowserPort` gains one method (real adapter in `browser-port.ts`, mock in the L3 test
double):

- **`onTabUpdated(handler)`** — real port binds `browser.tabs.onUpdated`; the handler
  receives `(tab: Tab, info: TabUpdateInfo)` where `TabUpdateInfo = { status?: "loading"
  | "complete" }`. The mock stores the handler so a test can fire scripted updates via
  `emitTabUpdated` — exactly how `onTabCreated`/`onTabRemoved` are mocked today.

New type in `port.ts`: `TabUpdateInfo { status?: "loading" | "complete" }`. The adapter
method is mechanical and logic-free, like the rest of `browser-port.ts`.

The `Clock` interface (already present for the disposer) is reused unchanged.

## 6. Wiring

`background.ts` adds one line beside the engine, disposer, cookie-seeder, and
script-injector:

```ts
createRedirectorCloser({ port, clock: realClock, config, deps: { matchRule }, delayMs: __CC_REDIRECTOR_DELAY_MS__ });
```

`config` is the same parsed config the engine uses; `matchRule` is the same injected
matcher; `realClock` is the same clock the disposer uses. `__CC_REDIRECTOR_DELAY_MS__`
is an esbuild `define` (default `2000`), injected by `buildExtension` exactly like
`__CC_GRACE_MS__`. No change to `createEngine`, `createDisposer`, `createCookieSeeder`,
or `createScriptInjector`.

## 7. Testing (down the pyramid)

- **Pure (no browser):**
  - `isRedirectorUrl` — `true` for a URL matching a `redirector` rule; `false` for
    no-match, `open`, `inherit`, `ignore`; first-match precedence (a `redirector` rule
    above a broad `open` rule wins; a broad `open` rule above a `redirector` rule means
    the redirector never matches).
- **L3 (mock port + fake clock):**
  - a tab completing on a redirector domain → after `advance(delayMs-1)` not closed;
    after `advance(1)` closed.
  - a tab that navigates onward before the delay → not closed (re-check finds a
    non-redirector URL).
  - a tab on a non-redirector domain → no timer scheduled (pure early-out).
  - a tab closed before the timer fires → `getTab` returns null, no error, no
    double-close.
  - `loading` status → no-op.
  - non-http(s) URL → no-op.
- **L4 real Firefox (F12 redirector):** a bundled `redirector` rule → navigate to the
  shim domain; after the (short) delay, assert the tab is closed (window handle gone);
  a non-redirector tab is NOT closed after the same wait. One confirmation, tolerant of
  headless timing per the existing L4 conventions.

## 8. Risks & mitigations

- **F12 close-before-delay** — mitigated by scheduling on `clock.setTimeout`; L3 with
  the fake clock asserts the close doesn't fire before `advance(delayMs)`.
- **F12 close-onward-navigation** — mitigated by the URL re-check after the delay; L3
  asserts a tab that navigated onward is left alone.
- **Closer fires for every tab update** (all tabs, all statuses) — cheap: the
  `status !== 'complete'` and `isRedirectorUrl` checks are pure early-outs before any
  `await`.
- **Multiple timers on the same tab** — harmless: the first close renders subsequent
  `getTab` calls null; no double-close.
- **L4 real timing** — short test delay (200ms via `ccRedirectorDelayMs`) + poll window
  handles with a timeout; assert eventual absence/presence.

## 9. What this slice does *not* prove

The choice screen / picker UI, configurable delay via user config, MV3 timer
persistence (F8), and history/cookie clearing on close. It proves the redirector
auto-close is now *closed*: a shim tab stranded on a `redirector` domain is cleaned up
after the delay, while a tab that redirected onward is left alone — deterministically
(L3) and once for real (L4).
