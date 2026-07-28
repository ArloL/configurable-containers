---
name: comments-only-if-they-add-value
description: Cut comments that restate the code; keep only non-obvious why
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 30b16e3c-b859-4f26-a405-046da333cbf9
---

Write a comment only when it carries information the code does not. Delete anything
that narrates what the next line plainly does, restates a convention already visible
elsewhere in the file, or explains a pattern used unremarked by neighbouring code.

**Why:** given the chance I over-explain — in one workflow I wrote a two-line comment
saying a value goes through `env:` rather than into a `run:` block, when every other
step in the same file already did that without comment. That is noise a reader has to
process and later maintain.

**How to apply:** when reaching for a comment, ask what a competent reader would still
get wrong without it. Non-obvious *why* survives (a constraint, a rejected alternative,
a footgun); restated *what* goes. Prefer one tight line over three. This is the same
instinct as [[no-scratch-notes-in-repo]] — keep only what earns its place.
