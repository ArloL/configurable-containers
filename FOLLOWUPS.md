# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry once it is
resolved.

## `reopenedNav` does not survive a background restart (2026-07-28)

The F1 reopen guard (`src/engine/engine.ts`) is the one piece of guard state nothing can
rebuild, and `test/engine/restart.test.ts` pins the price rather than fixing it. The
window runs from `port.createTab` to the reopened tab's first request; a restart inside it
costs **one** extra reopen, converges (the fresh engine guards the reopen it performs),
and leaks no container — the abandoned throwaway is disposed on the grace.

It is not reconstructible because a reopened pre-commit tab and a middle-clicked one are
both `about:blank` in a real container, and the middle-clicked one must still be isolated
into a throwaway of its own. The requestId in `reopenedNav` is the only thing separating
them.

**Priced against the seam, 2026-07-28, and the answer is still no.** The disposer's grace
fix built `readStored`/`writeStored` on `BrowserPort`, so the seam exists and the
implementation would be cheap: hydrate the map at startup, write through on each reopen,
and extend the `configReady` gate to await the hydration (reading storage inside the
blocking handler is not an option — that is every navigation's latency). Two things argue
against it:

- **The window coincides with peak activity, not idleness.** It runs while the extension
  has just handled a blocking request and is mid-reopen. Firefox suspends an event page
  when it is *idle*, so the involuntary-suspension frequency that justified revisiting
  this is much lower than the MV2-vs-MV3 framing suggested.
- **Persisting it adds a worse failure than the one it removes.** Entries are keyed by tab
  id, and tab ids restart with the browser, so a stale entry — the reopened tab's request
  never arrived, load aborted, tab closed — could be claimed by an unrelated later tab of
  the same id. That is the mis-absorption the in-memory version had to be taught to avoid,
  and its cost is a navigation loading **unrouted inside a permanent container** (F11 by
  way of F1). A TTL bounds it, but the trade is then a silent wrong-container risk against
  one wasted reopen that converges and leaks nothing.

Revisit only if dogfooding shows the wasted reopen actually happening — it is visible as a
`tmp` container created and abandoned in the same second.

Harness gap while here: `test/engine/restart.ts` does not model async work already in
flight at the restart (a floated `containerize` mid-`await`). Firefox kills it; the
harness lets it land. Every current case drives the restart from a settled state, so a
future case that needs it has to close this first.

## Replaying a declined POST into the target container (2026-07-28)

A navigation carrying a body is declined rather than reopened, because `tabs.create`
issues a GET and would drop the body. **Replaying** it — a generated auto-submitting form
page in the target container — is the only option that would actually route the assertion,
and neither Temporary Containers nor Multi-Account Containers attempts it. It needs the
`requestBody` webRequest opt-in, urlencoded and multipart handling, and a `moz-extension:`
page forging a cross-origin POST. See
`docs/superpowers/specs/2026-07-28-f9-redirect-binding-design.md` §1.

The decline is deliberately shaped so this stays a change to *how the engine executes an
unchanged decision*: `resolve()` still answers `reopen`, and only the engine's ability to
carry it out is in question.

## `harness/selenium-webdriver.d.ts` is only DefinitelyTyped being behind (2026-08-25)

That file declares two methods — `getDomAttribute` and `getProperty` — that
`selenium-webdriver` has shipped since **v4.1.1** (its own `CHANGES.md`: "Implements
'getDomAttribute' … as defined by w3c spec") and that `@types/selenium-webdriver` still
does not, as of **4.35.6**, the newest published. There is nothing to upgrade to, so the
declarations live here rather than as a cast at each call site. Delete the file the day
the types carry them.

**Filed upstream: DefinitelyTyped/DefinitelyTyped#75437**, which adds both plus
`getAriaRole` and `getAccessibleName` — the other two W3C element commands the package
is missing. Merged, it republishes `@types/selenium-webdriver` and Renovate carries it
here.

To be clear about what is *not* temporary: the call sites. `getDomAttribute`,
`getProperty`, `switchTo().activeElement()` and `clear()` + `sendKeys()` are the
spec's own commands, they work on ESR through Nightly, and they would stay the right
calls even if Firefox reverted the privileged-context change that forced them (CLAUDE.md,
the e2e section). Only the type declarations are a stopgap.

**Nothing will announce it.** Merging an interface into a class turns same-named methods
into *overloads*, not a conflict: measured 2026-08-25, redeclaring even `getAttribute`
with a wrong return type typechecks clean. So an upstream fix will not collide, and a
stale local signature would silently win over the real one. The trigger to re-check is a
Renovate bump of `@types/selenium-webdriver`: grep the new package for the two names, and
if they are there, delete `harness/selenium-webdriver.d.ts` and let `npm run typecheck`
confirm the call sites still resolve.

## Nothing binds a published artefact to the commit it claims to come from (2026-08-29)

Two halves of the release promise are checked and a third is not.
`verify-release.yaml` proves the **xpi matches its own published source archive** (rebuild
it with the published `BUILD_TIMESTAMP`, compare sha256), and GitHub's immutable releases
stop either asset being swapped afterwards. What no gate here establishes is that the
source archive is the **repo at the tagged commit**. A release built by hand, or from a
tree that never existed in git, reproduces perfectly against itself and passes every check
this repo runs.

`actions/attest-build-provenance` closes exactly that: it signs a SLSA provenance
statement through Sigstore naming the workflow, the run and the commit SHA that produced
each artefact, and `gh attestation verify <file> --repo ArloL/configurable-containers`
checks it. The natural shape:

- attest the **reproducible pre-signing xpi and the source archive** in both publishing
  paths — `ci.yml`'s `prerelease` job and `release.yaml` — since both channels publish the
  same three artefacts and one verifier already serves either.
- verify in **`verify-release.yaml`**, beside the hash comparison it already makes. It is
  handed the tag by the job that published, so it needs no search.
- job-level `id-token: write` and `attestations: write`. Both workflows declare
  `permissions: {}` at the top and grant per job, which is what keeps zizmor quiet; keep
  it that way.

Two limits worth writing down before anyone reaches for this as a complete answer. It
attests the **GitHub asset only** — AMO repacks uploads, so the signed xpi Firefox
actually installs is not byte-comparable with anything attested, which is the same
constraint that makes `verify-reproducible.ts` target the GitHub copy. And provenance
proves *where a build came from*, never *that the source is honest*: it is worth having
because it makes the source archive checkable against a public commit, not because it says
anything about the code in it.

Priority is low and the reason is honest: the threat it addresses is someone with write
access to this repo publishing a release out of band, and there is one maintainer. It
earns its place the day there are more, or the day a downstream reader wants to verify
without trusting the release page.
