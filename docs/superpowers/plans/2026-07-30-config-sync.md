# Syncing the Config Between Machines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A config edited on one machine reaches every other machine the user is signed into Firefox Sync on, with no manual step, and without any machine silently losing a hand-written config.

**Architecture:** One new pure module (`src/config/sync-record.ts`) owns the record format and the entire local-vs-remote decision. One new adapter (`src/extension/config-sync.ts`) moves bytes through injected ports. `storage.local.configYaml` stays the only thing routing reads — the sync area is a mirror, and applying an adopted config reuses the existing write-then-`runtime.reload()` path. **The `BrowserPort` seam does not change** and neither does `wireBackground`, so there is no L3 churn and the synchronous-listener contract is untouched.

**Tech Stack:** TypeScript, esbuild (IIFE bundles), Vitest, Selenium/geckodriver against real Firefox.

**Design of record:** `docs/superpowers/specs/2026-07-30-config-sync-design.md`. Read it before starting; this plan implements it and does not restate its reasoning.

## Global Constraints

- **`storage.local.configYaml` remains the single source of truth for routing.** Nothing in `src/engine/`, `src/resolver/`, `src/matcher/` or `src/extension/wiring.ts` may learn that sync exists.
- **Do not add methods to `BrowserPort` (`src/engine/port.ts`).** Storage is an extension-layer concern; `src/extension/*.ts` touches `browser.*` directly, as `config.ts` and `choice.ts` already do.
- **Do not move listener registration in `background.ts`.** `wireBackground` is called at module top level and never awaits; sync starts in the existing async tail, after `injectScripts()`.
- **The background is the only writer of the sync area.** The options page may read it for status; it must not write it.
- **Exact strings:** local keys `configYaml`, `configUpdatedAt`, `configYamlReplaced`; sync keys `ccConfigMeta`, `ccConfigPart<i>`.
- **`npm test` runs unit *and* e2e** and launches real Firefox. `npm run typecheck` covers `src/`, `test/` and `harness/` — test code must type-clean.
- **Keep `fileParallelism: false` in `vitest.config.ts`.**
- **Revert-verify every new test:** back the change out, watch it go red, restore it from an editor undo or a copy, **never** `git checkout`.
- **Conventional commit prefixes**, one logical change per commit.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/config/sync-record.ts` | Pure: encode / decode / `staleKeys` / `reconcile`. The whole policy. |
| `src/extension/config-sync.ts` | Orchestrator over injected ports, plus the real `browser.storage.sync` ports. |
| `test/config/sync-record.test.ts` | L1 for the record format and the reconciliation table. |
| `test/extension/config-sync.test.ts` | Orchestrator against an in-memory sync area. |
| `test/e2e/config-sync.test.ts` | L4: a saved config reaches the sync area; a multi-part one round-trips. |

**Modified**

| File | Change |
|---|---|
| `src/extension/config.ts` | `configUpdatedAt` + `configYamlReplaced` accessors; sync-area read/write/subscribe. |
| `src/extension/background.ts` | Seed with stamp `0`; start config sync in the async tail. |
| `src/extension/options.ts` | Stamp on save, clear the backup, render sync status, restore-into-editor button. |
| `extensions/cc/options.html` | Status line and the restore affordance. |
| `CONFIG.md` | A "Syncing between machines" section. |
| `CLAUDE.md` | What a cold start gets wrong about the mirror, the tie-break, and the L4 gap. |
| `FOLLOWUPS.md` | The deferred per-machine off switch. |

---

### Task 1: The pure record and reconciliation

**Files:** Create `src/config/sync-record.ts`; test `test/config/sync-record.test.ts`.

- [x] `hashText` — 32-bit FNV-1a, hex, zero-padded. Deterministic across machines.
- [x] `splitParts` / `encodeRecord` / `partKey` — chunk at `CHUNK_CHARS = 3000`, always at least one part, throw `ConfigTooLargeError` past `MAX_PARTS = 16`.
- [x] `decodeRecord` — the four states. `absent` only when the meta key is missing; `incomplete` when a part is missing or the hash disagrees; `unreadable` for a newer `SYNC_VERSION`.
- [x] `staleKeys` — part keys in the area at or above the new part count.
- [x] `reconcile` — spec §3's table. Equal text is always `none`; equal stamps tie-break on the text so both machines compute opposite actions.

**Tests:** round-trip at empty / 1 char / exactly `CHUNK_CHARS` / one past / multi-part; missing part → `incomplete`; mutated part → `incomplete`; empty area → `absent`; future version → `unreadable`; the reconciliation table; and the two convergence properties (equal text never adopts; swapping the two sides of a tie flips push↔adopt).

### Task 2: Local storage keys

**Files:** Modify `src/extension/config.ts`; extend `test/extension/config.test.ts` if it asserts the module's surface.

- [x] `CONFIG_UPDATED_AT_KEY`, `CONFIG_REPLACED_KEY`; `UNEDITED = 0`, `PRE_SYNC_EDIT = 1`.
- [x] `writeStoredConfigYaml(text, updatedAt = Date.now())` — one `set` for both keys, so a config and its stamp cannot land separately.
- [x] `readStoredUpdatedAt`, `readReplacedConfigYaml`, `clearReplacedConfigYaml`.
- [x] `readSyncItems` / `writeSyncItems(items, remove)` — **set first, then remove**, per spec §4.
- [x] `onSyncStorageChanged(handler)` — `browser.storage.onChanged` filtered to `areaName === "sync"`.

### Task 3: The orchestrator

**Files:** Create `src/extension/config-sync.ts`; test `test/extension/config-sync.test.ts`.

- [x] `SyncPorts` (`readLocal`, `adopt`, `readSync`, `writeSync`, `onSyncChanged`, `warn`) and `createConfigSync(ports)` returning `{ start, sync }`.
- [x] Serialise every reconciliation through one promise chain (spec §7).
- [x] `start()` registers the change listener *before* the first reconciliation, so a change arriving during it is not lost.
- [x] `browserSyncPorts()` — the real ports. `readLocal` backfills a missing stamp (`0` when the text equals `SEED_CONFIG_YAML`, else `1`); `adopt` writes the backup, the text and the stamp in one `set`, then reloads.

**Tests (fake in-memory area):** pushes into an empty area; adopts a newer remote once; no-ops when texts agree, including when fed its own push's change event; waits on a torn record instead of pushing; `too-large` without writing; a throwing area yields `failed` and leaves local alone.

### Task 4: Start it at the right moment

**Files:** Modify `src/extension/background.ts`.

- [x] First-run seeding writes stamp `UNEDITED`.
- [x] `await createConfigSync(browserSyncPorts()).start()` as the last step of the async tail, after `injectScripts()`.
- [x] Verify by inspection that no listener registration moved above an `await`.

### Task 5: The options page

**Files:** Modify `src/extension/options.ts`, `extensions/cc/options.html`.

- [x] Save stamps `Date.now()` and clears `configYamlReplaced`.
- [x] A status line derived from a live read of the sync area plus the local text: synced (with part count and the stamp as a local date), not yet published, syncing, written by a newer version, or too large with the count and the limit.
- [x] Re-render on `onSyncStorageChanged`, so the page is live while the background pushes.
- [x] The restore affordance: shown only when `configYamlReplaced` is present and differs; loads that text **into the textarea**, runs the existing validation, and leaves keeping it to Save.

### Task 6: L4

**Files:** Create `test/e2e/config-sync.test.ts`.

- [x] Reuse `test/e2e/options.test.ts`'s park-on-probe-page / open-editor helpers.
- [x] Case 1: park, open the editor, and the status reports the config published. Drive it from the **startup** push, not a Save — observing after `runtime.reload()` means re-parking on a torn-down extension page, which wedges the driver.
- [x] Case 2: a config past `CHUNK_CHARS` reports more than one part.
- [x] Poll the status element rather than sleeping — the push happens in the background's tail.

### Task 7: Documentation

**Files:** `CONFIG.md`, `CLAUDE.md`, `FOLLOWUPS.md`.

- [x] `CONFIG.md`: a "Syncing between machines" section — what syncs, the conflict rule, the backup, the size limit.
- [x] `CLAUDE.md`: the mirror-not-truth invariant, why `incomplete` ≠ `absent`, why the tie-break compares text, and that adoption has no L4 coverage and cannot have one.
- [x] `FOLLOWUPS.md`: the deferred per-machine off switch, and what would justify building it.
