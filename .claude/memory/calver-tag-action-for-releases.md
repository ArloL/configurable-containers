---
name: calver-tag-action-for-releases
description: Uses their own ArloL/calver-tag-action for versioning in GitHub Actions releases
metadata: 
  node_type: memory
  type: user
  originSessionId: 634baee4-1a58-4682-b2dd-b3001a5d9e3a
---

Arlo authors and uses [`ArloL/calver-tag-action`](https://github.com/ArloL/calver-tag-action)
for release versioning, and prefers GitHub Actions for release pipelines. The action tags
`v<YYMM>.0.<micro>` (micro from 101) — e.g. `v2607.0.105` — and exposes `new_version`. It
takes no inputs and pushes the tag itself, so the calling job needs `contents: write` and
must not set `persist-credentials: false`.

**Why:** it's their own tool; assume it over semantic-release or manual version bumps when
a project needs release versioning.

**How to apply:** propose it by name for any repo of theirs that needs versioned releases,
and design around versions being injected at build time rather than hand-edited into
tracked files. See [[logical-commits]] for how they want the accompanying commits split.
