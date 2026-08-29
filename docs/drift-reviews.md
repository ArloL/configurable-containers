# Drift reviews

Recurring reviews for the class of defect no gate in this repo can see: **a true statement
that stopped being true**. D1–D8 each hunt one flavour of it; **D9** asks whether those eight
are still pointed where drift actually happens, which is a different question and fails
differently.

They are run by an agent, not by a tool, on a schedule. Each one below is self-contained —
scheduling a run means handing an agent this file and a review id.

## Why these cannot be tests

Every deterministic gate here measures **code**, and each is blind to prose by design:

- `test/fitness/` reads `src/` **with comments stripped** (`test/fitness/sources.ts`). That
  is deliberate and correct — this codebase names the very APIs it is careful not to call,
  so a check that read raw text would report `src/resolver/types.ts`'s explanation of
  `browser.cookies.set` as a violation and be deleted within a week. The cost of that
  decision is that **a comment cannot fail a fitness check**.
- The coverage gate counts lines executed, never claims that are true.
- The mutation gate mutates code. A comment has no mutants.
- `tsc` and `oxlint` see syntax and types.

So nothing in CI has ever been able to notice a sentence going false. On 2026-08-29 six
comments across three files asserted, in the present tense, that a config save calls
`runtime.reload()` — three days after `seams.test.ts` started pinning that call *out* of
`src/`. Three of them were a test case's stated reason for existing. The gate that forbade
the mechanism and the comments that depended on it never met, and the only thing that found
them was a person asking a question.

That is the whole subject of this file.

## The catalogue

| id | Question | Scope | Suggested cadence |
| --- | --- | --- | --- |
| **D1** | Does this comment still describe what the code does? | `src/`, `harness/`, `scripts/` | monthly |
| **D2** | Is this suppression's reason still true? | every `v8 ignore`, `Stryker disable`, `oxlint-disable`, `sonar.issue.ignore` | monthly |
| **D3** | Has the platform moved past this measurement? | measured claims in `CLAUDE.md`, `TESTING.md` | quarterly, and after any Firefox-leg change |
| **D4** | Does this upstream citation still resolve? | `mac/`, `tcp/`, bug references | quarterly |
| **D5** | Does the published copy still describe the add-on? | `amo/` | before a release, and monthly |
| **D6** | Does this test still assert what its comment claims? | `test/` | monthly |
| **D7** | Has this follow-up's resolution condition been met? | `FOLLOWUPS.md` | monthly |
| **D8** | Do two current documents contradict each other? | `CLAUDE.md`, `TESTING.md`, `README.md`, `CONFIG.md` | quarterly |
| **D9** | Is this catalogue still pointed where drift happens? | this file, `docs/drift-reviews/` | twice a year, never before two runs of most reviews exist |

---

## Rules that apply to every run

These matter more than the review definitions. A non-deterministic review is far easier to
make cry wolf than a fitness function is, and this repo's own rule is that **a check that
cries wolf is deleted and takes its invariant with it**. Six rules keep that from happening.

**1. A finding is a contradiction, never an opinion.** Name two things and say why they
cannot both be true. "This comment is unclear", "this could be worded better", "this file is
long" are not findings and must not appear in a report.

**2. Every finding cites both sides.** `file:line` for the claim, and `file:line` — or a
command and its actual output — for the evidence that contradicts it. A finding you cannot
cite twice is a suspicion; drop it.

**3. Silence is a valid and expected result.** Most runs of most reviews should find
nothing. Report "no findings" explicitly. Never manufacture a finding to justify the run —
that is the failure mode that gets the whole practice switched off.

**4. If it could have been a fitness test, say so.** A drift a deterministic check could
have caught is a gap in `test/fitness/`, and the finding must propose the check. These
reviews exist for what *cannot* be pinned; every time one finds something pinnable, its own
future scope shrinks. That direction is the point — prefer converting a review's territory
into a test over re-running the review forever.

**5. Report, then fix — never fix silently.** A wrong "fix" to a comment writes a *new*
false statement, which is worse than the stale one because it looks fresh. Land the report,
then fix what is confirmed, in a separate commit that says what was believed and what is
actually true.

**6. Rank by blast radius and cap the run.** At most ~10 findings per run, most severe
first. Anything beyond that goes in a "not triaged this run" list rather than being dropped
silently.

### Severity, by where the drifted text ends up

- **Published** — it leaves the repo. `amo/` prose is pushed to AMO on **every push to
  main**, so drift there is published rather than merely sitting in a file.
- **Load-bearing** — it is a reason *not* to do something. This is CLAUDE.md's entire
  purpose ("platform and tooling facts that make a reasonable-looking change wrong"). When
  such a premise dies, the next person takes the reasonable-looking wrong action *and the
  file tells them to*.
- **Self-justifying** — a test's comment explaining why the case exists. If that reason is
  gone, nobody can tell whether the case still earns its slot, and the honest options
  (rewrite the reason, or delete the case) both need the drift found first.
- **Local** — a stale detail with no decision resting on it. Real, lowest priority.

### What is never a finding

- **Past-tense history.** "It used to call `runtime.reload()`", "back when saving reloaded"
  — a statement about the past stays true, and this codebase deliberately keeps the history
  that explains a shape. Only present-tense claims can go stale.
- **A dated design record.** `docs/superpowers/specs/` and `docs/modularity-review/` are
  snapshots of what was decided on a date. They are *supposed* to diverge from the code.
  Never "update" one to match; if a spec's decision was reversed, that belongs in CLAUDE.md.
- **A deliberate exception that says it is one.** A suppression whose comment argues its
  case is doing its job; the question is only whether the argument still holds.

### Report format

One file per run, `docs/drift-reviews/<date>-<id>.md`:

```markdown
# D1 — expired premises (2026-09-30)

Scanned: src/**, harness/** (312 files, 1,847 comment blocks)

## Findings

### 1. [load-bearing] src/engine/pause.ts:88 says X; src/engine/pause.ts:412 does Y
Claim: "…quoted…"
Evidence: …file:line, or the command run and its output…
Why they cannot both be true: …
Could a fitness test have caught this? …

## Not triaged this run
…

(or: **No findings.** — which is a good outcome, not an empty one)
```

---

## D1 — Expired premises

**Ask of each comment that states how the code behaves: does it still?**

This is the review that produced the practice. Read prose that makes a *present-tense,
checkable claim* about a mechanism — "X calls Y", "this runs on every Z", "the only caller
is W", "this is the ordinary path" — and check the claim against the code.

Highest-yield places, in order:

1. **A comment that justifies a decision by naming a mechanism.** These are load-bearing and
   they are what CLAUDE.md is made of.
2. **A comment naming a caller, a count, or a frequency.** "The only external consumer",
   "six siblings", "on every config save". Counts drift silently.
3. **A comment describing a module that has since been split.** After the 2026-08-29
   refactor, prose about "`Recording`" had to become prose about three types.

Method: for each claim, find the code it is about and read it. Where the claim is a
frequency or a caller count, `grep` it and compare. Do not accept a claim because it sounds
right — the reason these survive is that they *all* sound right.

Non-findings: past-tense history; a comment about intent ("keep this synchronous") rather
than fact; a comment about a Firefox behaviour, which is D3's job.

**Precedent:** `runtime.reload()` × 6 (2026-08-29). Also the note in `options.ts` claiming
importing a constant "would pull the background's pause module, and with it the engine, into
the options bundle" — false when written, measured false by the modularity review, and
acted on only then. Note the second shape: **a premise that was never true**, not one that
expired. This review catches both, and the second is worth more because nothing else ever
will.

---

## D2 — Suppressions whose reason expired

**Ask of each suppression: is the reason still true, and does the suppressed finding still
fire?**

Every suppression here carries a written reason, which is what makes this reviewable:

- `/* v8 ignore … -- why */` — `src/matcher/matcher.ts`, `src/config/load.ts`,
  `src/engine/browser-port.ts`
- `// Stryker disable <mutator>: why` — `src/config/parse.ts`, `src/overlays/cookies.ts`
- `// oxlint-disable-next-line <rule> -- why` — `harness/reaper.ts`,
  `harness/browser/matchers.ts`, `test/config/parse.real.test.ts`
- `sonar.issue.ignore.multicriteria.<id>` — `sonar-project.properties`, each with a comment
  saying why the rule is wrong about this code

Two distinct failure modes, and they need different fixes:

- **The reason expired** → a real finding is being hidden. Highest severity in this review.
- **The finding no longer fires** → the suppression is dead code that will outlive everyone
  who understood it. Delete it.

This review has a **deterministic half, and you should use it**: remove the suppression, run
the gate, and see whether it complains. That converts most of the run from judgement into
measurement. Report the command and its output as evidence.

Two standing facts to check against rather than re-derive:

- `sonar-project.properties` suppressions are deliberate and reasoned; **`S2871` must stay**
  — taking its `localeCompare` advice breaks reproducible builds, because that sort is what
  makes the xpi's entry order identical on every machine and collation is not.
- **zizmor has no suppressions on purpose.** If a run proposes adding one, that is the
  finding inverted: the fix is real.

Note the special case in `CLAUDE.md`: a suppression comment disables the line after the
**directive**, not after the reason. A three-line `-- because…` block suppresses the second
comment line and nothing else, silently. Worth checking shape as well as content.

---

## D3 — Measured facts past their shelf life

**Ask of each measurement: has the platform moved past it, and is the number still what the
code does?**

`CLAUDE.md` and `TESTING.md` are unusually full of measurements, which is a strength — they
are why the platform notes are trustworthy — and a maintenance liability, because a
measurement is true *of a version on a date*. Examples in the current text: "measured,
FF153", "140.14.0esr", "156.0a1 widened the same check", "one first read in twelve came back
empty and hydrated 13ms later", "61.8s of `options.test.ts`, measured", "40 rounds on an
idle machine … reproduced it zero times", "measured 2026-08-25 on 154.0".

For each: name the version and date it was measured on, and the current version of that
thing. A gap is not a finding — it is a *candidate*. Promote it to a finding only when the
claim's consequence would change, and **propose the re-measurement rather than guessing the
result**. "This may have changed" with no way to check is noise.

Highest-value subset: **facts that decide what CC must do.** The `view-source:` inner-url
behaviour, `tabs.create` rejecting `about:newtab`, bug 1586612's `onCreated` ordering,
`onBeforeNavigate` preceding the request, and the privileged-context refusal that
`test/e2e/privileged-protocol.test.ts` is the tripwire for. If Firefox changed one of these,
a workaround becomes dead code or a guard becomes wrong — and the Nightly leg is designed to
catch the second case, not the first.

Also in scope: **numbers in prose that must match a constant.** `MAX_RECORDED_HOSTS` is 200,
`PRODUCTION_GRACE_MS` is five minutes, the coverage and mutation thresholds are 100. Prose
citing any of these is checkable against the source in one grep.

---

## D4 — Upstream citations

**Ask of each reference into `mac/` or `tcp/`: does it still resolve, and does it still say
what we claim?**

CLAUDE.md cites both **by file and symbol, never line number**, precisely because they track
upstream. That convention is what makes this review cheap: a symbol either exists or does
not.

Use the **local checkout**, not the GitHub API — `mozilla/multi-account-containers` is
outside this session's repository scope, and CLAUDE.md already treats the checkout as the
reference. `mac/` is a test prerequisite, so it is present whenever the suite can run; clone
it if not (`git clone --depth 1 https://github.com/mozilla/multi-account-containers.git mac`).

Check, per citation: the file exists; the symbol exists in it; and the behaviour we describe
is what that code does now. Current citations include
`mac/src/js/background/assignManager.js` → `removeTab` (the reopen keep-or-replace rule) and
TCP's `cleanup.ts` → the disposer, `getAssignment` → the F7 defer.

Second half, higher value and harder: **a bug CC works around may have been fixed.**
`mozilla/multi-account-containers#2582` (the `view-source:` bug MAC also has) and Firefox
bug 1586612 (`tabs.onCreated` firing with `about:blank` first) are both load-bearing
workarounds. A fix upstream does not automatically mean deleting ours — CC supports ESR, so
a workaround stays until the oldest supported Firefox no longer needs it — but it does mean
the note should say so.

---

## D5 — Published prose

**Ask of `amo/`: does this still describe the add-on, and would a reviewer reproduce what it
promises?**

Severity ceiling for this review is **published**: `scripts/sign-dev.ts` uploads
`amo/{summary.txt,description.md,reviewer-notes.txt}` with `--amo-metadata` on **every push
to main**, so stale text here is pushed to AMO rather than merely sitting in the repo. It
also overwrites anything edited in the Developer Hub, so the file is the only copy that
matters.

Part of this is **already deterministic and must stay that way** —
`test/extension/amo-metadata.test.ts` pins the PERMISSIONS bullets as an exact set against
`extensions/cc/manifest.json` (in both directions: a permission with no bullet, and a bullet
outliving its permission), and pins the Node version against what the workflows really set.
Do not re-litigate those by hand; check the remaining paragraphs:

- Does the build-reproduction recipe still work? It is the reason the notes exist.
- Does the feature description match what the extension now does?
- Does anything claim a behaviour that has since changed — routing, storage, what is sent
  where?

A finding here that could be pinned should become another case in `amo-metadata.test.ts`,
per rule 4. That file exists because exactly this drift happened twice.

---

## D6 — Test justifications vs what the test asserts

**Ask of each test: does its comment describe what its body actually pins?**

Two failure modes, both of which this suite has shipped:

- **The comment describes a behaviour the body no longer asserts.** The stated coverage is
  imaginary; nothing fails when the behaviour breaks. `CLAUDE.md` records both precedents
  (the revert-verify bullet): three e2e cases passed with auto-temp entirely broken, and L3
  cases once asserted the bug rather than the fix.
- **The case has outlived its stated reason.** The 2026-08-29 pause restart case justified
  itself as "the ordinary path" because every config save reloaded the background. Once that
  stopped being true, the case was still valuable — it turns out to pin the only artifact
  that survives a restart at all — but nobody could have known that from the comment.

Method: read the comment, then read only the assertions, and ask whether the second could
fail if the first stopped being true. Where a case names a bug (F1–F14), check the assertion
would actually catch that bug rather than a neighbour.

This review pairs with the suite's own rule — **revert-verify a regression test**: back the
fix out, watch it go red, restore it. Where a finding is uncertain, that is how to settle it,
and the report should say whether it was done. Use editor undo, **not** `git checkout`, which
discards uncommitted work.

---

## D7 — Expired follow-ups

**Ask of each `FOLLOWUPS.md` entry: has its resolution condition been met, and is its
priced trade-off still priced right?**

The file's own instruction is *"Delete an entry once it is resolved"*, which makes every
entry a standing question with an owner of nobody. Each has an explicit condition, and some
are externally checkable — which is the whole reason to automate this:

- **`harness/selenium-webdriver.d.ts`** — "Delete the file the day the types carry them",
  and it says *"Nothing will announce it"*, because merging an interface into a class makes
  same-named methods overloads rather than a conflict. Checkable in one command:
  `grep getDomAttribute node_modules/@types/selenium-webdriver/index.d.ts`. As of
  `@types/selenium-webdriver` **4.35.6** it is still absent, so the entry stands.
- **`reopenedNav` across a restart** — revisit "only if dogfooding shows the wasted reopen
  actually happening". Not checkable from the repo; a run should say so rather than guess.
- **The live `Config` accessor** — the trigger is "when the seventh sibling is written".
  Countable: count the siblings `wireBackground` hands the config to.

Second question per entry, and the more valuable one: **is the reasoning still sound?** Each
entry prices a trade-off against facts that can move. The `reopenedNav` entry rests partly on
MV2 persistence and on how often the background is torn down — and the frequency of that
teardown *already changed once*, when saves stopped reloading. An entry whose premise moved
needs re-pricing even if its conclusion survives.

---

## D8 — Cross-document contradictions

**Ask: where two current documents describe the same thing, do they agree?**

`CLAUDE.md`, `TESTING.md`, `README.md` and `CONFIG.md` overlap deliberately — the pyramid is
in TESTING.md and referenced from CLAUDE.md, the config grammar is in CONFIG.md and
constrained from CLAUDE.md. Overlap means they can disagree, and a reader has no way to tell
which one is right.

Method: pick the topics that appear in more than one file — the test levels and what each
covers, the config grammar and its version gate, the release channels and what each
publishes, the coverage and mutation thresholds — and read each account against the others.

Remember rule "never a finding": **the specs under `docs/superpowers/` are dated records and
are exempt.** They describe what was decided then. So are the `docs/modularity-review/`
snapshots. A contradiction between a spec and the code is history working correctly; a
contradiction between CLAUDE.md and TESTING.md is a finding.

---

## D9 — Is the catalogue pointed at the right things?

**Ask of the eight reviews above — and, per the last note, of this one: are they still where
drift happens, and what have they been missing?**

The meta-review. D1–D8 each ask whether a claim is still true; this one asks whether the set
of questions is still the right set. Those are different jobs and they fail differently — a
review can be perfectly executed every month and still be worthless because nothing drifts
where it is looking.

It is also the review that owns **this file**, which nothing else does: D1's scope is `src/`,
`harness/` and `scripts/`, and D8's is the four top-level documents. So the catalogue makes
present-tense claims about the repo — the suppression sites it lists, the paths in each
Scope column, the constants D3 names — with no review checking them. That is the same gap
that produced the practice, one level up.

### Four questions, in descending order of value

**1. What drifted that no review would have caught?** The highest-value question this
practice can ask, and the only one that finds a *missing* review rather than a mis-aimed one.

Evidence: `git log` since the last D9 for commits that fixed staleness — a comment corrected,
a doc updated to match code, a suppression deleted as dead. For each, ask which review would
have found it, and whether it was in fact found by a scheduled run or by someone tripping
over it. A drift found by a person asking a question is a coverage gap with a precedent
attached, which is exactly what an addition needs. The `runtime.reload()` set is the founding
example: six comments, three files, found by a question.

**2. What has been converted, and should therefore shrink?** Rule 4 means a healthy practice
makes itself smaller. Two conversions already exist and are the model:
`test/extension/amo-metadata.test.ts` pins the PERMISSIONS bullets as an exact set because
that prose drifted twice, and `test/fitness/e2e-discipline.test.ts` exists because a
migration's own commit message claimed rules the code did not follow. Both took territory
away from a human reading prose.

So for each review: has a fitness test taken part of its scope? If yes, the Scope column
should say so, or the review should retire. A catalogue that only grows is a ratchet, and a
ratchet is how a practice becomes a tax nobody can argue against.

**3. Is a review finding nothing because it works, or because it is aimed wrong?** Both look
identical in the reports, which is why this needs judgement rather than a threshold. Ways to
tell them apart:

- Has the *surface* it watches changed at all since the last run? A review over files nobody
  has touched should find nothing, and that is not evidence of anything.
- Is its scope now empty or already deterministic? A review whose whole territory got pinned
  is finished, not clean.
- Would it have caught the drifts found under question 1? A review that would have missed a
  real drift inside its own stated scope is mis-aimed, and this is the sharpest test there
  is.

**4. Has the repo grown a surface the catalogue does not cover?** Enumerate rather than
recall: what leaves the repo (published prose, release notes, listing copy); what suppression
mechanisms exist; what external things are cited by file and symbol; what artefacts are
generated from other artefacts. Compare that enumeration against the Scope column. `amo/` is
the only published-prose surface today — if a second appears, D5's scope is wrong the day it
lands and nothing will say so.

### The rule that keeps D9 from being a ratchet

**An addition needs a precedent; a retirement does not.**

Proposing a new review requires a drift that actually happened and that no existing review
would have caught — cited, like any other finding. "We should also check X" without a
precedent is the crying-wolf failure at the meta level, and it is worse here than anywhere
else, because every review added is a recurring cost paid forever by someone who was not in
the room.

Retiring or merging a review needs only the absence of findings plus an argument from
question 3. Bias this review toward **subtraction**: a run that retires one review and adds
none is a better outcome than the reverse.

### Conflict of interest

D9 reviews the document that authorises D9. It may propose retiring itself — if the catalogue
has been stable across several runs and questions 1 and 2 keep coming back empty, that is the
finding, and it should be reported rather than avoided. A meta-review that has never proposed
subtracting anything is not doing its job.

### Do not run it early

It reasons over a corpus of reports, so it needs one. Running D9 against a single prior report
produces opinion dressed as analysis. Wait until most reviews have run at least twice — with
the cadences above, that is roughly two quarters in — and say in the report how many prior
runs it had to work from.

---

## Scheduling notes

- **Run one review per invocation.** They need different evidence and different judgement,
  and a combined run reliably produces a shallow pass at all of them.
- **Stagger them.** Monthly for D1, D2, D5, D6, D7; quarterly for D3, D4, D8; D9 twice a
  year. D5 additionally before any release, since that is when its severity is realised.
- **Vary the scope of the expensive ones.** D1 over the whole repo every month will be
  shallow. Better: rotate a directory per run (`src/engine`, then `src/config` + `src/resolver`,
  then `harness/`), and always include whatever changed since the last run — `git log` since
  the previous report's date is the highest-yield input this practice has, because drift is
  created by change and the change is enumerable.
- **Feed each run the previous report.** Findings that were considered and rejected should
  not come back every month; a run that re-reports a rejected finding without new evidence is
  the crying-wolf failure arriving on schedule.
- **Track the conversion.** Rule 4 means a healthy practice makes itself smaller: each
  drift that becomes a `test/fitness/` case is territory these reviews never have to cover
  again. If a review has run four times and proposed no deterministic check, ask whether it
  is looking at the right thing — which is D9's job, and the reason it exists rather than
  this bullet being left as an intention nobody acts on.
