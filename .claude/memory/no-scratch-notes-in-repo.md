---
name: no-scratch-notes-in-repo
description: "Investigation notes don't stay in the repo — fold the durable lessons into CLAUDE.md/tests and delete the file"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2904850c-d139-414c-89df-c19baa99976b
---

The user opened a debugging session by adding `FINDINGS.md` to the repo. Once its
conclusions were folded into `CLAUDE.md` and the tests themselves, they said:
"findings is not necessary anymore then" — and it was deleted.

**Why:** A notes file is a snapshot of one session's understanding, and this one was
substantially wrong by the end (it named a Selenium limitation as the root cause when the
product was broken independently). Stale notes in a repo actively mislead a cold start;
CLAUDE.md is loaded every session and tests are executable, so both stay honest.

**How to apply:**
- Treat a notes/findings markdown file as scratch, not a deliverable. Working files go in
  the scratchpad dir, not the repo.
- When an investigation concludes, move each durable lesson to where it will be *found*:
  a browser/API constraint → `CLAUDE.md`; a behavioural rule → a real test, named for
  the behaviour (`TESTS.md` was deleted 2026-07-28 — the tests are the spec, see
  [[no-gherkin-dsl]]); a why-this-code-is-shaped-this-way → a code comment.
- Then propose deleting the notes file rather than leaving it lying around.
- Correct the earlier conclusions explicitly before deleting — the user cares which of
  their hypotheses were disproven, not just what the answer turned out to be.

Related: [[logical-commits]]
