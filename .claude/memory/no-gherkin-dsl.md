---
name: no-gherkin-dsl
description: User rejects Gherkin/cucumber test execution AND a separate prose spec; the tests themselves are the spec, read via naming
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8a910ba6-638c-4ee1-bfee-f14aa13c436f
---

The user does not want tests executed via Gherkin/cucumber runners ("that's just stupid regex matching"). Executable tests must be plain developer-friendly BDD-style code (describe/it) with no step-binding DSL.

As of 2026-07-28 this went further: `TESTS.md`, the prose spec of 47 Gherkin-notation scenarios, was **deleted**. The user's words: "I dont want duplication. the tests were just for reference. move it to the source code that should read as 'BDD' as possible using descriptive variables and method names." The behaviour reading now lives in the test source itself.

**Why:** Two descriptions of one system, free to drift, only one of them executable. Step binding adds indirection without power; a shared step-function vocabulary is the same DSL layer by another name.

**How to apply:** Carry the BDD reading with *names*, not structure — descriptive locals and helper names (`browser.opensTab(...)`, `aNavigation(...)`, `theContainerNamed("Work")`), no `// Given/When/Then` comment scaffolding (it restates the code, which they cut) and no step functions. Never propose re-introducing a prose scenario file or a scenario-to-test drift check. See [[comments-only-if-they-add-value]].
