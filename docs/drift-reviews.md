# Drift reviews

Reviews for what no gate here can see: prose that has gone false, or that has grown past what
it buys. An agent runs one at a time.

Each `## D<n>` section is one complete review — question, scope, method, and what counts as a
finding. Nothing depends on a neighbour, and a rule two reviews need is written out in both,
because a section is the whole context for its run. Ids are stable: retire a review by
deleting its section and leaving the gap, rather than renumbering the rest.

## Running one

These hold for every review:

- **Evidence, or it is a suspicion.** Every finding says what you checked and what it showed —
  quoted text with `file:line`, a command and its output, or a measurement. Each review states
  the shape its own findings take; none accepts "this is unclear" or "this could be worded
  better".
- **Silence is a valid and expected result.** Most runs find nothing. Say so. Never manufacture
  a finding to justify the run; that is what gets a review switched off.
- **Report; don't fix silently.** A wrong "fix" to a comment writes a *new* false statement,
  worse than the stale one because it looks fresh.
- **If a deterministic check could have caught it, say so.** `test/fitness/` reads `src/` with
  comments stripped, so nothing in CI can fail on prose — but a drift with a checkable shape is
  a gap in that suite, and the finding should propose the check.

---

## D1 — Expired premises

**Does each comment that states how the code behaves still describe it?**
Scope: `src/`, `harness/`, `scripts/`.

Read prose making a *present-tense, checkable claim* about a mechanism — "X calls Y", "this
runs on every Z", "the only caller is W", "this is the ordinary path" — and check it against
the code. Highest-yield, in order:

1. **A comment justifying a decision by naming a mechanism.** Load-bearing, and what CLAUDE.md
   is made of: a dead premise there means the next person takes a reasonable-looking wrong
   action *and the file tells them to*.
2. **A comment naming a caller, a count, or a frequency.** "The only external consumer", "six
   siblings", "on every config save". These drift silently and `grep` settles them.
3. **A comment describing a module that has since been split or renamed.**

Don't accept a claim because it sounds right — the reason these survive is that they *all*
sound right.

**A finding here is a contradiction:** the comment says X, the code does Y, both cited. Two
shapes qualify — a premise that *expired*, and one that was *never true*. The second is worth
more, because nothing else will ever catch it.

Not findings:

- **Past-tense history.** "It used to call `runtime.reload()`" stays true, and this codebase
  deliberately keeps the history that explains its shapes. Only present-tense claims go stale.
- **A dated design record.** `docs/superpowers/specs/` and `docs/modularity-review/` are
  snapshots of what was decided on a date and are *supposed* to diverge from the code. If a
  decision was reversed, that belongs in CLAUDE.md, not in an edit to the record.
- A statement of intent ("keep this synchronous") rather than of fact.
- A claim about Firefox's behaviour, which is a measurement — see D3.

## D2 — Suppressions whose reason expired

**Is each suppression's reason still true, and does the suppressed finding still fire?**
Scope: every suppression that carries a written reason, which is what makes them reviewable.

Enumerate rather than recall:

```
grep -rn 'v8 ignore\|Stryker disable\|oxlint-disable' src test harness scripts
grep -n 'ruleKey\|resourceKey' sonar-project.properties
```

**A finding here is one of two shapes**, needing different fixes: **the reason expired** (a
real finding is being hidden — the severe case), or **the finding no longer fires** (dead
weight that will outlive everyone who understood it — delete it).

Use the deterministic half: **remove the suppression, run the gate, see whether it complains.**
That turns most of the run from judgement into measurement; report the command and its output.

Two standing facts, to check against rather than re-derive:

- **`S2871` must stay.** Taking its `localeCompare` advice breaks reproducible builds, because
  that sort is what makes the xpi's entry order identical on every machine and collation is not.
- **zizmor has no suppressions on purpose.** A run proposing one has the finding inverted: the
  fix is real.

Not a finding: a suppression that argues its case. That is one doing its job, and the only
question is whether the argument still holds.

Check shape as well as content — a suppression disables the line after the **directive**, not
after the reason, so a multi-line `-- because…` block suppresses the next comment line and
nothing else, silently.

## D3 — Measured facts past their shelf life

**Has the platform moved past this measurement, and is the number still what the code does?**
Scope: measured claims in `CLAUDE.md`, `TESTING.md`, and the three task-scoped platform
files `CLAUDE.md` routes to — `docs/e2e-and-probe.md`, `docs/releasing.md`,
`docs/static-analysis.md`. Those three hold the measurements a session sees LEAST often,
which is exactly why nobody re-checks them by accident.

A measurement is true *of a version on a date*, and these files are full of them — which is
why the platform notes are trustworthy, and why they need re-checking. Find them with:

```
grep -n 'measured\|esr\|FF1\|[0-9]\+\.[0-9]\+a\?[0-9]*' CLAUDE.md TESTING.md docs/e2e-and-probe.md docs/releasing.md docs/static-analysis.md
```

For each, name the version and date it was measured on, and the current version of that thing.

**A finding here is a measurement whose consequence would now be different.** A version gap
alone is only a candidate. Promote it when the consequence would change, and **propose the
re-measurement rather than guessing the result**: "this may have changed" with no way to check
is noise, and a guessed re-measurement is worse than a stale one, because the next reader
cannot tell it was guessed.

Highest value: **facts that decide what CC must do** — the `view-source:` inner-url behaviour,
`tabs.create` rejecting `about:newtab`, bug 1586612's `onCreated` ordering, `onBeforeNavigate`
preceding the request, and the privileged-context refusal that
`test/e2e/privileged-protocol.test.ts` is the tripwire for. If one changed, a workaround
becomes dead code or a guard becomes wrong — and the Nightly leg catches the second, not the
first.

Also: **numbers in prose that must match a constant** — the recording caps, the disposal
grace, the coverage and mutation thresholds. One grep each against the source.

## D4 — Upstream citations

**Does each reference into `mac/` or `tcp/` still resolve, and still say what we claim?**
Scope: citations in `CLAUDE.md`, and the bugs CC works around.

CLAUDE.md cites both **by file and symbol, never line number**, because they track upstream —
which is what makes this cheap: a symbol either exists or does not. Use the **local checkout**,
not the GitHub API (`mac/` is a test prerequisite; clone with
`git clone --depth 1 https://github.com/mozilla/multi-account-containers.git mac`).

Per citation: the file exists, the symbol exists in it, and the behaviour we describe is what
that code does now.

**A finding here is a citation that no longer resolves or no longer says what we claim.**

Harder and more valuable: **a bug CC works around may have been fixed** —
`mozilla/multi-account-containers#2582` and Firefox bug 1586612 are both load-bearing
workarounds. Not a finding: a workaround that is still needed. A fix upstream does not mean
deleting ours, because CC supports ESR and a workaround stays until the oldest supported
Firefox no longer needs it — but the note should then say the fix exists.

## D5 — Published prose

**Does `amo/` still describe the add-on, and would a reviewer reproduce what it promises?**
Scope: `amo/summary.txt`, `amo/description.md`, `amo/reviewer-notes.txt`.

`scripts/sign-dev.ts` uploads these with `--amo-metadata` on **every push to main**, so drift
here is published rather than merely sitting in a file — and it overwrites anything edited in
the Developer Hub, so these files are the only copy that matters. Every other drift waits for
someone to read it; this one ships.

Part is **already deterministic and must stay that way**: `test/extension/amo-metadata.test.ts`
pins the PERMISSIONS bullets as an exact set against `extensions/cc/manifest.json` (both
directions — a permission with no bullet, and a bullet outliving its permission) and pins the
Node version against what the workflows really set. Don't re-litigate those by hand.

**A finding here is published prose that no longer describes the add-on.** Check:

- Does the build-reproduction recipe still work? It is the reason the notes exist.
- Does the feature description match what the extension now does?
- Does anything claim a behaviour that has changed — routing, storage, what is sent where?

A finding that could be pinned should become another case in `amo-metadata.test.ts`, which
exists because exactly this drift happened twice.

## D6 — Test justifications vs what the test asserts

**Does each test's comment describe what its body actually pins?**
Scope: `test/`.

Two failure modes, both of which this suite has shipped — e2e cases passing with the feature
entirely broken, and L3 cases asserting the bug rather than the fix:

- **The comment describes a behaviour the body no longer asserts.** The stated coverage is
  imaginary; nothing fails when the behaviour breaks.
- **The case has outlived its stated reason**, while possibly still pinning something real.

Method: read the comment, then read only the assertions, and ask whether the second could fail
if the first stopped being true. Where a case names a bug (F1–F14), check the assertion would
catch *that* bug rather than a neighbour.

**A finding here is a contradiction between a comment and the assertions below it.** Not
findings: past-tense history in a comment, which stays true; and a case whose reason expired
but which still pins something real — that is a comment to rewrite, and saying which is the
useful half.

Settle an uncertain one the way the suite already does — **revert-verify**: back the fix out,
watch it go red, restore it. Editor undo, **not** `git checkout`, which discards uncommitted
work.

## D7 — Expired follow-ups

**Has each entry's resolution condition been met, and is its trade-off still priced right?**
Scope: `FOLLOWUPS.md`.

The file says *"Delete an entry once it is resolved"*, which makes every entry a standing
question owned by nobody. Each states its own condition; some are checkable in one command,
and the entry says which — run it rather than reasoning about it.

**A finding here is a met condition, or a premise that moved.** The second is the more valuable
question: **is the reasoning still sound?** Each entry prices a trade-off against facts that
can move, and one whose premise moved needs re-pricing even if its conclusion survives.

Where an entry's condition cannot be checked from the repo, say so rather than guessing.

## D8 — Cross-document contradictions

**Where two current documents describe the same thing, do they agree?**
Scope: `CLAUDE.md`, `TESTING.md`, `README.md`, `CONFIG.md`, and the four files
`CLAUDE.md` routes to — `docs/{e2e-and-probe,releasing,static-analysis,amo-listing}.md`.
A split raises this review's odds rather than lowering them: prose that used to sit in
one file now sits in two, and the pointer between them is the thing that goes stale.

These overlap deliberately, and overlap means they can disagree with no way for a reader to
tell which is right. Read each account of the topics that appear twice: the test levels and
what each covers, the config grammar and its version gate, the release channels and what each
publishes, the coverage and mutation thresholds.

**A finding here is two current documents that cannot both be right**, with the passage from
each quoted. Not findings: the specs under `docs/superpowers/` and the `docs/modularity-review/`
snapshots, which are dated records — a contradiction between one and the code is history
working correctly. Past-tense history is exempt for the same reason.

## D9 — Does every session need all of CLAUDE.md?

**Is each section highly relevant to every session, and does the file match the documented
guidance?**
Scope: `CLAUDE.md`, plus the task-scoped files it routes to.

`CLAUDE.md` is the only file loaded every session; the routing table at its head names the
rest. So this review asks two questions now, not one: whether anything still in `CLAUDE.md`
belongs behind a row of that table, and whether anything behind a row is in fact
cross-cutting and should come back. The second direction is the one a split makes easy to
forget, and it is the one that costs a wrong change rather than tokens.

**A finding here is a measured judgement, not a contradiction**, so the bar is written out
rather than assumed. Nothing in the file has to be false: CLAUDE.md is read at the start of
**every** conversation, so every line is a tax paid by sessions that will never use it, and
the question is whether each still earns that.

Opinion is legitimate here — *"CLAUDE.md has drifted too large"* is a real finding even though
every sentence in it is true. What it must carry instead of a second citation is a
**measurement**: a number, a named section, and what that section costs the sessions that never
use it. A judgement without one is the "this feels long" that every review rejects.

Measure first and report the numbers:

- total lines, words, and approximate tokens (bytes ÷ 4 is close enough)
- lines per `##` section
- how often the work touches each section's subject: `git log --name-only` over recent months,
  counted per path, against the section that covers it
- bold spans ÷ bullets, for the emphasis test below

Then apply the tests from
[Write an effective CLAUDE.md](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md),
which are the standard this measures against rather than anyone's taste:

- **"Keep it short and human-readable."**
- **"Loaded every session, so only include things that apply broadly. For domain knowledge or
  workflows that are only relevant sometimes, use skills instead"** — loaded on demand
  "without bloating every conversation".
- The per-line test: **"Would removing this cause Claude to make mistakes?"** If not, cut it.
- **"Bloated CLAUDE.md files cause Claude to ignore your actual instructions"**, and the named
  failure pattern: *the over-specified CLAUDE.md*, where "Claude ignores half of it because
  important rules get lost in the noise".
- The ✅/❌ table — notably ❌ *long explanations or tutorials*, *anything Claude can figure out
  by reading code*, *information that changes frequently*.
- **"If you emphasize many lines, none of them stands out."**
- `/doctor` proposes cuts for content derivable from the codebase; `/context` confirms what
  actually loaded.

**State the tension before reporting anything, or this answers "too long" every time.** The ✅
column includes *common gotchas or non-obvious behaviors* and *architectural decisions specific
to your project*, which is a fair description of nearly all of this file — its own header
claims exactly that scope. So **volume alone is not the finding.** The finding is *placement*:
a fact that is a genuine gotcha, but only for a task type most sessions never perform.

Candidates, most defensible first:

1. **A section only a rare task needs.** Compute the fraction of recent commits touching its
   paths. The remedy is a skill or a linked doc, not deletion — the knowledge is real.
2. **Long explanation where a rule would do.** Usually keep the *rule* here and move the
   *argument* to the code it is about.
3. **Content derivable from the code.** What `/doctor` proposes.
4. **Emphasis inflation.** If nearly every line is bold, emphasis has stopped working and the
   lines that need it cannot get it.
5. **Frequently-changing information**, which is a bloat liability and a D1/D3 liability at once.

**Weigh the remedy, don't assume it is free.** Moving a gotcha into a skill means it loads only
when the model judges it relevant — and a fact whose whole job is to stop a reasonable-looking
wrong change is most needed exactly when the model does not yet know it is relevant. A proposal
to move one should say why the trigger would fire in time.

Not findings: "this is long" without a section, a number, and a task type that does not need
it; a gotcha that genuinely is cross-cutting, however long it runs; and any proposal that
*loses* reasoning rather than relocating it — this codebase's premise is that the reasoning is
the artifact, so deleting an argument to save tokens trades a cheap cost for the expensive one
these reviews exist to prevent.
