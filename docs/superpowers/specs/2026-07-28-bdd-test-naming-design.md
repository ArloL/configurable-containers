# The Tests Are the Spec — Design

**Date:** 2026-07-28
**Status:** Implemented
**Topic:** Delete `TESTS.md` and move the behaviour reading into the test source, carried by
descriptive variable and method names. A naming-only refactor: 344 tests, zero behaviour
change.

## 1. Goal & scope

`TESTS.md` holds 48 Gherkin-notation scenarios written as **reference material** before
implementation. The 344 tests already assert that behaviour. Two descriptions of one
system, free to drift, only one of them executable — that is the duplication this slice
removes, by keeping the executable one.

The tests must therefore *read* as well as the scenarios did. They largely already do at
the title level ("removes a tmp container after its last tab closes + grace elapses");
what reads badly is the bodies, where the vocabulary is `mp`, `fc`, `d`, `res`, `old`,
`f`, `setup()`, `req()`.

### The governing constraint

**Naming only. No test is added, removed, split, re-scoped, or strengthened.** Every
assertion must still assert exactly what it asserted before.

This is not fastidiousness — it is what makes the change reviewable. A diff that mixes
renaming with coverage changes cannot be checked by reading, because the reviewer has no
baseline: any assertion might have moved for either reason. Keeping the two apart means
every hunk is verifiable at a glance.

**If a TESTS.md scenario turns out to have no corresponding test, it is recorded in
`FOLLOWUPS.md`, not fixed here.** Writing that test is a different change with a
different risk profile, and it needs the failing-test-first discipline this refactor
deliberately does not use.

### In scope

- Renaming the three shared test vocabularies and their call sites.
- Renaming per-file locals and per-file helper functions.
- Deleting `TESTS.md`; rewriting the parts of `TESTING.md` and `CLAUDE.md` that point at
  it.
- Mutation spot-checks proving the renamed tests still catch what they caught.

### Out of scope

- **Adding coverage.** Including for scenarios found to be untested (see above).
- **Given/When/Then comment scaffolding.** Rejected: the markers restate the code, which
  is the comment style this project cuts.
- **A step-function or fluent DSL.** Rejected: a shared step vocabulary is the DSL layer
  this project has already decided against, and it hides what is actually asserted.
- **Test titles**, except where a rename makes one inconsistent with its body.
- **The coverage matrix in `TESTING.md`** — see §5.

## 2. The vocabulary

Three shared surfaces set the vocabulary. Each forces its consumers to change in the same
commit, because a rename that misses a call site does not compile:

| Surface | Consumers | Direction |
|---|---|---|
| `test/engine/mock-port.ts` | 11 files | behaviour names: `opensTab`, `closesTab`, `addContainerNamed`, `removedContainers` |
| `harness/firefox.ts` | 12 files | already behavioural (`awaitContainerTab`, `readContainerName`); the work is at call sites |
| `test/resolver/helpers.ts` | 3 files | the constructed situation reads as the situation |

### Mock fidelity survives the rename

`emitTabCreated` names the Firefox event it simulates. That correspondence is
crucial: CLAUDE.md's stated debugging move when L3 is green but real Firefox
misbehaves is to suspect the mock, which requires knowing which `browser.*` event each
call fakes.

Behaviour names keep the call sites readable; the event moves to the **definition**, so
the trace is one hop away rather than absent:

```ts
/** Fires browser.tabs.onCreated, as a real tabs.create does. */
opensTab(props: { url: string; in: ContextualIdentity }): Promise<Tab>;

/** Fires browser.tabs.onRemoved. */
closesTab(tab: Tab): Promise<void>;
```

### What a body becomes

```ts
it("removes a throwaway once its last tab closes and the grace elapses", async () => {
  const { browser, clock } = aBrowserWithFakeClock();
  const throwaway = browser.addContainerNamed("tmp1");
  createDisposer({ port: browser.port, clock, graceMs: GRACE });

  const onlyTabInTheThrowaway = await browser.opensTab({ url: "https://a.test/", in: throwaway });
  await clock.advance(0);
  expect(browser.removedContainers).toEqual([]);

  await browser.closesTab(onlyTabInTheThrowaway);
  await clock.advance(GRACE - 1);
  expect(browser.removedContainers).toEqual([]);
  await clock.advance(1);
  expect(browser.removedContainers).toEqual([throwaway]);
});
```

The assertions are the same assertions. Only the words changed.

## 3. Slicing

Four slices, with boundaries set by what the compiler forces together rather than by
taste:

1. **`mock-port.ts` + its 11 engine test files.** The largest slice and the one that
   defines the vocabulary the rest follow.
2. **`harness/firefox.ts` + its 12 e2e test files.** Runs real Firefox, so it is the
   slowest to verify; kept separate so a failure here cannot be confused with a mock
   rename.
3. **The pure layers** — `test/resolver/helpers.ts` plus the resolver, matcher, psl and
   config tests. No shared browser fake, so it is the least entangled.
4. **Docs.** `TESTS.md` deleted, `TESTING.md` §L5 rewritten, `CLAUDE.md` orientation
   updated, any untested scenario recorded in `FOLLOWUPS.md`.

Each slice ends green on `npm run typecheck && npm test`.

## 4. Safety net

A rename that accidentally weakens an assertion leaves the suite just as green as one
that preserves it. "Tests pass" therefore proves the refactor did not *break* anything —
not that it did not *lose* anything. So each slice ends with mutation spot-checks: break
a real behaviour in the source, confirm the renamed tests go red, restore.

Bounded to **one check per source module the refactored tests guard**, so they are few
enough to actually run:

| Slice | Modules to mutate |
|---|---|
| 1 — mock-port | `disposer.ts`, `engine.ts`, `registry.ts`, `auto-temp.ts`, `cookie-seeder.ts`, `script-injector.ts`, `redirector-closer.ts`, `picker.ts` |
| 2 — harness | `engine.ts` (routing), `disposer.ts` (real-timer disposal) |
| 3 — pure | `resolve.ts`, `matcher.ts`, `same-site.ts`, `parse.ts` |

Roughly fourteen checks across the refactor rather than one per file. Each mutation is
restored by undoing the edit — never `git checkout`, which would discard the refactor
alongside it.

## 5. Documentation

- **`TESTS.md` — deleted.**
- **`TESTING.md` §"L5 — Acceptance: TESTS.md as BDD test code" — rewritten.** The section
  describes a suite mirroring TESTS.md one test per scenario, plus a CI check binding the
  two. With TESTS.md gone there is nothing to bind. It becomes: the behaviour reading
  lives in the tests' own names, at whichever level owns the behaviour; there is no
  separate acceptance suite and no drift check, because there is no second document to
  drift from.
- **The coverage matrix is left untouched, ticks included.** What its L5 and Mutation
  columns encode is not currently known — the author did not recall, and the prose that
  would define it is the prose being replaced. Editing marks whose meaning is unknown
  would be guessing, and a wrong tick is worse than a stale one. Recorded in
  `FOLLOWUPS.md` for whoever next has the context to say what the columns mean.
- **`CLAUDE.md`** — the orientation paragraph lists `TESTS.md` as one of the documents a
  cold start should read. That line changes to point at the test suite.

## 6. Risks

- **A weakened assertion slips through.** The whole point of §4. Residual risk after the
  spot-checks: a module whose mutation happened to be caught by a *different* file than
  the one refactored. Mitigated by choosing mutations that target behaviour the
  refactored file specifically claims to guard.
- **Behaviour recorded only in TESTS.md is lost on deletion.** Any scenario without a
  corresponding test is recorded in `FOLLOWUPS.md` before the file is deleted, so the
  intent survives even though the prose does not. Deleting first and looking later would
  lose it for good.
- **A large mechanical diff hides a real change.** Mitigated by the §1 constraint (nothing
  but names moves) and by slicing, so no single review is the whole suite at once.
- **Renaming a mock method away from its `browser.*` event.** Mitigated by §2's
  definition-site doc comments. If a future debugging session finds the correspondence
  hard to follow, the doc comment is the thing to strengthen — not the call sites.

## 7. What this slice does *not* prove

That the suite covers every behaviour TESTS.md described. It proves the tests that exist
read as their own specification and still catch what they caught. Coverage gaps found on
the way out are written down, not closed.
