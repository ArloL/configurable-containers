# The Tests Are the Spec — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `TESTS.md` and move the behaviour reading into the test source, carried by descriptive variable and method names.

**Architecture:** A naming-only refactor of 344 tests across 46 files. Three shared vocabularies (`test/engine/mock-port.ts`, `harness/firefox.ts`, `test/resolver/helpers.ts`) set the words; each forces its consumers to change in the same commit because a missed call site does not compile. Every assertion keeps asserting exactly what it asserted before; each slice ends with mutation spot-checks proving the renamed tests still catch what they caught.

**Tech Stack:** TypeScript, Vitest, Selenium/geckodriver.

## Global Constraints

- Design of record: `docs/superpowers/specs/2026-07-28-bdd-test-naming-design.md`. Read it first.
- **Naming only. No test is added, removed, split, re-scoped, or strengthened.** Every `expect(...)` must still assert what it asserted before; only identifiers inside it may change.
- **A scenario in `TESTS.md` with no corresponding test is recorded in `FOLLOWUPS.md`, never written here.** Adding coverage needs failing-test-first discipline this refactor deliberately does not use.
- **Do not touch the coverage matrix in `TESTING.md`**, ticks included. What its L5 and Mutation columns encode is not currently known; a wrong tick is worse than a stale one.
- Restore every mutation by **undoing the edit** — never `git checkout`, which would discard the refactor alongside it.
- `npm run typecheck` must pass at the end of every task; `npm test` runs unit and e2e together and opens real Firefox windows.
- Keep `fileParallelism: false` in `vitest.config.ts`.
- Test titles stay as they are, except where a rename leaves one inconsistent with its body.

---

### Task 1: The mock-port vocabulary and its 11 engine test files

The largest slice, and the one whose words the rest follow. The rename below is authoritative.

**Files:**
- Modify: `test/engine/mock-port.ts`
- Modify: `test/engine/auto-temp.test.ts`, `cookie-seeder.test.ts`, `disposer.test.ts`, `engine.props.test.ts`, `engine.test.ts`, `mock-port.test.ts`, `picker.test.ts`, `post-binding.test.ts`, `redirector-closer.test.ts`, `registry.test.ts`, `script-injector.test.ts`

**Interfaces:**
- Produces: the renamed `MockPort` surface below, consumed by nothing outside `test/engine/`.

**The rename table** — every row, no others:

| Now | Becomes |
|---|---|
| `createMockPort()` | `aFakeBrowser()` |
| `createFakeClock()` | `aFakeClock()` |
| `mp` (local) | `browser` |
| `fc` (local) | `clock` |
| `.fire(d)` | `.navigates(d)` |
| `.fireHeaders(d)` | `.sendsHeaders(d)` |
| `.tabs` | `.openTabs` |
| `.identities` | `.containers` |
| `.calls.createTab` | `.openedTabs` |
| `.calls.removeTab` | `.closedTabIds` |
| `.calls.createIdentity` | `.createdContainers` |
| `.calls.removeIdentity` | `.removedContainers` |
| `.calls.setCookie` | `.seededCookies` |
| `.calls.updates` | `.navigatedTabs` |
| `.calls.notify` | `.notifications` |
| `.flush()` | `.settle()` |
| `.addTab(props)` | `.existingTab(props)` |
| `.addIdentity(props)` | `.addContainerNamed(props)` |
| `.emitTabCreated(props)` | `.opensTab(props)` |
| `.emitTabRemoved(tabId)` | `.closesTab(tab: Tab)` — **signature changes to take the Tab** |
| `.emitTabUpdated(tab, info)` | `.updatesTab(tab, info)` |
| `.emitMessage(msg)` | `.receivesMessage(msg)` |
| `.emitCommand(name)` | `.receivesCommand(name)` |
| `.setMacAssignment(url, v)` | `.macAssigns(url, v)` |
| `.setMacThrows(on)` | `.macIsAbsent(on)` |
| `.setCreateTabThrows(on)` | `.tabCreationFails(on)` |
| `.setActiveTab(tab)` | `.activeTabIs(tab)` |
| `.getStoredCookie(store, name)` | `.cookieIn(store, name)` |
| `.registeredScripts` | `.registeredScripts` (unchanged) |
| `.port` | `.port` (unchanged) |

The `calls` object is flattened away: its six fields become top-level readable properties, because `browser.removedContainers` reads as an observation while `mp.calls.removeIdentity` reads as bookkeeping.

- [ ] **Step 1: Rewrite the `MockPort` interface**

Replace the `export interface MockPort` block in `test/engine/mock-port.ts` with:

```ts
export interface MockPort {
  port: BrowserPort;

  /** Fires webRequest.onBeforeRequest and returns the blocking response. */
  navigates(d: WebRequestDetails): Promise<BlockingResponse | void>;
  /** Fires webRequest.onBeforeSendHeaders and returns the header edits. */
  sendsHeaders(d: HeadersDetails): Promise<BlockingHeadersResponse | void>;

  openTabs: Map<number, Tab>;
  containers: Map<string, ContextualIdentity>;

  // What the extension did, in the order it did it.
  openedTabs: CreateTabProps[];
  closedTabIds: number[];
  createdContainers: CreateIdentityProps[];
  removedContainers: string[];
  seededCookies: SetCookieDetails[];
  navigatedTabs: { tabId: number; url: string }[];
  notifications: NotificationSpec[];
  registeredScripts: RegisterContentScriptDetails[];

  // The engine floats its notification rather than awaiting it (a navigation must not
  // wait on a toast), so a test asserting on notifications must settle first.
  settle(): Promise<void>;

  /** A tab that is already open. Fires nothing. */
  existingTab(props: { url: string; cookieStoreId: string; index?: number; active?: boolean; openerTabId?: number }): Tab;
  /** A container that already exists. Fires nothing. */
  addContainerNamed(props: { name: string; color?: string; icon?: string }): ContextualIdentity;

  /** Fires browser.tabs.onCreated, as a real tabs.create does. */
  opensTab(props: { url: string; cookieStoreId: string; index?: number; active?: boolean; openerTabId?: number }): Promise<Tab>;
  /** Fires browser.tabs.onRemoved. */
  closesTab(tab: Tab): Promise<void>;
  /** Fires browser.tabs.onUpdated. */
  updatesTab(tab: Tab, info: TabUpdateInfo): Promise<void>;
  /** Fires browser.runtime.onMessage and returns the handler's reply. */
  receivesMessage(msg: unknown): Promise<unknown>;
  /** Fires browser.commands.onCommand. */
  receivesCommand(name: string): Promise<void>;

  // Arranged conditions.
  macAssigns(url: string, value: unknown): void;
  macIsAbsent(on: boolean): void;
  tabCreationFails(on: boolean): void;
  activeTabIs(tab: Tab): void;
  cookieIn(storeId: string, name: string): Cookie | null;
}
```

- [ ] **Step 2: Rewrite the implementation to match**

In `createMockPort`'s return object (rename the function to `aFakeBrowser`), replace the `calls` object with six standalone arrays and rename the returned members per the table. The internal `port` implementation pushes to the new arrays:

```ts
export function aFakeBrowser(): MockPort {
  const openTabs = new Map<number, Tab>();
  const containers = new Map<string, ContextualIdentity>();
  const openedTabs: CreateTabProps[] = [];
  const closedTabIds: number[] = [];
  const createdContainers: CreateIdentityProps[] = [];
  const removedContainers: string[] = [];
  const seededCookies: SetCookieDetails[] = [];
  const navigatedTabs: { tabId: number; url: string }[] = [];
  const notifications: NotificationSpec[] = [];
  // …rest unchanged, with `calls.createTab.push(props)` becoming `openedTabs.push(props)`
  // and so on for each of the six.
```

`closesTab` takes a `Tab` and uses `tab.id` internally:

```ts
    async closesTab(tab) {
      openTabs.delete(tab.id);
      onTabRemovedH?.(tab.id);
      await flushMicrotasks();
    },
```

Also rename `createFakeClock` to `aFakeClock` at the bottom of the file.

- [ ] **Step 3: Run typecheck to see every call site that must change**

Run: `npm run typecheck 2>&1 | head -40`
Expected: FAIL, many errors across the 11 engine test files. This list is your worklist.

- [ ] **Step 4: Update `test/engine/mock-port.test.ts`**

This file tests the mock itself, so its **titles** name the old methods and must change with them (e.g. "createTab fires onTabCreated" → "opensTab fires onTabCreated"). This is the one file where retitling is expected rather than exceptional.

Run: `npx vitest run test/engine/mock-port.test.ts` — expected PASS.

- [ ] **Step 5: Update `test/engine/disposer.test.ts`**

Apply the rename table. Rename its local `setup()` helper to `aBrowserWithFakeClock()`, and its per-test locals so the body reads as behaviour — `tmp` → `throwaway`, `tab` → `onlyTabInTheThrowaway`. Target shape:

```ts
it("removes a tmp container after its last tab closes + grace elapses", async () => {
  const { browser, clock } = aBrowserWithFakeClock();
  const throwaway = browser.addContainerNamed({ name: "tmp1" });
  createDisposer({ port: browser.port, clock: clock.clock, graceMs: GRACE });
  const onlyTabInTheThrowaway = await browser.opensTab({ url: "https://a.test/", cookieStoreId: throwaway.cookieStoreId });
  await clock.advance(0); // let the startup sweep run: tmp1 has a tab -> kept
  expect(browser.removedContainers).toEqual([]);

  await browser.closesTab(onlyTabInTheThrowaway);
  await clock.advance(GRACE - 1);
  expect(browser.removedContainers).toEqual([]); // not yet
  await clock.advance(1);
  expect(browser.removedContainers).toEqual([throwaway.cookieStoreId]);
});
```

Run: `npx vitest run test/engine/disposer.test.ts` — expected PASS.

- [ ] **Step 6: Update `test/engine/engine.test.ts`**

Apply the rename table. Rename locals: `old` → `sourceTab`, `res` → `blockingResponse`, `req()` → `aNavigationTo()`, `counter()` → `sequentialTmpSuffixes()`, `noop` → `ignoreChoices`.

Run: `npx vitest run test/engine/engine.test.ts` — expected PASS.

- [ ] **Step 7: Update `test/engine/post-binding.test.ts`**

Apply the rename table and the same local renames as Step 6 (`req()` → `aNavigationTo()`, `counter()` → `sequentialTmpSuffixes()`, `noop` → `ignoreChoices`), plus `res` → `blockingResponse` and `tab` → the situation it describes (`tabInTheThrowaway`, `tabAlreadyInWork`).

Run: `npx vitest run test/engine/post-binding.test.ts` — expected PASS.

- [ ] **Step 8: Update the remaining seven engine files**

`auto-temp.test.ts`, `cookie-seeder.test.ts`, `engine.props.test.ts`, `picker.test.ts`, `redirector-closer.test.ts`, `registry.test.ts`, `script-injector.test.ts`. Apply the rename table plus per-test locals; single-letter and abbreviated locals (`d`, `t`, `f`, `mp`, `fc`, `ci`) become the thing they hold.

Run: `npx vitest run test/engine/` — expected PASS, 128+ tests.

- [ ] **Step 9: Verify nothing was weakened — mutation spot-checks**

For each module below: make the edit, run the named test file, confirm **RED**, then undo the edit and confirm **GREEN** again.

| Module | Mutation | File that must go red |
|---|---|---|
| `src/engine/disposer.ts` | remove the `graceMs` delay — dispose immediately | `disposer.test.ts` |
| `src/engine/engine.ts` | delete the `reopenedNav` guard block (1b) | `engine.test.ts` |
| `src/engine/registry.ts` | change `TMP_PREFIX` to `"temp"` | `registry.test.ts` |
| `src/engine/auto-temp.ts` | drop the `onTabUpdated` listener | `auto-temp.test.ts` |
| `src/engine/cookie-seeder.ts` | seed into `"firefox-default"` instead of the tab's store | `cookie-seeder.test.ts` |
| `src/engine/script-injector.ts` | register at `document_idle` instead of `document_start` | `script-injector.test.ts` |
| `src/engine/redirector-closer.ts` | skip the post-delay URL re-check | `redirector-closer.test.ts` |
| `src/engine/picker.ts` | have the picker call `createTab` directly instead of `engine.reopen` | `picker.test.ts` |

- [ ] **Step 10: Commit**

```bash
npm run typecheck && npx vitest run test/engine/
git add test/engine/
git commit -m "refactor(test): the L3 mock speaks behaviour, not bookkeeping"
```

---

### Task 2: The e2e call sites

`harness/firefox.ts`'s exports are already behavioural (`launch`, `awaitContainerTab`, `readContainerName`, `listTabs`), so this slice is call-site locals — no shared-API rename, and therefore no compile-forced sweep.

**Files:**
- Modify: `test/e2e/auto-temp.test.ts`, `choice.test.ts`, `cookie-boundary.test.ts`, `cookies.test.ts`, `disposal.test.ts`, `mac-interop.test.ts`, `options.test.ts`, `plumbing.test.ts`, `redirect-binding.test.ts`, `redirector.test.ts`, `routing.test.ts`, `scripts.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 — the e2e files do not import the mock.

- [ ] **Step 1: Rename locals across the twelve files**

Per-file, make each local name the thing it holds. The recurring ones:

| Now | Becomes |
|---|---|
| `session` | `firefox` |
| `port` | `serverPort` |
| `url` | the page it addresses — `articleUrl`, `callbackUrl`, `assignedHostUrl` |
| `name` / `store` from `awaitContainerTab` | `containerName` / `cookieStoreId` |
| `t` in a `.find()` | `tab` |
| `first` / `second` | `openersContainer` / `linkedTabsContainer` |

Leave `navFreshTab` in `routing.test.ts` named as it is — it already says what it does.

- [ ] **Step 2: Run the e2e suite**

Run: `npx vitest run test/e2e/`
Expected: PASS. Real Firefox windows open; this takes about a minute.

- [ ] **Step 3: Verify nothing was weakened — mutation spot-checks**

| Module | Mutation | File that must go red |
|---|---|---|
| `src/engine/engine.ts` | make `reopen` always replace the source tab (`const keep = false`) | `routing.test.ts` |
| `src/engine/disposer.ts` | never remove a container (make `removeIdentity` a no-op call site) | `disposal.test.ts` |

- [ ] **Step 4: Commit**

```bash
npm run typecheck && npx vitest run test/e2e/
git add test/e2e/
git commit -m "refactor(test): e2e locals name what they hold"
```

---

### Task 3: The pure layers

**Files:**
- Modify: `test/resolver/helpers.ts`
- Modify: `test/resolver/resolve.test.ts`, `resolve.props.test.ts`, `helpers.test.ts`
- Modify: `test/matcher/*.test.ts` (3), `test/psl/*.test.ts` (2), `test/config/*.test.ts` (7), `test/integration/resolve-real-deps.test.ts`

**Interfaces:**
- Produces: the renamed `test/resolver/helpers.ts` surface below, consumed only within `test/`.

- [ ] **Step 1: Rename the resolver helpers**

In `test/resolver/helpers.ts`:

| Now | Becomes |
|---|---|
| `nav(...)` | `aNavigation(...)` |
| `config(rules, groups)` | `aConfigOf(rules, groups)` |
| `makeDeps()` | `realMatchers()` |
| `def` | `theDefaultContainer` |
| `temp` | `aThrowaway` |
| `perm(name)` | `theContainerNamed(name)` |
| `host(url)` | `host(url)` (unchanged — already exact) |

- [ ] **Step 2: Run typecheck for the worklist**

Run: `npm run typecheck 2>&1 | head -30`
Expected: FAIL across the resolver test files. That is the worklist.

- [ ] **Step 3: Update the resolver, matcher, psl, config and integration tests**

Apply the renames plus per-test locals. In the matcher and config tests the recurring terse names are `m` (a matcher), `r` (a rule), `c` (a parsed config), `p` (a pattern) — each becomes the noun it holds.

Run: `npx vitest run test/resolver/ test/matcher/ test/psl/ test/config/ test/integration/`
Expected: PASS.

- [ ] **Step 4: Verify nothing was weakened — mutation spot-checks**

| Module | Mutation | File that must go red |
|---|---|---|
| `src/resolver/resolve.ts` | make `disposablePath` always return a fresh temp (drop the same-site check) | `resolve.test.ts` |
| `src/matcher/matcher.ts` | make the shorthand a plain suffix match (so `notcompany.com` matches) | `matcher.test.ts` |
| `src/psl/same-site.ts` | compare full hostnames instead of registrable domains | `same-site.test.ts` |
| `src/config/parse.ts` | accept a rule with no `match` key | `parse.test.ts` |

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npx vitest run test/resolver/ test/matcher/ test/psl/ test/config/ test/integration/
git add test/
git commit -m "refactor(test): pure-layer helpers name the situation they build"
```

---

### Task 4: Delete TESTS.md and repoint the docs

**Files:**
- Delete: `TESTS.md`
- Modify: `TESTING.md` (the L5 section and the intro line referencing TESTS.md)
- Modify: `CLAUDE.md` (orientation paragraph)
- Modify: `FOLLOWUPS.md`

- [ ] **Step 1: Find scenarios with no corresponding test — BEFORE deleting anything**

For each of the 48 `Scenario:` titles in `TESTS.md`, decide whether some test asserts that behaviour. Read for meaning; the titles will not match test names literally.

```bash
grep -n "^Scenario:" TESTS.md
```

Record every scenario you cannot match to a test. Deleting first and checking later loses the intent for good.

- [ ] **Step 2: Record the gaps in `FOLLOWUPS.md`**

Add one entry listing the unmatched scenarios verbatim, so the intent survives the file. If every scenario matched, say that instead — it is the useful fact either way:

```markdown
## Behaviour described in TESTS.md but not asserted anywhere (2026-07-28)

TESTS.md was deleted when the tests became the only behaviour spec
(`docs/superpowers/specs/2026-07-28-bdd-test-naming-design.md`). These scenarios had no
corresponding test at that point, and are kept here so the intent is not lost with the
file. Each needs a failing test written first — they are coverage gaps, not renames.

- <scenario title> — <one line on what it claimed>
```

- [ ] **Step 3: Record the unknown matrix columns in `FOLLOWUPS.md`**

```markdown
## What the L5 and Mutation columns of the coverage matrix mean (2026-07-28)

`TESTING.md`'s subtle-bug matrix ticks L5 for F3, F4, F5, F6, F9, F11 and F12, and
Mutation for F3, F4, F5 and F6. There is no acceptance suite and no Stryker config, so
the ticks encode something other than "a test exists at this level" — the author did not
recall what, and the prose that would have defined it was rewritten when TESTS.md went.
The matrix was deliberately left untouched rather than guessed at. Resolve it by deciding
what the columns should mean, then making them true.
```

- [ ] **Step 4: Rewrite `TESTING.md`'s L5 section**

Replace the whole `## L5 — Acceptance: TESTS.md as BDD test code` section with:

```markdown
## L5 — Acceptance: the tests are the spec

There is no separate acceptance suite and no second document to drift from. The
behaviour reading lives in the tests themselves: each test is named for the behaviour it
pins, and its body is written so the mechanics read as that behaviour — descriptive
locals and helper names, not a step DSL. A scenario is owned by whichever level can
prove it, so the acceptance reading is spread across L1–L4 rather than duplicated above
them.

Deliberately **no Gherkin runner** and **no step vocabulary**: cucumber-style step
binding is regex matching over prose, and a shared step library is the same indirection
by another name. Plain `describe`/`it` with well-chosen words carries the meaning
without the layer.
```

Also fix the intro line that calls TESTS.md "the human-readable spec" — the test suite is.

- [ ] **Step 5: Update `CLAUDE.md`**

The orientation paragraph lists `TESTS.md` among the documents a cold start should read. Remove it from that list and point at the suite instead: `TESTING.md` (the test pyramid) and `test/` (the behaviour spec itself).

- [ ] **Step 6: Delete the file and verify the repo has no dangling references**

```bash
git rm TESTS.md
grep -rn "TESTS.md" --include="*.md" --include="*.ts" --include="*.yml" . | grep -v node_modules | grep -v "^./docs/superpowers"
```
Expected: no output. (Design specs and plans under `docs/superpowers/` are historical records and keep their references.)

- [ ] **Step 7: Full suite and commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "docs: the tests are the behaviour spec; delete TESTS.md"
```

---

## Self-Review

**Spec coverage.** §1 goal and the naming-only constraint → Global Constraints, enforced in every task. §1's "record gaps, don't fix them" → Task 4 Steps 1–2. §2 vocabulary → Task 1's rename table (mock), Task 2 Step 1 (e2e locals), Task 3 Step 1 (resolver helpers). §2 mock fidelity via definition-site doc comments → Task 1 Step 1, where every event-firing method carries the `browser.*` event it fires. §3 slicing → Tasks 1–4, boundaries as specified. §4 safety net → the mutation tables in Tasks 1, 2 and 3; fourteen checks, matching the spec's count. §5 docs → Task 4. §5's "matrix left untouched" → Global Constraints plus Task 4 Step 3. No gaps.

**Placeholder scan.** Every rename is named explicitly; no "and so on for the rest" standing in for a decision. Task 1 Step 8 and Task 3 Step 3 cover multiple files with one rule, but the rule is stated (terse locals become the noun they hold) and the table above it is exhaustive.

**Type consistency.** `aFakeBrowser()` / `aFakeClock()` are defined in Task 1 Steps 1–2 and used under those names throughout Task 1. `closesTab(tab: Tab)` is the one signature change, stated in the table and implemented in Step 2. Task 3's `aNavigation` / `aConfigOf` / `realMatchers` / `theDefaultContainer` / `aThrowaway` / `theContainerNamed` are defined in Task 3 Step 1 and used only within Task 3. Tasks 1 and 3 share no identifiers, so their vocabularies cannot collide.

## Two things a reviewer should weigh

**The `calls` object is flattened** (Task 1), so `mp.calls.removeIdentity` becomes `browser.removedContainers`. That is a structural change, not purely a rename — justified because `calls.x` reads as bookkeeping where the assertion wants an observation, but it is the one place this refactor changes shape rather than words.

**Task 2 has no compile-forced sweep.** The harness API is unchanged, so a missed local in an e2e file will not fail typecheck — it will just stay terse. The check is reading the diff, not the compiler.
