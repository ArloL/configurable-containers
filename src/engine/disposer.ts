import type { BrowserPort, Clock } from "./port";
import { TMP_PREFIX } from "./registry";

const GC_INTERVAL_MS = 600_000; // 10 min, matches TCP

// storage.local key holding cookieStoreId -> the time that container was first OBSERVED
// empty. See the header comment below for why the grace is stored as a fact rather than
// held in a timer.
export const EMPTY_SINCE_KEY = "tmpEmptySince";

type EmptySince = Record<string, number>;

export interface DisposerOptions {
  port: BrowserPort;
  clock: Clock;
  graceMs: number; // keep-alive window
}

// Removes tmp containers once empty. A sibling of the engine — no routing.
//
// The grace is a STORED FACT ("tmp3 has been empty since T"), not a pending timer, and
// that is the whole design. A timer dies with the background context, and options.ts
// calls runtime.reload() on every config save — so the previous version lost every
// pending grace whenever the user hit Save, and its startup sweep, which reclaimed
// orphans at grace 0, then removed the container on the spot. Saving your config
// destroyed the throwaways that were mid-grace (F10, "disposed too early"). Storing the
// timestamp means a restart re-derives how much grace is actually LEFT instead of
// assuming none, and every sweep is idempotent: the answer depends only on the browser's
// current state plus the stored map, never on what this session happens to remember.
//
// Timers are still used, but only as an optimisation — they make disposal punctual while
// the page is alive. Losing one now costs lateness, never early removal: the safe
// direction, and self-correcting on any later sweep.
export function createDisposer(opts: DisposerOptions): void {
  const { port, clock, graceMs } = opts;

  async function readEmptySince(): Promise<EmptySince> {
    const raw = await port.readStored(EMPTY_SINCE_KEY);
    // Anything that is not the shape we wrote is treated as absent rather than trusted:
    // a corrupt map must not be able to make a container look long-expired.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: EmptySince = {};
    for (const [csid, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) out[csid] = at;
    }
    return out;
  }

  function sameMap(a: EmptySince, b: EmptySince): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
  }

  // One pass over every tmp container: remove the expired, start the clock on the
  // newly-empty, forget any that has a tab again (keep-alive) or has gone away. Re-arms
  // itself for the nearest surviving deadline.
  async function sweep(): Promise<void> {
    const tmp = (await port.queryIdentities()).filter((c) => c.name.startsWith(TMP_PREFIX));
    const before = await readEmptySince();
    const after: EmptySince = {};
    const now = clock.now();
    let soonestDeadline = Infinity;

    // One query for every tab rather than one per container: a sweep runs on each tab
    // close, and a user with a dozen throwaways would otherwise pay a dozen round trips
    // each time.
    const occupied = new Set((await port.queryTabs({})).map((t) => t.cookieStoreId));

    for (const container of tmp) {
      const csid = container.cookieStoreId;
      if (occupied.has(csid)) continue; // in use — drop any recorded emptiness (keep-alive)

      // First time anyone noticed it empty — including the case where the PREVIOUS
      // background noticed and this one is only now reading its note.
      const emptySince = before[csid] ?? now;
      if (emptySince + graceMs <= now) {
        await port.removeIdentity(csid);
        continue; // gone: deliberately not carried into `after`
      }
      after[csid] = emptySince;
      soonestDeadline = Math.min(soonestDeadline, emptySince + graceMs);
    }

    // Rewritten wholesale, so a container that was removed, refilled, or deleted by hand
    // leaves no entry behind — the map cannot accumulate garbage across sessions.
    if (!sameMap(before, after)) await port.writeStored(EMPTY_SINCE_KEY, after);

    if (soonestDeadline < Infinity) clock.setTimeout(() => void sweep(), soonestDeadline - now);
  }

  // A tab closing is the only way a container becomes empty, so it is the only trigger
  // needed beyond startup. WHICH container the tab was in does not matter: the sweep asks
  // the browser. That is what lets this survive a restart — the previous version kept a
  // tabId -> container map and had no answer for a tab it never saw created.
  port.onTabRemoved(() => void sweep());

  void (async () => {
    await sweep();
    // Safety net for anything the events missed. No longer crucial for correctness
    // — the deadline re-arm inside sweep() is — but it also restarts the chain if a
    // sweep ever throws.
    const tick = (): void => {
      void sweep();
      clock.setTimeout(tick, GC_INTERVAL_MS);
    };
    clock.setTimeout(tick, GC_INTERVAL_MS);
  })();
}
