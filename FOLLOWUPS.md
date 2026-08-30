# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry once it is
resolved.

## Three L1 properties assert nothing (2026-08-30)

Found by drift review D6. `test/resolver/resolve.props.test.ts` carries five properties;
three of them cannot fail, and TESTING.md's L1 section credits F4 and F5 to them.

- **F5, "matchRule equals a first-match oracle".** The subject is `deps.matchRule`, which
  is `realMatchers()` from `test/resolver/helpers.ts` — a test double whose own comment
  says "NOT the production matcher" — and the oracle beside it is a character-for-character
  inlining of that double's body. It compares a function with a copy of itself. Measured:
  rewriting `src/matcher/matcher.ts`'s `matchRule` to take the LAST match instead of the
  first leaves all five properties green.
- **F4, "group membership is a function of the URL only".** It draws two arbitrary
  containers, discards them with `void cA; void cB;`, and asserts `matchGroup(url, groups)`
  equals a `matchGroup(url, groups)` taken a line earlier — `f(x) === f(x)` on a pure
  function. `matchGroup` takes no nav-context parameter to vary, so the stated property is
  a fact about the signature and nothing in the body can observe it. Measured: replacing
  `matchGroup`'s body with `return null` leaves this file green
  (`test/matcher/matcher.test.ts` is what goes red).
- **F4/F5 independence, "changing a rule's open target never changes group answers".** It
  mutates `cfg.rules` and then reads `mutated.groups`, which the object spread leaves
  reference-identical to `cfg.groups`. The same tautology, one indirection on.

None of the three is a coverage hole on its own: `test/matcher/matcher.rules.test.ts`
pins first-match on the production `matchRule` and `matchGroup` by table, and F3's
monotonicity property below them is real (it compares `resolve` against an oracle built
from the same deps, which is the point of an oracle). What is missing is the FUZZED half —
the generated rule lists TESTING.md says the precedence and totality claims rest on — and
what is false is the file's own account of what it covers.

**Left open deliberately: a replacement is a design decision, not a comment fix.** F5
pointed at the production `matchRule` needs its generated rules wrapped in `hostMatcher()`
(bare strings are not a `Matcher`), which moves a killer suite of the mutation gate onto a
different module and could move the score; F4's real content ("at most one group, first
match wins") is an oracle over `matchGroup` that belongs in `test/matcher/` rather than
here, where L1 and L2 divide; and the independence property needs a mutation the groups
array actually sees. Deleting them is also defensible, and cheaper — but it drops what
TESTING.md L1 advertises rather than fixing it, so it wants the same decision.

Do not "fix" this by making the assertions look stricter without re-measuring: the way
each of these passes today is by comparing something with itself, and that is invisible
in the assertion's shape.

## The live `Config` object mutates under six siblings, and no type says so (2026-08-29)

`wireBackground` creates one `Config` and fills it in place with `Object.assign` inside
`useConfig`; six siblings hold a reference. The invariant every one of them depends on —
*this object mutates under you; read it at event time, never at construction* — appears in
no type. `CookieSeederOptions { config: Config }` is indistinguishable from a signature
taking a snapshot, so a seventh sibling written the idiomatic way (`const { rules } =
config`) would freeze on the empty config forever, and nothing would catch it: not the
compiler, not the coverage gate, and not an L3 case, since the composed-background tests
apply a config before navigating.

Half the failure mode is already closed and closed well — `useConfig` spells out
`{ rules, groups }` as a `Required<Config>`, so a key added to `Config` later fails to
compile rather than silently retaining what the previous config left.

**Left open deliberately, on the 2026-08-29 modularity review's own recommendation.** The
distance is minimal — one construction site, one mutation site, the same file — so the high
strength here is cohesion rather than coupling, and the bug has never happened. The fix is
known and small: hand siblings a `getConfig(): Config` accessor instead of a `config: Config`
reference, since a function cannot be destructured into a stale snapshot.
`script-injector`'s existing `apply(config)` already demonstrates the shape from the other
direction.

Take it when the seventh sibling is written, not before — that is the moment the rule stops
being kept by one file's comment and starts being kept by reviewer attention.

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
