import type { BrowserPort, Clock } from "./port";
import { isThrowawayName } from "./registry";

const GC_INTERVAL_MS = 600_000; // 10 min, matches TCP

// storage.local key: cookieStoreId -> when that container was first OBSERVED empty. The
// header below says why the grace is stored rather than held in a timer.
export const EMPTY_SINCE_KEY = "tmpEmptySince";

type EmptySince = Record<string, number>;

export interface DisposerOptions {
  port: BrowserPort;
  clock: Clock;
  graceMs: number; // keep-alive window
}

// Removes tmp containers once empty. A sibling of the engine — no routing.
//
// The grace is a STORED FACT ("tmp3 has been empty since T"), not a pending timer, and that
// is the whole design. A timer dies with the background context, and options.ts calls
// runtime.reload() on every config save — so the timer version lost every pending grace on
// Save, and its startup sweep, which reclaimed orphans at grace 0, then removed the
// container on the spot: saving your config destroyed live throwaways (F10). Storing the
// timestamp lets a restart re-derive the grace that is LEFT, and makes every sweep
// idempotent — the answer depends on the browser's state plus the stored map, never on what
// this session remembers.
//
// Timers survive as an optimisation, making disposal punctual while the page is alive.
// Losing one now costs lateness, never early removal, and any later sweep corrects it.
export function createDisposer(opts: DisposerOptions): void {
  const { port, clock, graceMs } = opts;

  async function readEmptySince(): Promise<EmptySince> {
    const raw = await port.readStored(EMPTY_SINCE_KEY);
    // Anything that is not the shape we wrote counts as absent: a corrupt map must not
    // make a container look long-expired.
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

  // One pass over every throwaway: remove the expired, start the clock on the newly-empty,
  // forget any that has a tab again (keep-alive) or has gone. Re-arms for the nearest
  // surviving deadline.
  async function sweep(): Promise<void> {
    const tmp = (await port.queryIdentities()).filter((c) => isThrowawayName(c.name));
    const before = await readEmptySince();
    const after: EmptySince = {};
    const now = clock.now();
    let soonestDeadline = Infinity;

    // One query for all tabs rather than one per container: a sweep runs on every tab
    // close, and a dozen throwaways would mean a dozen round trips each time.
    const occupied = new Set((await port.queryTabs({})).map((t) => t.cookieStoreId));

    for (const container of tmp) {
      const csid = container.cookieStoreId;
      if (occupied.has(csid)) continue; // in use — drop any recorded emptiness (keep-alive)

      // First time anyone noticed it empty — including a PREVIOUS background whose note
      // this one is only now reading.
      const emptySince = before[csid] ?? now;
      if (emptySince + graceMs <= now) {
        await port.removeIdentity(csid);
        continue; // gone: deliberately not carried into `after`
      }
      after[csid] = emptySince;
      soonestDeadline = Math.min(soonestDeadline, emptySince + graceMs);
    }

    // Rewritten wholesale, so a container removed, refilled or deleted by hand leaves no
    // entry behind and the map cannot accumulate garbage across sessions.
    if (!sameMap(before, after)) await port.writeStored(EMPTY_SINCE_KEY, after);

    if (soonestDeadline < Infinity) clock.setTimeout(() => void sweep(), soonestDeadline - now);
  }

  // A tab closing is the only way a container becomes empty, so it is the only trigger
  // beyond startup. WHICH container the tab was in does not matter: the sweep asks the
  // browser. That is what survives a restart — the previous version kept a tabId ->
  // container map and had no answer for a tab it never saw created.
  port.onTabRemoved(() => void sweep());

  void (async () => {
    await sweep();
    // Safety net for what the events missed. Correctness rests on sweep()'s deadline
    // re-arm, but this restarts the chain if a sweep ever throws.
    const tick = (): void => {
      void sweep();
      clock.setTimeout(tick, GC_INTERVAL_MS);
    };
    clock.setTimeout(tick, GC_INTERVAL_MS);
  })();
}
