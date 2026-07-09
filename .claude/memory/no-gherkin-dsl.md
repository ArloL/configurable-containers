---
name: no-gherkin-dsl
description: User rejects Gherkin/cucumber test execution; wants plain BDD-style test code without a DSL layer
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8a910ba6-638c-4ee1-bfee-f14aa13c436f
---

The user does not want tests executed via Gherkin/cucumber runners ("that's just stupid regex matching"). Gherkin notation is acceptable as human-readable *spec notation* (as in TESTS.md), but the executable tests must be plain developer-friendly BDD-style code (describe/it, given-when-then in code) with no step-binding DSL.

**Why:** Step binding is regex matching over prose — indirection without added power.

**How to apply:** When designing or writing tests for this project, mirror spec scenarios one-test-per-scenario in plain test code (e.g. Vitest/Playwright); never introduce cucumber-js or step-definition layers. Spec-drift guarantees should be structural (title-matching checks), not step bindings.
