---
name: upstream-reference-submodules
description: tcp/ and mac/ are git submodules tracking upstream Temporary Containers and Multi-Account Containers as reference
metadata: 
  node_type: memory
  type: reference
  originSessionId: a236021d-07e7-4a08-a9aa-565015a0322c
---

`configurable-containers` re-implements the ideas of both **Temporary Containers**
and **Multi-Account Containers**. Two git submodules track their upstreams for
reference (e2e patterns, required permissions, lifecycle/isolation ideas):

- `tcp/` → https://github.com/GodKratos/temporary-containers (a Temporary Containers fork)
- `mac/` → https://github.com/mozilla/multi-account-containers

Consult them when designing engine/adapter behavior — e.g. TCP's `getAssignment`
MAC-defer handshake and its `webRequest` reopen guards were the reference for the
L3 engine. They are reference-only; don't treat their code as this project's code.
Related: [[e2e-driver-selenium-not-playwright]].
