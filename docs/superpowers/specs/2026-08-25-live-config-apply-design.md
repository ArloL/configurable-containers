# Applying a Config Without Restarting the Extension — Design

**Date:** 2026-08-25
**Status:** Implemented 2026-08-25
**Topic:** Replace `browser.runtime.reload()` — the way a saved or adopted config is put
into effect today — with an in-process apply. Amends the 2026-07-28 storage slice §5
("saving reloads the extension so every sibling re-reads the config") and the 2026-07-30
sync slice's adoption path.

## 1. Goal & scope

A config save writes `storage.local` and then calls `runtime.reload()`. Every sibling
re-reads the config as the fresh background evaluates, which is why the codebase has been
able to treat "the config changed" as "the world restarted".

The reload is the only part of a save that can fail, and it is the only part nothing can
observe. On 140.14.0esr with a temporarily installed extension it does not bring the
extension back at all: the old background keeps running the old config while the editor
reports "Saved — reloading" (measured 2026-08-24; `FOLLOWUPS.md`). The harness cannot say
whether a permanently installed, signed build behaves the same way, because an unsigned
xpi can only be installed temporarily — so the two cases the measurement needs to separate
are exactly the two that differ.

This slice removes the question instead of answering it. If nothing reloads, there is
nothing for ESR to fail at, and the case that could not run below Firefox 154
(`test/e2e/options.test.ts`, "routes by the saved config after the reload") runs on every
channel CI drives.

### In scope

- **`src/extension/wiring.ts`** gains `applyStored()`: read the stored config through the
  port, swap it into the one `config` object, re-register content scripts.
- **`src/engine/script-injector.ts`** becomes an object that holds its registrations and
  can replace them, instead of a function that registers once and discards the handles.
- **`src/extension/config-protocol.ts`** (new): the `cc-config-apply` message and its
  reply, alongside the existing `pause-protocol.ts`.
- **`src/extension/options.ts`**: Save sends the message and reports on the reply.
- **`src/extension/config-sync.ts`**: adoption applies in process rather than reloading.
- **`src/extension/background.ts`**: wires the publish and the adoption callback together.
- Tests: `mock-port` fidelity for unregistration, an L3 apply suite, a fitness row pinning
  `runtime.reload` out of `src/`, and the un-skipped e2e case.

### Out of scope

- **A watcher on `storage.onChanged`.** It would cover any future writer for free, but it
  also fires for the background's own writes (the first-run seed, adoption's backup), so
  applies would have to be idempotent against writes that changed nothing, and it offers
  no reply channel — leaving the editor's status the unverifiable claim this slice exists
  to remove. There are two writers and both are in process.
- **Bounding the four session-lived sets** (§6). They stop getting a save-triggered reset
  and nothing else about them changes; the existing pricing still holds.
- **Reload as a fallback when the apply fails.** Keeping it would keep the untestable path
  and add a second one. The apply's only failure is script registration, and §5 handles it
  in the open.

## 2. The apply path

One function, and every path to it goes through it — the property `config-sync.ts` already
claims with *"the same apply path a Save takes; there is deliberately no second one."*

```
applyStored(): Promise<ConfigApplyResponse>
  1. port.readStored(CONFIG_STORAGE_KEY) + loadConfig   the stored yaml, parsed
  2. Object.assign(config, ...)                          the one object every sibling reads at event time
  3. scripts.apply(config)                               unregister previous handles, register the new set
```

Step 2 is what makes the whole thing cheap, and it is not new: `wireBackground` already
fills `config` in place precisely because handing siblings a freshly parsed object would
leave them holding the empty one. The engine, picker, cookie-seeder and redirector-closer
read it at event time and need no notification. `useConfig` remains the synchronous
startup call — it releases the navigation gate and must not await — and `applyStored` is
that same swap plus the injector.

The assign is total today because `parseConfig` always returns both `rules` and `groups`.
That is a property, not a coincidence, and a third key added later would silently keep its
old value; the implementation pins it with a type-level exhaustiveness guard rather than a
comment.

**The read goes through the port, not an injected loader.** `wiring.ts` is not one of the
five files allowed to touch `browser.*` (`test/fitness/seams.test.ts` pins the list), and
`test/engine/restart.ts` drives `wireBackground` under a mock port. `BrowserPort.readStored`
is already generic `storage.local` access — the disposer's grace uses it — and `mock-port`
models that storage, so an L3 case can write the config text the way a Save does and watch
the apply pick it up. An injected loader would be a second seam answering a question this
one already answers.

The seed is deliberately *not* reachable here: `loadConfig(stored, "")`. By the time
anything applies, storage holds the truth, and a seed reachable from the apply would be a
second answer to "what is the config".

## 3. The script injector holds its registrations

`createScriptInjector` registers each snippet and throws the returned handle away. The
port already returns a `RegisteredContentScript` with `unregister()` — nothing keeps it.

It becomes a small object constructed synchronously in `wireBackground` (construction
registers nothing, so the no-await rule is safe) with one method:

```ts
apply(config: Config): Promise<void>   // unregister the handles from the last apply, then register the new set
```

Startup's `injectScripts()` is its first call, so there is one code path for the first
registration and every later one.

Two accepted consequences, neither of which the reload handled better:

- **A snippet already running in an open page keeps running** until that page reloads.
  `unregister` stops future injections only. A reload tore down the content scripts, but
  the snippet had already run — `document_start` is the whole point — so what it did to
  the page survived either way.
- **Re-registration is unconditional**, not diffed against the previous set. A save that
  changed no `scripts:` entry still unregisters and re-registers. At this size that is a
  handful of API calls on an action a user performs by hand, and a diff is a second
  representation of the config to keep correct.

## 4. The trigger, the reply, and the publish

Save writes storage exactly as it does now (the stamp still decides sync conflicts), then
sends `cc-config-apply` and waits.

The message joins the **single** `runtime.onMessage` registration in `wireBackground`,
dispatched by type beside `cc-pick` and `cc-pause-*`. A second `addListener` would claim
the reply channel from whichever sibling was addressed — the Firefox behaviour
`test/fitness/listeners.test.ts` exists to pin.

The reply is what makes the new path observable:

```ts
interface ConfigApplyResponse {
  scriptError?: string;   // a snippet failed to register
  configError?: string;   // the applied text does not parse (adoption only; the editor refuses to save one)
}
```

The editor shows "Saved" on an empty reply and "Saved — <error>" otherwise. A status that
never changes is a message that never arrived, which is a visible failure rather than the
optimistic "Saved — reloading" the page prints today whether or not anything happened.

**The publish has to be re-attached.** Today a Save's push to `storage.sync` rides the
restart: `background.ts`'s async tail calls `createConfigSync(...).start()`, which
reconciles and publishes. With no restart, nothing would. So the apply handler fires the
publish after a successful apply. No mutable slot is needed: `createConfigSync` is
side-effect-free until `start()`, so `background.ts` constructs it first and passes
`afterApply: () => void configSync.sync()` into `wireBackground`. It is fired, not
awaited — a save must not block on a network-backed area — and `enqueue`'s serialisation
already covers a save landing during a reconciliation.

**Adoption goes the other way.** `browserSyncPorts` takes the applier as a deferred
closure, `browserSyncPorts(() => background.applyStored())`, which is safe for the same
reason `wiring.ts`'s `picker` forward reference is: adoption cannot run before `start()`,
which runs in the tail, long after `wireBackground` returned. `adopt` then writes its keys
and applies, instead of writing and reloading.

`sync-record.ts`'s convergence rules are unchanged, but one of their *reasons* is not:
"equal text never returns `adopt`" is justified there by adoption ending in a reload, so
two machines would restart each other forever. After this slice an adoption loop costs
re-registrations rather than restarts. The rule stays — a loop is still a loop — and the
comment gets the honest reason.

## 5. Failure

The swap cannot fail: it is an `Object.assign` over a value `loadConfig` always returns.
Only registration can, so the order is swap first, register second, report second's
failure.

This deliberately admits a state the reload never produced: **new routing with stale or
missing snippets**. It is the right trade because storage is the truth and memory
following it is the invariant this slice buys; the alternative — register first, swap only
if everything succeeded — leaves storage and memory disagreeing until the next browser
restart, which is precisely the silent divergence being removed.

An adopted config that does not parse is handled exactly as startup handles one: the empty
config is applied (nothing matches, everything opens in a throwaway — loud), the error is
logged, and `configError` carries it. The editor is not force-opened on this path;
adoption is a background event and the sync status line already reports what arrived.

## 6. What the reload was doing that nothing replaces

`test/fitness/retained-state.test.ts` inventories every collection in `src/` and prices
four of them as unbounded — `engine.handled`, `engine.warnedHosts`, `engine.viewSourceNav`
and `auto-temp.processed`. Part of that pricing is that a config save empties them.

After this slice they live for the browser session. The existing per-row reasoning is
unchanged and still holds: each holds one short string or number, each is fed by something
rarer than browsing, and a long session costs kilobytes. The file's prose has to say so
rather than lean on a reset that no longer happens, and the inventory stays exact so the
fifth arrival is still a conversation.

The other direction is a win, and it is why the change is called hardening:

- **`reopenedNav` and `handled` survive a save.** A save during a reopen no longer costs
  the extra reopen priced in `FOLLOWUPS.md`'s first entry — the user's own Save was the
  one reliable way to open that window.
- **The `tmp<N>` counter survives.** `highestTmpSuffix` still runs at startup, where a
  browser restart genuinely resets it, but a save can no longer reissue a live throwaway's
  name.
- **The disposer's stored grace stops being load-bearing for saves.** It stays stored —
  a browser restart still ends the background context — but F10's trigger was "saving your
  config destroyed live throwaways", and saving no longer restarts anything.

## 7. Testing

**L3 fidelity first.** `test/engine/mock-port.ts` returns a no-op `unregister` and keeps
`registeredScripts` append-only, so no L3 case can currently see a snippet that should
have been removed. Unregistration must remove the entry, or this slice's central risk is
invisible below L4 — the "L3 green, Firefox broken" shape CLAUDE.md warns about.

**L3 behaviour** (`test/engine/apply-config.test.ts`), each revert-verified:

- routing follows the applied config, with no restart of the wiring
- a rule dropped from the config stops routing
- a `scripts:` entry removed from the config is unregistered; a changed one ends up
  registered exactly once
- a registration failure reports `scriptError` and leaves the new routing in effect
- a `tmp<N>` name is not reissued across an apply (the counter survives)
- `cc-config-apply` returns `undefined` from siblings that do not own it — the single
  registration's contract, asserted un-awaited
- adoption applies without a reload (fake sync ports; the existing config-sync suite)

**Fitness:** a row pinning `browser.runtime.reload` absent from `src/`, so the decision to
remove it cannot be undone by accident, and the updated `retained-state.test.ts` prose.

**L4:** `test/e2e/options.test.ts` drops its `version < 154` skip. That case is the
deliverable's proof and the reason the ESR leg becomes able to observe a config save.
`restart.test.ts` stays as it is: a browser restart is still real, and the harness still
has to model one honestly.

## 8. Documentation

- **CLAUDE.md** — "Saving is a full extension restart, so every in-memory structure dies"
  is now wrong in both halves; the paragraph becomes the apply path and what it keeps. The
  storage section's reload references and the retained-state note follow.
- **`FOLLOWUPS.md`** — the ESR entry is replaced by this slice; nothing is left to measure
  by hand.
- **`src/config/default.yaml`, `configurable-containers.config.yaml`, `CONFIG.md`** —
  "Saving reloads the extension" is no longer true; saving applies the config.
- **`src/extension/options.ts`** header comment, which states the reload as the mechanism.

## 9. What implementation added to this design

- **`test/fitness/suite.test.ts`'s skip inventory** loses `options.test.ts`. It was an exact
  list of two, and the whole point of removing the reload was that the second entry stops
  being needed — so the inventory is where that shows up.
- **`test/extension/fake-storage.ts` drops its `reloads` counter and its `runtime.reload`
  stub.** Nothing calls the API any more, and a fake that still counts it is a fake nobody
  can use to notice its return.
- **The e2e proof was measured, not assumed.** `test/e2e/options.test.ts` passes on
  140.14.0esr (the mac ESR build, since `scripts/get-firefox.sh` fetches linux64 only), and
  restoring `runtime.reload()` in the Save handler turns it red there — it never reaches the
  routing assertion, because the editor's status never becomes "Saved".
