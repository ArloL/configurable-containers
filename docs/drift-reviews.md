# Drift reviews

Nine reviews for what no gate in this repo can see. D1–D8 hunt **a true statement that
stopped being true**; D9 asks a different question — whether CLAUDE.md still earns the
context it costs every session, which is a matter of judgement rather than of truth. They
are run by an agent reading and judging, not by a tool.

Nothing in CI can catch these, by design rather than oversight. `test/fitness/` reads `src/`
with comments **stripped** (`test/fitness/sources.ts`) — deliberately, because this codebase
names the very APIs it is careful not to call, so a check on raw text would report
`resolver/types.ts`'s explanation of `browser.cookies.set` as a violation and be deleted
within a week. Coverage counts lines executed, not claims that are true. The mutation gate
mutates code; a comment has no mutants. `tsc` and `oxlint` see syntax and types.

So on 2026-08-29 six comments across three files asserted, in the present tense, that a
config save calls `runtime.reload()` — three days after `seams.test.ts` started pinning that
call *out* of `src/`. Three of them were a test case's stated reason for existing. The only
thing that found them was a person asking a question.

| id | Question | Scope |
| --- | --- | --- |
| **D1** | Does this comment still describe what the code does? | `src/`, `harness/`, `scripts/` |
| **D2** | Is this suppression's reason still true? | every `v8 ignore`, `Stryker disable`, `oxlint-disable`, `sonar.issue.ignore` |
| **D3** | Has the platform moved past this measurement? | measured claims in `CLAUDE.md`, `TESTING.md` |
| **D4** | Does this upstream citation still resolve? | `mac/`, `tcp/`, bug references |
| **D5** | Does the published copy still describe the add-on? | `amo/` |
| **D6** | Does this test still assert what its comment claims? | `test/` |
| **D7** | Has this follow-up's resolution condition been met? | `FOLLOWUPS.md` |
| **D8** | Do two current documents contradict each other? | `CLAUDE.md`, `TESTING.md`, `README.md`, `CONFIG.md` |
| **D9** | Does every session need all of CLAUDE.md? | `CLAUDE.md` |

## What counts as a finding

A non-deterministic review is far easier to make cry wolf than a fitness function, and this
repo's rule is that **a check which cries wolf is deleted and takes its invariant with it**.

1. **A finding is a contradiction or a measured judgement — never an unmeasured
   preference.** Most are contradictions: name two things and say why they cannot both be
   true. D9's are judgements, where nothing is false and the claim is that a cost has grown
   past what it buys. Opinion is legitimate there — *"CLAUDE.md has drifted too large"* is a
   real finding — but it has to arrive with a number, a named section, and what it is
   costing. "This is unclear", "this could be worded better", "this feels long" are not
   findings.
2. **Cite both sides.** For a contradiction: the claim as `file:line`, quoted, and the
   evidence as `file:line` or a command and its output. For a judgement: the measurement and
   what it is being weighed against. A finding you cannot cite twice is a suspicion — drop it.
3. **Silence is a valid and expected result.** Most runs should find nothing. Say so. Never
   manufacture a finding to justify the run; that is what gets the practice switched off.
4. **If a deterministic check could have caught it, say so.** That drift is a gap in
   `test/fitness/`, and the finding should propose the check. These reviews are for what
   cannot be pinned, so every conversion shrinks their territory — which is the point.

Rank by blast radius: `amo/` prose is **published** (pushed to AMO on every push to main),
CLAUDE.md is **load-bearing** (it exists to stop reasonable-looking wrong changes), a test's
justification decides whether anyone can tell the case still earns its slot, and everything
else is local.

Don't fix silently. A wrong "fix" to a comment writes a *new* false statement, which is worse
than the stale one because it looks fresh.

### Never a finding

- **Past-tense history.** "It used to call `runtime.reload()`" stays true, and this codebase
  deliberately keeps the history that explains its shapes. Only present-tense claims go stale.
- **A dated design record.** `docs/superpowers/specs/` and `docs/modularity-review/` are
  snapshots of what was decided on a date, and are *supposed* to diverge from the code. Never
  update one to match; if a decision was reversed, that belongs in CLAUDE.md.
- **A deliberate exception that says it is one.** A suppression arguing its case is doing its
  job; the only question is whether the argument still holds.

---

## D1 — Expired premises

**Does each comment that states how the code behaves still describe it?**

Read prose making a *present-tense, checkable claim* about a mechanism — "X calls Y", "this
runs on every Z", "the only caller is W", "this is the ordinary path" — and check it against
the code. Highest-yield, in order:

1. **A comment justifying a decision by naming a mechanism.** Load-bearing, and what
   CLAUDE.md is made of.
2. **A comment naming a caller, a count, or a frequency.** "The only external consumer", "six
   siblings", "on every config save". Counts drift silently and `grep` settles them.
3. **A comment describing a module that has since been split.** After 2026-08-29, prose about
   "`Recording`" had to become prose about three types.

Don't accept a claim because it sounds right — the reason these survive is that they *all*
sound right. Not findings: past-tense history; a statement of intent ("keep this
synchronous") rather than of fact; a Firefox behaviour, which is D3's job.

**Precedent:** `runtime.reload()` × 6. Also `options.ts` claiming an import "would pull the
background's pause module, and with it the engine, into the options bundle" — which was false
*when written*, not expired. This review catches both shapes, and the second is worth more
because nothing else ever will.

## D2 — Suppressions whose reason expired

**Is each suppression's reason still true, and does the suppressed finding still fire?**

Every suppression here carries a written reason, which is what makes it reviewable:

- `/* v8 ignore … -- why */` — `src/matcher/matcher.ts`, `src/config/load.ts`,
  `src/engine/browser-port.ts`
- `// Stryker disable <mutator>: why` — `src/config/parse.ts`, `src/overlays/cookies.ts`
- `// oxlint-disable-next-line <rule> -- why` — `harness/reaper.ts`,
  `harness/browser/matchers.ts`, `test/config/parse.real.test.ts`
- `sonar.issue.ignore.multicriteria.<id>` — `sonar-project.properties`

Two failure modes needing different fixes: **the reason expired** (a real finding is being
hidden — the severe case), and **the finding no longer fires** (dead weight that will outlive
everyone who understood it — delete it).

This one has a **deterministic half: use it.** Remove the suppression, run the gate, see
whether it complains. That turns most of the work from judgement into measurement; report the
command and its output.

Two standing facts, to check against rather than re-derive: **`S2871` must stay** — taking its
`localeCompare` advice breaks reproducible builds, since that sort is what makes the xpi's
entry order identical on every machine and collation is not. And **zizmor has no suppressions
on purpose** — a run proposing one has the finding inverted; the fix is real.

Check shape as well as content: a suppression disables the line after the **directive**, not
after the reason, so a multi-line `-- because…` block suppresses the next comment line and
nothing else, silently.

## D3 — Measured facts past their shelf life

**Has the platform moved past this measurement, and is the number still what the code does?**

`CLAUDE.md` and `TESTING.md` are full of measurements — that is why the platform notes are
trustworthy, and it is a liability, because a measurement is true *of a version on a date*:
"measured, FF153", "140.14.0esr", "156.0a1 widened the same check", "one first read in twelve
… hydrated 13ms later", "61.8s of `options.test.ts`, measured", "40 rounds … reproduced it
zero times".

Name the version and date each was measured on, and the current version. **A gap is a
candidate, not a finding** — promote it only when the claim's consequence would change, and
**propose the re-measurement rather than guessing the result**. "This may have changed" with
no way to check is noise.

Highest value: **facts that decide what CC must do** — the `view-source:` inner-url behaviour,
`tabs.create` rejecting `about:newtab`, bug 1586612's `onCreated` ordering, `onBeforeNavigate`
preceding the request, and the privileged-context refusal that
`test/e2e/privileged-protocol.test.ts` is the tripwire for. If one changed, a workaround
becomes dead code or a guard becomes wrong — and the Nightly leg catches the second, not the
first.

Also: **numbers in prose that must match a constant.** `MAX_RECORDED_HOSTS` is 200,
`PRODUCTION_GRACE_MS` is five minutes, the coverage and mutation thresholds are 100. One grep
each.

## D4 — Upstream citations

**Does each reference into `mac/` or `tcp/` still resolve, and still say what we claim?**

CLAUDE.md cites both **by file and symbol, never line number**, because they track upstream —
which is what makes this cheap: a symbol either exists or does not. Use the **local
checkout**, not the GitHub API (`mac/` is a test prerequisite; clone with
`git clone --depth 1 https://github.com/mozilla/multi-account-containers.git mac`).

Per citation: the file exists, the symbol exists in it, and the behaviour we describe is what
that code does now. Current ones include `mac/src/js/background/assignManager.js` →
`removeTab` (the reopen keep-or-replace rule), and TCP's `cleanup.ts` → the disposer,
`getAssignment` → the F7 defer.

Harder and more valuable: **a bug CC works around may have been fixed.**
`mozilla/multi-account-containers#2582` and Firefox bug 1586612 are both load-bearing
workarounds. A fix upstream does not mean deleting ours — CC supports ESR, so a workaround
stays until the oldest supported Firefox no longer needs it — but the note should say so.

## D5 — Published prose

**Does `amo/` still describe the add-on, and would a reviewer reproduce what it promises?**

`scripts/sign-dev.ts` uploads `amo/{summary.txt,description.md,reviewer-notes.txt}` with
`--amo-metadata` on **every push to main**, so drift here is published rather than merely
sitting in a file — and it overwrites anything edited in the Developer Hub, so these files are
the only copy that matters.

Part is **already deterministic and must stay that way**:
`test/extension/amo-metadata.test.ts` pins the PERMISSIONS bullets as an exact set against
`extensions/cc/manifest.json` (both directions — a permission with no bullet, and a bullet
outliving its permission) and pins the Node version against what the workflows really set.
Don't re-litigate those by hand. Check the rest:

- Does the build-reproduction recipe still work? It is the reason the notes exist.
- Does the feature description match what the extension now does?
- Does anything claim a behaviour that has changed — routing, storage, what is sent where?

A finding here that could be pinned should become another case in `amo-metadata.test.ts`.
That file exists because exactly this drift happened twice.

## D6 — Test justifications vs what the test asserts

**Does each test's comment describe what its body actually pins?**

Two failure modes, both of which this suite has shipped:

- **The comment describes a behaviour the body no longer asserts.** The stated coverage is
  imaginary. CLAUDE.md records both precedents in its revert-verify bullet: three e2e cases
  passed with auto-temp entirely broken, and L3 cases once asserted the bug rather than the
  fix.
- **The case has outlived its stated reason.** The pause restart case justified itself as "the
  ordinary path" because every config save reloaded the background. Once that stopped being
  true the case was still valuable — it pins the only artifact that survives a restart — but
  nobody could have known that from the comment.

Method: read the comment, then read only the assertions, and ask whether the second could fail
if the first stopped being true. Where a case names a bug (F1–F14), check the assertion would
catch *that* bug rather than a neighbour.

Settle an uncertain finding the way the suite already does — **revert-verify**: back the fix
out, watch it go red, restore it. Editor undo, **not** `git checkout`, which discards
uncommitted work.

## D7 — Expired follow-ups

**Has each `FOLLOWUPS.md` entry's condition been met, and is its trade-off still priced right?**

The file says *"Delete an entry once it is resolved"*, which makes every entry a standing
question owned by nobody. Some conditions are checkable in one command:

- **`harness/selenium-webdriver.d.ts`** — "Delete the file the day the types carry them", and
  it warns *"Nothing will announce it"*, because merging an interface into a class makes
  same-named methods overloads rather than a conflict.
  `grep getDomAttribute node_modules/@types/selenium-webdriver/index.d.ts` settles it; as of
  **4.35.6** it is still absent, so the entry stands.
- **The live `Config` accessor** — the trigger is "when the seventh sibling is written".
  Countable: count the siblings `wireBackground` hands the config to.
- **`reopenedNav` across a restart** — revisit "only if dogfooding shows the wasted reopen
  actually happening". Not checkable from the repo; say so rather than guess.

The more valuable second question: **is the reasoning still sound?** Each entry prices a
trade-off against facts that can move. The `reopenedNav` entry rests partly on how often the
background is torn down — and that frequency *already changed once*, when saves stopped
reloading. A moved premise needs re-pricing even if the conclusion survives.

## D8 — Cross-document contradictions

**Where two current documents describe the same thing, do they agree?**

`CLAUDE.md`, `TESTING.md`, `README.md` and `CONFIG.md` overlap deliberately, and overlap means
they can disagree with no way for a reader to tell which is right. Read each account of the
topics that appear twice: the test levels and what each covers, the config grammar and its
version gate, the release channels and what each publishes, the coverage and mutation
thresholds.

The specs under `docs/superpowers/` and the `docs/modularity-review/` snapshots are **exempt**
— a contradiction between a dated record and the code is history working correctly. A
contradiction between CLAUDE.md and TESTING.md is a finding.

## D9 — Does every session need all of CLAUDE.md?

**Is each section highly relevant to every session, and does the file match the documented
guidance?**

The one review whose findings are judgements rather than contradictions. Nothing here has to
be false: CLAUDE.md is read at the start of **every** conversation, so every line is a tax
paid by sessions that will never use it, and the question is whether each still earns that.

Measure first, and report the numbers — a judgement without them is the vibe rule 1 forbids:

- total lines, words, and approximate tokens (bytes ÷ 4 is close enough)
- lines per `##` section
- how often the work actually touches each section's subject: `git log --name-only` over the
  last few months, counted per path, against the section that covers it

Then apply the tests from
[Write an effective CLAUDE.md](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md),
which are the standard this review measures against rather than anyone's taste:

- **"Keep it short and human-readable."**
- **"Loaded every session, so only include things that apply broadly. For domain knowledge or
  workflows that are only relevant sometimes, use skills instead"** — loaded on demand
  "without bloating every conversation".
- The per-line test: **"Would removing this cause Claude to make mistakes?"** If not, cut it.
- **"Bloated CLAUDE.md files cause Claude to ignore your actual instructions"**, and the named
  failure pattern: *the over-specified CLAUDE.md*, where "Claude ignores half of it because
  important rules get lost in the noise".
- The ✅/❌ table — notably ❌ *long explanations or tutorials*, *anything Claude can figure
  out by reading code*, *information that changes frequently*.
- **"If you emphasize many lines, none of them stands out."** Measurable: bold spans ÷ bullets.
- `/doctor` proposes cuts for content derivable from the codebase; `/context` confirms what
  actually loaded.

**State the tension before reporting anything, or this review says "too long" every time.**
The ✅ column includes *common gotchas or non-obvious behaviors* and *architectural decisions
specific to your project*, which is a fair description of nearly all of this file — its own
header says it carries only "platform and tooling facts that make a reasonable-looking change
wrong". So **volume alone is not the finding.** The finding is *placement*: a fact that is a
genuine gotcha, but only for a task type most sessions never perform.

Candidates, most defensible first:

1. **A section only a rare task needs.** Compute the fraction of recent commits touching its
   paths. Release/AMO and MAC interop are the obvious places to look. The documented remedy
   is a skill or a linked doc, not deletion — the knowledge is real.
2. **Long explanation where a rule would do.** Usually the remedy is to keep the *rule* here
   and move the *argument* to the code it is about, not to delete the argument.
3. **Content derivable from the code.** What `/doctor` proposes.
4. **Emphasis inflation.** If nearly every line is bold, emphasis has stopped working and the
   lines that need it cannot get it.
5. **Frequently-changing information**, which is a bloat liability and a D1/D3 liability at
   once.

**Weigh the remedy, don't assume it is free.** Moving a gotcha into a skill means it loads
only when the model judges it relevant — and a fact whose whole job is to stop a
reasonable-looking wrong change is most needed exactly when the model does not yet know it
is relevant. That risk is real and specific to gotcha-type content, so a proposal to move
one should say why the trigger would fire in time.

Not findings: "this is long" without a section, a number, and a task type that does not need
it; a gotcha that genuinely is cross-cutting, however long it runs; and any proposal that
*loses* reasoning rather than relocating it — this codebase's premise is that the reasoning
is the artifact, so deleting an argument to save tokens trades a cheap cost for the expensive
one this whole directory exists to prevent.
