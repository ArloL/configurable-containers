# L3 Engine — Minimal Spine — Design

**Date:** 2026-07-27
**Status:** Approved, pending implementation plan
**Topic:** The thin interception adapter that turns real navigations into a
`NavContext`, calls the pure `resolve()`, and executes the returned `Decision` —
proven at L3 (model-based, mock `browser.*` + no clock). The minimal spine only:
F1, F2, F7.

## 1. Goal & scope

Build the **interception & lifecycle engine** — the "thin adapter" the L1 resolver
design (§8) deliberately deferred. Given real browser navigation events, it
assembles a `NavContext`, calls `resolve(nav, config, deps)`, and *executes* the
`Decision` as effects (reopen / stay / leave-alone / emit-choice). It owns event
plumbing and effects; it owns **no routing logic** — every container decision comes
from `resolve()`.

This slice is the **minimal spine**, proven at TESTING.md **L3** (model-based:
event sequences + invariants against a mock `browser.*` API). It is the
deterministic owner of:

- **F1** — reopen loop / double-tab-open.
- **F2** — "already correctly contained" honoured (no churn).
- **F7** — race / MAC coexistence: defer to Multi-Account Containers when it owns
  the URL, via the `getAssignment` handshake.

### In scope

- A narrow injected `BrowserPort` facade + the mock port that drives L3 tests.
- `ContainerRegistry`: `cookieStoreId ⇄ ContainerRef`, temporary identified by the
  `tmp` name prefix, permanent find-or-create.
- The blocking `onBeforeRequest` handler: NavContext assembly, `resolve()` call,
  Decision execution, the F1 `handled` guard, the F7 MAC-defer handshake.
- `choice` emitted via an injected callback (no picker UI).
- Table-driven + property-based (fast-check) L3 tests.

### Out of scope (deferred to sibling slices)

- **F10** — temporary-container disposal / lifecycle. This slice *creates*
  throwaways but never disposes them (accepted; called out in §4).
- **F8** — MV3 background-restart guard-state persistence. The `handled` guard and
  the registry's caches are in-memory. (The `tmp`-prefix identity is durable and is
  a partial head-start — see §3.)
- **F12** — overlay side-effects (cookie/script seeding) and the redirector
  auto-close timing.
- **F9** — redirect binding (POST preservation) and the different-`requestId`
  same-tab server-redirect window (TCP's `canceledTabs`). See §4.
- **Real `browser.*` adapter (L4)** and the actual choice-picker / config-editor /
  management UIs.

## 2. Architecture & boundaries

```
   browser.* events                         pure core (done)
   webRequest.onBeforeRequest ─┐
                               ▼
                    ┌────────────────────┐   nav    ┌──────────┐
                    │      engine.ts     │─────────▶│ resolve()│
                    │  (onBeforeRequest  │◀─────────│          │
                    │   handler)         │ Decision └──────────┘
                    └─────────┬──────────┘               ▲
             NavContext │     │  reads/creates            │ Deps:
             assembly   │     │  containers, tabs         │ matchRule, matchGroup,
                   ┌─────────────┐   ┌──────────────┐     │ sameSite (all done)
                   │ registry.ts │   │   port.ts    │  ← narrow typed facade over
                   │ store ↔ Ref │   │ BrowserPort  │    webRequest/tabs/
                   └─────────────┘   └──────┬───────┘    contextualIdentities/runtime
                                            │
                              ┌─────────────┴─────────────┐
                              ▼ (L4, later)               ▼ (this slice)
                        real browser.* adapter      mock port + mock MAC
```

Modules (all under `src/engine/`):

- **`port.ts`** — the `BrowserPort` interface plus the plain data types it passes.
  The only thing that knows `browser.*` exists. Real adapter is an L4 concern; this
  slice ships the interface + the mock.
- **`registry.ts`** — `ContainerRegistry`: the bidirectional map between a
  `cookieStoreId` and the resolver's `ContainerRef`, plus find-or-create for reopen
  targets.
- **`engine.ts`** — the `onBeforeRequest` handler, NavContext assembly, the F1
  `handled` guard, the F7 MAC handshake, `MAC_ID`.

The engine only *consumes* `src/resolver/`, `src/matcher/`, `src/psl/`,
`src/config/`; none of them change.

## 3. `BrowserPort` and `ContainerRegistry`

### 3.1 `BrowserPort` (port.ts)

A deliberately narrow, `Promise`-based facade — only the surface the spine touches.

```ts
export interface WebRequestDetails {
  requestId: string;
  tabId: number;
  url: string;              // target of the navigation
  type: "main_frame" | "sub_frame" | string;
  method: string;          // "GET" | "POST" | …  (spine routes main_frame only)
  originUrl?: string;
  documentUrl?: string;
}

export interface Tab {
  id: number;
  url: string;             // "" / about:blank for a fresh tab
  cookieStoreId: string;   // "firefox-default" | "firefox-container-N"
  index: number;           // preserved across a reopen
  active: boolean;         // preserved across a reopen
  openerTabId?: number;    // set when opened from another tab
}

export interface ContextualIdentity {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}

export interface BlockingResponse { cancel?: boolean }

export interface BrowserPort {
  // engine registers one handler; real port binds it to
  // webRequest.onBeforeRequest {blocking, main_frame}; mock lets tests fire it.
  onBeforeRequest(
    handler: (d: WebRequestDetails) => Promise<BlockingResponse | void>
  ): void;

  getTab(tabId: number): Promise<Tab | null>;
  createTab(props: {
    url: string; cookieStoreId: string;
    openerTabId?: number; index?: number; active?: boolean;
  }): Promise<Tab>;
  removeTab(tabId: number): Promise<void>;

  queryIdentities(): Promise<ContextualIdentity[]>;
  createIdentity(props: { name: string; color: string; icon: string }):
    Promise<ContextualIdentity>;
  getIdentity(cookieStoreId: string): Promise<ContextualIdentity | null>;

  // MAC coexistence handshake (F7).
  sendExternalMessage(extensionId: string, message: unknown): Promise<unknown>;
}
```

The engine *registers* one handler; the real port binds it to the blocking event,
the mock port stores it so a test can invoke it with scripted details and inspect
the returned `BlockingResponse`. That is the entire L3 driving seam.

### 3.2 `ContainerRegistry` (registry.ts)

`resolve()` speaks `ContainerRef` (`default | permanent{name} | temporary`); the
browser speaks `cookieStoreId`. The registry is the only bridge.

`toRef(cookieStoreId) → ContainerRef`:

- `"firefox-default"` → `{ kind: "default" }`.
- else `getIdentity(cookieStoreId)`, then by `name`:
  - name starts with **`TMP_PREFIX` (`"tmp"`)** → `{ kind: "temporary" }`.
  - otherwise → `{ kind: "permanent", name }`.
- identity missing (tab cites a container that no longer exists) → `{ default }`
  with a logged warning.

`toStoreId(target) → cookieStoreId`:

- `{ default }` → `"firefox-default"`.
- `{ permanent, name }` → **find-or-create**: `queryIdentities()`, match by exact
  `name`; if absent, `createIdentity({name, …})`. Return its `cookieStoreId`. A
  small `name → cookieStoreId` cache avoids repeat queries.
- `{ temporary }` → `createIdentity({ name: TMP_PREFIX + suffix(), … })`; the
  browser/mock assigns the `cookieStoreId`; it reads back as `temporary` purely
  from its name prefix.

Consequences of the `tmp`-prefix approach (confirmed against TCP's default
`namePrefix`):

- **No throwaway `Set` needed** — temporary identity is stateless, derived from the
  name, so it survives a background restart for free (a partial head-start on F8;
  the rest of F8's guard state is still out of scope).
- **Reserved prefix.** A user naming a *permanent* container `tmp…` in their config
  would be misclassified as temporary. Known constraint; TCP reserves the prefix the
  same way.
- **Suffix generation is injectable** for deterministic tests (default: a monotonic
  counter). Only uniqueness matters; the `cookieStoreId` is what the rest of the
  system keys on. Cross-restart suffix collision is an F8-adjacent concern, noted
  not solved.

### 3.3 `NavContext` assembly (engine.ts)

From a `WebRequestDetails d` and the fetched tab:

```ts
const tab = await port.getTab(d.tabId);

targetUrl = d.url;

// current: the tab's pre-navigation state; null for a blank/new tab.
current = (tab && tab.url && tab.url !== "about:blank")
  ? { url: tab.url, container: registry.toRef(tab.cookieStoreId) }
  : null;

// initiator: the container that started this nav (for `inherit`).
//   opened from another tab → opener tab's container
//   same-tab navigation     → the tab's own current container
//   blank tab, no opener     → null
initiator =
    tab?.openerTabId != null
      ? registry.toRef((await port.getTab(tab.openerTabId))?.cookieStoreId)
  : tab
      ? registry.toRef(tab.cookieStoreId)
  :     null;
```

Two honest limitations, both consistent with the L1 spec's own caveats:

- **`initiator` is modeled from opener/current**, not from a click-vs-address-bar
  signal. Faithful enough for F1/F2/F7 and for `inherit`'s common same-tab case; the
  deeper `inherit` correctness is L1's job (F6), already property-tested there.
- **Cross-tab temporary identity collapses** — two throwaways both read as
  `{ temporary }` (exactly the L1 spec §4 limitation).

## 4. The `onBeforeRequest` handler

```ts
async handle(d: WebRequestDetails): Promise<BlockingResponse | void> {
  // (0) Scope — only top-level, http(s) navigations.
  if (d.type !== "main_frame") return;
  if (!/^https?:/.test(d.url)) return;                     // about:, moz-extension:, …

  // (1) F1 loop guard — re-fires of a request we already acted on
  //     (redirect echoes, cancel re-emits) must never spawn a second tab.
  const key = d.requestId + "+" + d.url;
  if (this.handled.has(key)) return { cancel: true };      // re-affirm, don't re-execute

  // (2) Assemble NavContext (§3.3).
  const tab = await port.getTab(d.tabId);
  if (!tab) return;                                        // tab raced away — fail open
  const nav = await buildNavContext(d, tab, registry, port);  // async: may fetch opener

  // (3) Pure decision.
  const decision = resolve(nav, config, deps);

  // (4) Effects.
  switch (decision.kind) {
    case "leaveAlone":                                     // ignore rule
    case "stay":                                           // already correct (F2)
      return;                                              // let it proceed

    case "choice":
      if (await macOwns(d.url)) return;                    // F7 defer
      this.handled.add(key);
      onChoice(decision.options, { tabId: d.tabId, url: d.url });
      return { cancel: true };                             // picker (later) drives reopen

    case "reopen":
      if (await macOwns(d.url)) return;                    // F7 defer
      this.handled.add(key);                               // guard BEFORE async effects
      try {
        const store = await registry.toStoreId(decision.into);
        await port.createTab({
          url: d.url, cookieStoreId: store,
          index: tab.index, active: tab.active, openerTabId: tab.openerTabId,
        });
        await port.removeTab(tab.id);
      } catch (e) {
        this.handled.delete(key);                          // fail open — allow a retry
        log.warn("reopen failed", e);
        return;                                            // do NOT cancel
      }
      return { cancel: true };                             // abort the wrong-container load
  }
}

const MAC_ID = "@testpilot-containers";
async macOwns(url: string): Promise<boolean> {
  try {
    const a = await port.sendExternalMessage(MAC_ID, { method: "getAssignment", url });
    return a != null;
  } catch {
    return false;                                          // MAC absent ⇒ nobody owns it
  }
}
```

Key decisions:

- **F1 guard = `handled` set keyed on `requestId+url`,** added *before* the async
  reopen effects. A redirect/echo of the same request mid-reopen hits the guard and
  returns a bare `{cancel:true}` instead of opening a second tab. Reopen also removes
  the old tab, and the *new* tab is already in the correct container (→ `resolve` =
  `stay`), so the loop is closed both structurally (F2) and explicitly (F1).
- **F2 is structural.** `stay` is a no-op; no "already contained" bookkeeping — the
  purity of `resolve()` earns it.
- **F7 gate at the point of action.** MAC is consulted only when about to *force* a
  container change (`reopen`/`choice`); `stay`/`leaveAlone` skip the round-trip.
  Truthy `getAssignment` ⇒ defer entirely (do nothing). TCP's fancier "reopen the
  confirm page" is out of scope.
- **`choice` emits + cancels.** Cancels the wrong-container load and fires the
  injected `onChoice(options, nav)`; the picker and its follow-up reopen are a later
  slice.
- **Reopen preserves placement** — `index`, `active`, `openerTabId` carried to the
  new tab; old tab removed *after* the new one exists, so there is never a moment
  with no tab.

**Line drawn:** this guard owns the *same-request* re-fire. The
*different-`requestId`-same-tab* server-redirect case (TCP's `canceledTabs` window)
is the natural next increment tied to redirect handling (F9-adjacent), **not** in
this spine — reopen removes the old tab, so that window is small.

## 5. Error handling & edge cases

The handler runs on every top-level nav, so it fails **open** — never leaves the
user with a canceled navigation and no tab.

| Situation | Handling |
|---|---|
| Non-http(s) target (`about:`, `moz-extension:`, `view-source:`) | Skip before assembly — `return`. Can't reopen `about:` pages; `resolve()` on a scheme URL is meaningless. |
| `getTab` returns `null` (tab raced away) | `return`. No tab to replace, no index/active to preserve. |
| `getIdentity` returns `null` (container no longer exists) | `toRef` → `{ default }` + logged warning. Mirrors TCP's "container that does not exist" path. |
| Reopen effect throws (`createTab`/`removeTab` rejects) | `try/catch`: remove the `handled` key, `return` (let the original proceed). `{cancel:true}` only after `createTab` resolves — never a dead canceled tab. |
| MAC absent / `sendExternalMessage` rejects | `macOwns` → `false`. No MAC just means nobody else owns the URL; proceed with our routing. |
| `handled` set unbounded growth | Accepted for the spine (requestIds unique per session). TTL/cap is an F8/cleanup concern, not built. |

## 6. Testing (L3)

Model-based: a mock `BrowserPort` + mock MAC, driven by scripted event sequences,
asserting invariants. Fully deterministic — no real `browser.*`, no clock (the spine
has no timers; disposal is F10), seeded fast-check.

**Mock port** (`test/engine/mock-port.ts`), in-memory state:

- `tabs: Map<id, Tab>` + id counter; `createTab` assigns an id, `removeTab` deletes,
  `getTab` reads.
- `identities: Map<storeId, ContextualIdentity>` + `firefox-container-N` counter;
  seedable with pre-existing containers (a named permanent, a `tmp…` throwaway, a MAC
  "Work").
- `onBeforeRequest(handler)` captures the handler; the test calls **`fire(details)`**
  → returns the `BlockingResponse`. That is the driver.
- `sendExternalMessage` → **mock MAC**: a `url → assignment` map; returns the
  assignment or `null`; can be set to *reject* (MAC absent).
- Records a call log (`createTab` / `removeTab` / `createIdentity`) so tests assert
  exact effects.

**Table-driven** (`engine.test.ts`) — one per invariant / edge:

- **F1 no double-open** — a reopening nav creates exactly one tab and removes the
  old (net tab count unchanged); a same-`requestId+url` re-fire returns
  `{cancel:true}` with zero additional `createTab`.
- **F1 termination** — after reopen, fire the new tab's own request (now in the
  target store) → `resolve` = `stay` → no further effects; the sequence terminates.
- **F2 already-contained** — tab already in the target container → `stay` → zero
  `createTab`/`removeTab`, returns `undefined`.
- **F7 defer** — mock MAC owns the URL → no `createTab`, returns `undefined`;
  MAC-rejects → reopen proceeds normally.
- **reopen correctness** — new tab's `cookieStoreId` is the found-or-created
  permanent (or a fresh `tmp…` identity for the disposable path), with
  `index`/`active`/`openerTabId` preserved.
- **choice** — multi-open, no default → `onChoice(options, nav)` called, request
  canceled, zero tabs created.
- **fail-open** — `createTab` rejects → no `{cancel:true}`, `handled` key cleared.

**Property-based** (`engine.props.test.ts`, fast-check):

- *Bounded effect* — any single fired nav yields at most one `createTab`. (F1)
- *Target fidelity* — when a reopen happens, the created tab's container equals the
  `Target` `resolve()` returned. (registry round-trip)
- *Defer totality* — if mock MAC owns the URL, no `createTab`/`removeTab` ever
  occurs, for any config/nav. (F7)

**Registry units** (`registry.test.ts`) — `toRef` (default / `tmp`-prefix→temporary
/ else permanent / missing→default), `toStoreId` find-or-create, injected-suffix
determinism.

## 7. File structure

```
src/engine/
  port.ts       BrowserPort interface + data types (WebRequestDetails, Tab, …)
  registry.ts   ContainerRegistry: toRef / toStoreId (find-or-create), TMP_PREFIX
  engine.ts     createEngine({port, config, deps, onChoice, tmpSuffix}); the
                onBeforeRequest handler, NavContext assembly, MAC_ID + macOwns,
                F1 `handled` guard
test/engine/
  mock-port.ts          in-memory BrowserPort + mock MAC + fire() driver
  engine.test.ts        table-driven scenarios (F1/F2/F7, reopen, choice, fail-open)
  engine.props.test.ts  fast-check invariants
  registry.test.ts      mapping units
```

`createEngine(...)` returns an object that registers its handler with the port on
construction; production (L4) passes the real port, tests pass the mock. Toolchain
is the repo's existing TS + Vitest + fast-check. The `Decision` union is
exhaustively switched (no `default`) so a new variant fails `tsc`.

## 8. What this slice does *not* prove

Routing *execution* for the common case only — not disposal (F10), not restart
resilience (F8), not overlay/redirector timing (F12), not redirect binding (F9), and
not real Firefox (L4). The value delivered is a **deterministic, model-tested
interception spine** — the adapter the higher levels build on, with F1/F2/F7 owned
at the fast level.
