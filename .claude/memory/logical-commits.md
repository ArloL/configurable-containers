---
name: logical-commits
description: "How the user wants work committed — split into logical, individually-green commits, not one dump"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2904850c-d139-414c-89df-c19baa99976b
---

When work is done, the user asks to "create logical commits of these changes" — split by
*reason for the change*, not by file or by chronology, and never one omnibus commit.

**Why:** The split is the explanation. A reviewer reading `feat(auto-temp): …` next to
`test(mock): make the mock port reject what Firefox rejects` learns why the mock changed;
one squashed commit hides that entirely.

**How to apply:**
1. Order commits by dependency, so each one stands on a working tree: harness/test
   infrastructure first, then the feature that uses it, then its tests, then docs.
2. Verify intermediate commits are actually green (`git stash --include-untracked`, run
   the unit tests, pop) — don't just assume bisectability.
3. Conventional-commit prefixes, matching the repo's history: `feat(scope)`, `fix(scope)`,
   `test(scope)`, `docs`. Body explains *why*, and names the constraint that forced the
   design (e.g. "Firefox rejects about:newtab from tabs.create").
4. Keep drive-by fixes in their own commit, labelled as unrelated, and say so — don't
   fold an unrelated flake fix into a feature commit.
5. Full suite + typecheck green before committing, and confirm a clean tree after.

Related: [[no-scratch-notes-in-repo]], [[user-runs-manual-firefox]]
