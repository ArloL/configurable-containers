---
name: compare-tooling-before-deciding
description: User wants detailed side-by-side tooling comparisons before committing to a technical choice
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ce98b98b-fa9b-4ac4-82f8-3fe1e16891f6
---

When a decision involves picking between tools/libraries/approaches, the user wants a detailed comparison (trade-off tables, mechanisms, maturity/risk, fit for future needs) BEFORE being asked to choose — not a quick recommendation. During brainstorming they declined a multiple-choice pick and asked to "compare the tooling options in more detail before deciding."

**Why:** They evaluate trade-offs themselves and surface options I miss (e.g. they pointed to `playwright-webextext`, correcting my claim that Playwright can't load Firefox extensions).

**How to apply:** For tooling forks, present the comparison first (what each does, how it works, risks, long-term fit), give a recommendation, then ask. Be ready to revise when they bring new information. See [[critical-thinking-partner]].

**Measure the gap before proposing the tool.** They challenge recommendations one at a
time ("why do I need #1?", "why #4?", "verify #3 then") and expect numbers, not argument.
On 2026-08-29 three of seven proposed quality gates died on measurement: a bundle-inventory
check (`src/` has exactly two bare imports, both declared; `npm audit --omit=dev` already
walks transitively), knip (0 unused devDependencies; 62 "unused exports" of which ~62 are
option types or constants deliberately exported for tests), and a docs-path-rot check
(142 path references in the live docs, 0 broken). Run the check first and lead with the
count — a proposal that survives measurement is worth far more than three that don't.
