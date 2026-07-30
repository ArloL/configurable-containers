# Syncing the Config Between Machines — Design

**Date:** 2026-07-30
**Status:** Approved, pending implementation plan
**Topic:** Mirror the stored config into `browser.storage.sync` so a config edited on one
machine reaches every other machine the user is signed into Firefox Sync on. Amends the
2026-07-28 storage slice, whose §1 out-of-scope list said "`storage.sync`. Single-machine
tool; `storage.local` only."

## 1. Goal & scope

The config lives in `browser.storage.local`, edited in the built-in options page. That was
the right first slice, but it makes a second machine a manual copy-paste: select all in the
editor on machine A, paste into the editor on machine B, and remember to do it again after
every edit. The failure mode is not an error — it is two machines quietly routing by
different rules, which is exactly the class of silent wrong answer the rest of this project
is built to avoid.

Firefox already carries extension storage between a user's machines. This slice uses it.

### In scope

- A pure **`src/config/sync-record.ts`** — how a config is encoded into the sync area
  (chunking, integrity), how it is decoded back, and the whole local-vs-remote decision.
  No `browser.*`, so the entire policy is testable without a browser.
- **`src/extension/config-sync.ts`** — the adapter. An injected-ports orchestrator plus a
  factory that builds the real `browser.storage.sync` ports.
- `src/extension/config.ts` gains the second storage key (`configUpdatedAt`), the
  replaced-config backup (`configYamlReplaced`), and thin sync-area accessors.
- `src/extension/background.ts` starts the reconciliation in its existing async tail.
- The options page gains a **sync status line** and a **restore affordance** for a config
  that an incoming sync replaced.
- Tests: L1 for the pure record and the reconciliation table; a fake-ports level for the
  orchestrator (adopt, push, wait, quota, loop-freedom); L4 in real Firefox for the two
  things only Firefox can answer — that a write of this shape is accepted at all, and that
  a config larger than one item still round-trips.

### Out of scope (deferred, with reasons)

- **A per-machine off switch.** Sync is on for every install (§5). A machine that must not
  publish its config has no way to opt out short of uninstalling. The switch is a checkbox
  and a third local key; it is deferred because nothing yet says the default is wrong, and
  a setting added before its first user is a setting shaped by guesswork.
- **Export / import to a file.** Still the 2026-07-28 answer: select-all-copy out of the
  textarea. It composes with a dotfiles repo in a way `storage.sync` never will, so it is a
  plausible *second* transport — but it is a manual step per machine per edit, which is the
  problem this slice exists to remove.
- **Fetching the config from a URL.** Pull-based, so no conflict resolution at all, and the
  config stays version-controlled. It also adds a host permission, a trust boundary, and a
  refresh policy. Worth revisiting only if `storage.sync`'s quota or its Firefox Account
  requirement turns out to bite.
- **Three-way merge.** The config is a hand-written YAML file with comments; merging two
  edited versions means a text merge with conflict markers, and there is nowhere to resolve
  them but the textarea. Last-write-wins plus a kept backup (§6) is the honest answer at
  this size.
- **Syncing anything but the config.** The disposer's `emptySince` map is machine-local
  state about machine-local containers and must never leave the machine.

## 2. Architecture & model

```
src/config/sync-record.ts    (pure, L1)   encode / decode / reconcile
src/extension/config-sync.ts (L4 adapter) orchestrator + browser.storage.sync ports
src/extension/config.ts      (L4 adapter) local keys + sync-area accessors
```

**`storage.local.configYaml` stays the single source of truth for routing.** Nothing in the
engine, the wiring, or `loadConfig` learns that sync exists. The sync area is a *mirror*:
it is read, compared, and either overwritten from local or copied into local. That is what
keeps this slice from touching the startup contract that `wireBackground` documents at
length — the listeners still register synchronously, the config still arrives through one
object filled in place, and the gated first navigation still waits on exactly one promise.

Applying an adopted config uses the mechanism that already exists: write
`storage.local`, then `browser.runtime.reload()`. This is the same path a Save takes, so
there is no second way for a config to take effect.

**The background is the only writer of the sync area.** The options page writes
`storage.local` and reloads; the fresh background then reconciles and pushes. One publisher
means there is no window in which a dying options page and a starting background both
write. The options page reads the sync area, but only to render status.

## 3. The pure core

```ts
// src/config/sync-record.ts
export const SYNC_VERSION = 1;
export const META_KEY = "ccConfigMeta";
export const PART_KEY_PREFIX = "ccConfigPart";
export const CHUNK_CHARS = 3000;
export const MAX_PARTS = 16;

export interface SyncMeta {
  v: number; parts: number; len: number; hash: string; updatedAt: number;
}

export type RemoteConfig =
  | { state: "absent" }        // no meta key — nothing has ever been published
  | { state: "incomplete" }    // meta present, parts missing or hash mismatch
  | { state: "unreadable" }    // meta written by a newer SYNC_VERSION
  | { state: "ok"; text: string; updatedAt: number; parts: number };

export type Reconciliation =
  | { action: "none" }
  | { action: "push" }
  | { action: "adopt"; text: string; updatedAt: number };

export function hashText(text: string): string;
export function encodeRecord(text: string, updatedAt: number): Record<string, unknown>;
export function decodeRecord(items: Record<string, unknown>): RemoteConfig;
export function staleKeys(items: Record<string, unknown>, parts: number): string[];
export function reconcile(local: { text: string; updatedAt: number }, remote: RemoteConfig): Reconciliation;
```

### Why the config is chunked

Firefox enforces `QUOTA_BYTES_PER_ITEM = 8192` on `storage.sync`, counted over the JSON
encoding of the value. The author's config is already 5.7 KB and the shipped default is
4 KB, so a single item clears today and stops clearing after a few more rules — a cliff
that would arrive as a `QuotaExceededError` months from now, on whichever machine happened
to save last.

`CHUNK_CHARS = 3000` is chosen so the limit cannot be reached even in the worst case: a
config is newline-dense YAML, every newline doubles in width under JSON escaping, and 3000
characters that *all* escaped would still encode to ~6 KB.

`MAX_PARTS = 16` is bounded by that same worst case against the area-wide
`QUOTA_BYTES = 102400`: sixteen fully-escaped parts are ~96 KB and still clear, where
thirty-two would be ~192 KB. Thirty-two was the first choice, and it would have measured
fine against any ordinary config — the arithmetic only fails on a newline-dense one, which
is exactly the kind of limit that holds until it doesn't. Sixteen parts is 48 000
characters, eight times the author's config; past it a config fails loudly (§7) rather
than being silently truncated.

Both bounds are asserted in `test/config/sync-record.test.ts` against the two quota
numbers written out as literals, because **chunking is otherwise invisible below L4**:
every other test in that file interpolates `CHUNK_CHARS`, so raising it to a million
leaves them all green. Only Firefox rejects an oversized item.

An empty config is a legal config — `parseConfig("")` succeeds and means "nothing matches"
— so `encodeRecord` always emits at least one part. Zero parts would decode as `absent`,
and "the user published an empty config" would be indistinguishable from "nobody has
published anything".

### Why `decodeRecord` distinguishes `incomplete` from `absent`

The parts and the meta key arrive at the receiving machine as ordinary storage changes, and
nothing guarantees they land together. A machine that read the area mid-arrival sees a meta
key claiming three parts with only two present, or three parts whose concatenation does not
match the meta's hash.

Collapsing that into "no record" would be actively harmful: `absent` means *push*, so a
machine observing a half-arrived config would publish its own older one over the top of the
update that was still landing — and the machine that sent it would then adopt the rollback.
`incomplete` means **wait**: the remaining keys will arrive and fire another change event.

`unreadable` (a record written by a future `SYNC_VERSION`) waits for the same reason. A
newer version of the extension on another machine is not something to overwrite.

The integrity check is a hash rather than a length comparison because two configs of equal
length are not rare — an edit that swaps one host for another of the same width is a normal
edit, and the point of the check is to reject a *mixture* of an old part and a new one.
`hashText` is a 32-bit FNV-1a: pure, dependency-free, deterministic across machines, and
sized for detecting torn writes, not for resisting an adversary.

### The reconciliation table

| Remote | Condition | Action |
|---|---|---|
| `absent` | — | **push** |
| `incomplete` / `unreadable` | — | **none** (wait for the rest / for a newer build) |
| `ok` | text equals local | **none** |
| `ok` | remote `updatedAt` > local | **adopt** |
| `ok` | remote `updatedAt` < local | **push** |
| `ok` | equal `updatedAt`, different text | tie-break: **adopt** iff `remote.text > local.text` |

Two properties are load-bearing, and both are about *convergence* rather than about
picking the better config:

- **`adopt` is never returned for text equal to the local text.** Adoption ends in
  `runtime.reload()`. If equal texts could adopt, two machines would reload each other
  forever, and the symptom would be an extension that restarts every few seconds on both
  machines at once.
- **The tie-break compares the texts, and therefore computes the same answer on both
  machines.** A tie is not hypothetical: §5 backfills a stamp of `1` onto every config that
  was edited before this slice existed, so the first startup after an update has two
  machines holding different text at the same stamp. A tie-break of "local wins" would make
  *both* sides push, each overwriting the other, forever. Comparing the text itself (rather
  than its hash) means a collision cannot reintroduce that: two different strings always
  compare unequal.

## 4. Storage contract

`browser.storage.local` — machine-local, and the truth for routing:

| Key | Meaning |
|---|---|
| `configYaml` | The config. Unchanged from the 2026-07-28 slice. |
| `configUpdatedAt` | Milliseconds since the epoch, when this text was authored *or adopted*. Adopting copies the remote stamp so the two stay comparable. |
| `configYamlReplaced` | The text an incoming sync overwrote, kept so §6 can offer it back. |

`browser.storage.sync` — the mirror:

| Key | Value |
|---|---|
| `ccConfigMeta` | `{ v, parts, len, hash, updatedAt }` |
| `ccConfigPart0` … | The config text, `CHUNK_CHARS` at a time |

A push writes the parts and the meta in **one** `set`, then removes stale parts left by a
longer previous config in a second call. That order is deliberate: after the `set` the
record is already complete and self-consistent (the meta names the parts to read, so a
lingering higher-numbered part is ignored), whereas removing first would tear the record if
the `set` then failed.

## 5. Sync is on for every install

There is no toggle. An installed CC publishes its config and adopts changes.

The config is not neutral data — it carries the hostnames a person visits and the names
they gave their containers. What makes on-by-default acceptable is *where* it goes:
`storage.sync` is the user's own Firefox Account, end-to-end encrypted, and it moves the
data between that user's own machines and nowhere else. No third party receives it and the
extension has no server. The AMO `data_collection_permissions: required: ["none"]`
declaration stays accurate — nothing is collected by or transmitted to the add-on's author.
A machine not signed into Sync still works: Firefox keeps the record locally and uploads it
if and when an account is connected.

### What on-by-default costs on the update itself

Every existing install already has an edited config and no stamp. If two of them push at
once, one config replaces the other. Three things bound that:

1. **The stamp backfill ranks an untouched install below an edited one.** A missing
   `configUpdatedAt` is filled in at the first sync-enabled startup: `0` when the stored
   text is byte-identical to the shipped seed (never edited), `1` otherwise (edited, but
   before stamps existed). A fresh install therefore always loses to a machine with real
   rules, which is the direction that matters — the alternative is a stranger's default
   config landing on the machine that had the work.
2. **First-run seeding writes stamp `0`** for the same reason, so a newly installed machine
   joining an established Sync account pulls the real config instead of pushing the default
   over it.
3. **Two edited machines still resolve to one config**, deterministically (§3), and the
   loser's text is kept (§6). It is a decision the user can undo, not a deletion.

## 6. When an incoming config replaces yours

Adoption writes the previous text to `configYamlReplaced` before overwriting `configYaml`.
The options page, when that key is present and differs from the current config, shows a
line saying a synced config replaced the one stored here and a button that loads the
replaced text **into the textarea** — not into storage.

Loading it into the editor rather than committing it is the whole point. The user sees what
they are restoring, the existing validate-on-input runs against it, and keeping it goes
through the same Save the user already knows: stamp, reload, push. There is no second write
path that could stamp or publish differently from a normal edit, and Save clears the backup.

Without this, the first startup after this slice ships is a silent overwrite of a
hand-written file. That is the one failure here that is not recoverable by editing, which
is why it gets UI and the deferred off-switch does not.

## 7. Failure behaviour

Every failure is contained to sync; none of them can change how a tab is routed, because
routing reads `storage.local` and never learns whether the mirror is healthy.

| Failure | Behaviour |
|---|---|
| `storage.sync` unreadable or unwritable (no account, quota, transient) | `console.warn`, outcome `failed`. The local config is untouched and CC routes normally. Retried at the next startup and the next change event. |
| Config exceeds `MAX_PARTS` | Nothing is written. The options page says so, with the part count and the limit, so the fix (a smaller config) is discoverable. |
| Remote record half-arrived | `none` — wait. The rest of the keys fire another change event. |
| Remote record from a newer `SYNC_VERSION` | `none` — never overwritten by an older build. |
| Adopted config does not parse | The existing 2026-07-28 §6 behaviour: empty config, everything temporary, editor opens with the error. Correct here too — the other machine saved something this build cannot read, and the text is in the textarea to fix. |

Reconciliations are serialised through a single promise chain. Change events arrive while a
push is in flight (a push is itself a change event), and two concurrent reconciliations
could both read a pre-write area and both decide to push.

## 8. Testing (down the pyramid)

**L1 — `test/config/sync-record.test.ts`.** Round-trip at every size boundary (empty, one
character, exactly `CHUNK_CHARS`, one past it, multi-part); `decodeRecord` returning
`incomplete` for a missing part and for a mutated part (the hash's whole job); `absent` for
an empty area; `unreadable` for a future version; `staleKeys`; the full §3 reconciliation
table including both convergence properties — equal text never adopts, and the tie-break
returns opposite actions when the two sides are swapped.

**Fake ports — `test/extension/config-sync.test.ts`.** The orchestrator against an
in-memory sync area: pushes into an empty area; adopts a newer remote and applies it
exactly once; does nothing when the texts agree (the anti-ping-pong case, driven by feeding
the push's own change event back in); waits on a torn record instead of pushing over it;
reports `too-large` without writing; survives a throwing area. This is the level that owns
adoption, because L4 cannot reach it (below).

**L4 — `test/e2e/config-sync.test.ts`.** Two cases, both about what only real Firefox can
answer:

1. **A saved config reaches the sync area.** Edit, Save, and after the reload the options
   page reports the config as synced. This proves the whole chain — local write, reload,
   background push, `browser.storage.sync.set` accepted by Firefox — rather than a mock's
   opinion of it.
2. **A config larger than one item still round-trips.** A config past `CHUNK_CHARS` reports
   more than one part. Firefox enforces the per-item quota; a single-item implementation
   fails here and nowhere else in the suite.

**What L4 cannot cover, and why.** Adoption needs a change to appear in the sync area from
*outside* this profile. A test profile has no Firefox Account, WebDriver cannot navigate to
a `moz-extension:` URL to script an extension page, and the probe is a different extension
with a different sync namespace — so there is no arrangement that writes CC's sync area
without going through CC. Adoption is therefore fake-ports-only. The line worth holding is
that the fake covers *policy* while L4 covers *acceptance by Firefox*: a bug in what we
decide to do is catchable above, and a bug in what Firefox will accept is catchable below.

Per CLAUDE.md, every new test is revert-verified — back the change out, watch it go red,
restore it from an editor undo or a copy, never `git checkout`.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Reload ping-pong** — two machines adopting each other forever, each reload triggering the next. | `adopt` is unreachable for equal text (§3), so a converged pair is silent. Asserted at L1 and again at the fake-ports level by replaying a push's own change event. |
| **Clock skew** decides a conflict wrongly — a machine an hour behind loses an edit made after the other's. | Accepted, and the reason §6 exists: the losing text is kept and restorable. A logical clock (a monotonically incremented counter in the record) would remove the skew but not the loss, and it cannot be seeded correctly across installs that already disagree. |
| **A torn read causes a rollback push.** | `incomplete` is a distinct state that waits (§3). This is the single most consequential branch in the module and has its own L1 cases. |
| **Quota grows past `MAX_PARTS` unnoticed.** | The options page renders the part count on every visit, so the number is visible long before the limit, and exceeding it is stated rather than swallowed. |
| **Extra `runtime.reload()`s** — an adoption drops `reopenedNav`, costing a wasted reopen (FOLLOWUPS 2026-07-28). | Same cost as the config save that already triggers a reload, and it happens once per *incoming change*, not per navigation. Converges and leaks no container. |
| **The update publishes a config the user did not intend to publish.** | Inherent to on-by-default (§5) and the reason the off switch is called out as deferred rather than declined. |

## 10. What this slice does not prove

- **That two real machines converge.** Everything above the fake ports is single-profile.
  The convergence argument is a proof about a pure function plus a test that replays change
  events into it; it is not two laptops.
- **That Firefox Sync propagates the record promptly.** Timing between machines is
  Firefox's, unobserved here.
- **That `storage.sync` behaves the same on Firefox for Android.** Untested.
- **That the config format is stable enough to sync.** `SYNC_VERSION` reserves the ability
  to change the record's shape; it does not answer what happens when two machines run
  builds whose *YAML schemas* differ. The older build falls to §7's parse failure — loud,
  and no worse than today, but not a migration story.
