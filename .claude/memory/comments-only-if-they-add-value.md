---
name: comments-only-if-they-add-value
description: "Cut anything that restates what's already obvious — code comments and prose alike"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 30b16e3c-b859-4f26-a405-046da333cbf9
---

Write a comment, or a sentence, only when it carries information the reader does not
already have. Delete anything that narrates what the next line plainly does, restates a
convention already visible nearby, or hedges a point already made.

**Why:** left alone I over-explain. Three corrections in one session: a two-line comment
saying a value goes through `env:` when every neighbouring step already did that
unremarked; AMO reviewer notes at ~85 lines that needed to be ~45; and inside those, two
separate sentences cut as "unnecessary" — a fallback case nobody asked about, and a
parenthetical reassuring the reader their default was fine. Each was true. None earned
its space.

**How to apply:** before writing, ask what a competent reader would get wrong without it.
Non-obvious *why* survives — a constraint, a rejected alternative, a footgun. Restated
*what*, defensive caveats, and reassurance go. Prefer one tight line to three. When
documenting for an audience whose time is the scarce resource (a reviewer, an on-call
engineer), cut harder than feels comfortable. Same instinct as
[[no-scratch-notes-in-repo]].
