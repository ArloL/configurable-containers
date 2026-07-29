# F8 — Background Restart Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give F8 a real L3 owner — a harness that drops every in-memory guard and re-runs the invariants against the same browser — and make `TESTING.md`'s F8 tick true.

**Architecture:** The synchronous half of `src/extension/background.ts` becomes `wireBackground()` in `src/extension/wiring.ts`, so the restart harness drives the *real* startup path instead of a second copy of it. `test/engine/restart.ts` then models a restart as "wire a fresh session against the same `aFakeBrowser()`", relying on the mock's single-handler-per-event slots to retire the old listeners, and on a per-session clock facade to retire the old timers.

**Tech Stack:** TypeScript, Vitest, `test/engine/mock-port.ts`.

## Global Constraints

- Design of record: `docs/superpowers/specs/2026-07-28-f8-background-restart-design.md`. Read it first.
- **No behaviour change.** If a test written here fails, that is a finding for `FOLLOWUPS.md` or a separate commit — never a silent patch folded into this slice.
- **Every `browser.*` listener must still register synchronously** as `background.ts` evaluates. `wireBackground` is called at module top level and does not `await`; the four event-driven cases in `test/e2e/auto-temp.test.ts` are what go red if this regresses.
- **Revert-verify every test that defends a mechanism** (§7 of the design). Restore by undoing the edit, **never** `git checkout` — it would discard the rest of the slice.
- `npm run typecheck` passes at the end of every task. `npm test` runs unit and e2e together and opens real Firefox windows.
- Keep `fileParallelism: false` in `vitest.config.ts`.
- Task 1 lands as its own commit so a bisect separates the entry-point refactor from the tests.

---

### Task 1: `wireBackground()` — the wiring the tests can call

Mechanical and behaviour-preserving. The order of operations in the async tail must survive exactly: fill config → release the gate → report a parse error → resume the counter → register scripts.

**Files:**
- Create: `src/extension/wiring.ts`
- Modify: `src/extension/background.ts`

**Interfaces:**

```ts
export interface WiringOptions {
  port: BrowserPort;
  clock: Clock;
  graceMs: number;
  redirectorDelayMs: number;
}

export interface Background {
  config: Config;
  useConfig(loaded: Config): void;
  resumeTmpSuffix(): Promise<void>;
  injectScripts(): Promise<void>;
  engine: Engine;
}

export function wireBackground(opts: WiringOptions): Background;
```

**Steps:**
- [ ] Move into `wiring.ts`, unchanged: the `config` object, the `configReady` promise and `gatedPort`, the `tmpSuffix` counter, `createEngine` + `createPicker`, and the `createAutoTemp` / `createDisposer` / `createCookieSeeder` / `createRedirectorCloser` calls.
- [ ] `useConfig(loaded)` = `Object.assign(config, loaded)` followed by `markConfigReady()`. Folding them into one call is the point: they must happen together, so a caller can no longer do one without the other.
- [ ] `resumeTmpSuffix()` does its own `queryIdentities()` and raises the counter via `highestTmpSuffix`. It owns the port, so the caller has no names to pass and nothing to get wrong.
- [ ] `injectScripts()` wraps `createScriptInjector({ port, config })` — the one sibling that reads config eagerly, hence the one that genuinely has to wait.
- [ ] `background.ts` keeps `createBrowserPort()`, the `__CC_*` defines, and the async config tail (storage read, seed write, editor-on-parse-error), calling the four methods in the order above.
- [ ] Carry the crucial comments with the code they explain — especially the synchronous-registration paragraph, which now documents `wireBackground`'s contract.

**Verification:**
- [ ] `npm run typecheck`.
- [ ] `npm test` — `test/e2e/auto-temp.test.ts` is the file that proves the ordering survived.

---

### Task 2: the restart harness

**Files:**
- Create: `test/engine/restart.ts`

**Interfaces:**
- Produces: `startTheBackground(browser, clock, config)` and `restartTheBackground(session, browser, clock, config)`, consumed only by `test/engine/restart.test.ts`.

**Steps:**
- [ ] A session wraps the shared fake clock in a facade that drops callbacks once the session ends, and `restartTheBackground` ends the previous one before wiring the next. Without this the old disposer's re-arming GC tick keeps sweeping through a closure that still holds a live port, and the harness proves state "surviving" a restart that never happened.
- [ ] `startTheBackground` runs the async tail in `background.ts`'s order (`useConfig` → `resumeTmpSuffix` → `injectScripts`) and awaits it, so a caller observes a settled startup.
- [ ] Comment why re-wiring alone retires the old listeners: `mock-port.ts` holds one handler slot per event, so a second registration replaces the first, exactly as a dead context's listeners stop being called.

**Verification:**
- [ ] `npm run typecheck` (`tsconfig.json` covers `test/`, so the harness must type-clean).

---

### Task 3: the reconstructed-state invariants

The three tests that defend a mechanism. Write each failing first — back the mechanism out, watch it go red, restore, watch it go green.

**Files:**
- Create: `test/engine/restart.test.ts`

**Steps:**
- [ ] **The throwaway counter resumes past a live `tmp<N>`.** Route an unmatched host, restart, route another; assert `createdContainers` reads `["tmp1", "tmp2"]`.
- [ ] **A throwaway created before the restart is still disposed after it.** Its tab stays open across the restart; close it afterwards and advance the grace. Assert *within* the grace window — the 10-minute GC would otherwise supply a false pass, and that is the whole difference between this test and a green one that proves nothing.
- [ ] **An already-containerized new-tab page is not containerized twice.** A tab on `about:newtab` in a `tmp` container survives the restart untouched by the startup sweep.

**Revert-verification:**
- [ ] `resumeTmpSuffix` → no-op ⇒ `tmp1` issued twice.
- [ ] Delete the disposer's startup `queryTabs({})` loop ⇒ the container is never disposed.
- [ ] Delete `isAutoTempCandidate`'s `cookieStoreId` check ⇒ a second `tmp` container appears.

---

### Task 4: the lost-state invariants

**Files:**
- Modify: `test/engine/restart.test.ts`

**Steps:**
- [ ] **A committed tab is not churned after a restart.** Once a tab's url has committed, `tabs.get` is a complete substitute for everything lost — no reopen, no cancel. Revert-verify against resolve's already-contained check.
- [ ] **A restart mid-reopen costs exactly one extra reopen and converges.** Model the pre-commit tab the way the existing engine tests do (`newTab.url = "about:blank"`). Assert the exact hop count, the final container, *and* that the abandoned throwaway is disposed rather than leaked. A characterization test: it has no mechanism to back out, so the assertion's job is to be loud when the number changes — a change to how `resolve()` treats a pre-commit tab is what would turn one wasted hop into the F1 runaway.
- [ ] **The declined-POST notification is raised again after a restart.** `engine.ts:90` says the clearing is wanted; this turns the comment into an assertion.

**Verification:**
- [ ] `npm test`.

---

### Task 5: the docs

**Files:**
- Modify: `TESTING.md`, `FOLLOWUPS.md`, `CLAUDE.md`

**Steps:**
- [ ] `TESTING.md` §L3: replace the "dedicated harness" prose with what was built, and name what it enforces. The F8 matrix tick is now true; leave the L5 and Mutation columns alone — what they encode is still the open FOLLOWUP.
- [ ] `FOLLOWUPS.md`: record `reopenedNav` as not reconstructible, with the window (between `port.createTab` and the reopened tab's first request) and the measured price (one extra hop, self-cleaning), so an MV3 migration can weigh persisting it against a cost already known. Note the harness gap too: async work in flight at the restart is not modelled.
- [ ] `CLAUDE.md`: point the synchronous-registration note at `wiring.ts`, and record the two harness fidelity rules (handler slots retire the old listeners; the per-session clock facade retires the old timers) — the second is the one whose absence would make the suite lie.

**Verification:**
- [ ] `npm test` and `npm run typecheck` both clean before the final commit.
