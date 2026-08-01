import { targetLabel, type Declinable } from "./engine";
import type { Decision } from "../resolver/types";
import type { BrowserPort, Clock } from "./port";

// storage.local key holding the armed set and the recordings. The background is its ONLY
// writer: the options page reads through a message instead, because a host row landing
// mid-render would otherwise race a toggle and one of the two writes would be lost.
export const PAUSE_STORAGE_KEY = "pauseState";

// Hosts only, so the storage cost is bytes; the cap exists to keep the list readable.
export const MAX_RECORDINGS = 10;

export interface RecordedHost {
  host: string;
  hits: number; // main_frame hops that resolved to this host
  wouldHave: string; // the routing action CC declined to take, in the F9 toast's words
}

export interface Recording {
  id: string;
  cookieStoreId: string;
  // The container's display name AT ARM TIME. The dominant case is a throwaway, which
  // the disposer deletes minutes after the flow ends — by the time the user reads the
  // recording getIdentity() returns null, and a recording that cannot say which
  // container it came from is much harder to interpret.
  container: string;
  startedAt: number;
  endedAt: number | null; // null while running
  hosts: RecordedHost[]; // first-seen order
}

export interface PauseState {
  armed: string[];
  recordings: Recording[]; // newest first
}

export type ArmResult = { ok: true; container: string } | { ok: false; reason: string };

export interface Pause {
  // Consulted inside the blocking onBeforeRequest handler, so it is synchronous and
  // reads no storage: an await here would sit in the latency of every navigation in the
  // browser, armed or not.
  isPaused(cookieStoreId: string): boolean;
  // Returns void, and the engine never awaits it: a navigation must not wait on
  // bookkeeping, and a write that fails must not break routing.
  record(cookieStoreId: string, url: string, decision: Decision): void;
  arm(cookieStoreId: string): Promise<ArmResult>;
  disarm(cookieStoreId: string): Promise<ArmResult>;
  hydrate(): Promise<void>;
  snapshot(): PauseState;
}

const DEFAULT_STORE_ID = "firefox-default";

// The F9 toast's own words for an action CC declined, extended with the one case F9
// never sees: a decision that would not have moved the tab at all. Recording those too is
// what makes "was this rule even needed?" answerable — without them the record only
// proves CC saw the host.
function wouldHaveLabel(decision: Decision): string {
  return decision.kind === "reopen" || decision.kind === "choice"
    ? targetLabel(decision as Declinable)
    : "no action";
}

function isRecording(v: unknown): v is Recording {
  const r = v as Recording;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.id === "string" &&
    typeof r.cookieStoreId === "string" &&
    typeof r.container === "string" &&
    typeof r.startedAt === "number" &&
    (r.endedAt === null || typeof r.endedAt === "number") &&
    Array.isArray(r.hosts)
  );
}

// Suspends routing inside chosen containers and records what routing would have done, so
// the hosts in an unconfigured payment or SSO chain can be read off afterwards and turned
// into rules by hand. A sibling of the engine, disposer, cookie-seeder, script-injector,
// redirector-closer and picker — wired at wiring.ts, not nested.
//
// The whole feature hangs off one property: `isPaused` is called from the blocking
// webRequest handler. That is why the armed set lives in memory and is hydrated once at
// startup rather than read on demand, and why nothing here can be made async "just to be
// safe" without putting a storage round-trip in front of every navigation.
export function createPause(opts: { port: BrowserPort; clock: Clock }): Pause {
  const { port, clock } = opts;

  const armed = new Set<string>();
  let recordings: Recording[] = [];

  function snapshot(): PauseState {
    return { armed: [...armed], recordings };
  }

  async function persist(): Promise<void> {
    await port.writeStored(PAUSE_STORAGE_KEY, snapshot());
    await port.setBadge(armed.size === 0 ? "" : String(armed.size));
  }

  function running(cookieStoreId: string): Recording | undefined {
    return recordings.find((r) => r.cookieStoreId === cookieStoreId && r.endedAt === null);
  }

  async function arm(cookieStoreId: string): Promise<ArmResult> {
    // Refused as a SCOPE decision, not a technical limit: pausing the default container
    // is close enough to pausing globally that it should be its own deliberate feature
    // if it is ever wanted.
    if (cookieStoreId === DEFAULT_STORE_ID) {
      return { ok: false, reason: "The default container cannot be paused." };
    }
    const identity = await port.getIdentity(cookieStoreId);
    if (!identity) return { ok: false, reason: "That container no longer exists." };
    if (armed.has(cookieStoreId)) return { ok: true, container: identity.name };

    const now = clock.now();
    armed.add(cookieStoreId);
    recordings = [
      { id: String(now), cookieStoreId, container: identity.name, startedAt: now, endedAt: null, hosts: [] },
      ...recordings,
    ].slice(0, MAX_RECORDINGS);
    await persist();
    return { ok: true, container: identity.name };
  }

  async function disarm(cookieStoreId: string): Promise<ArmResult> {
    const open = running(cookieStoreId);
    // The name comes off the recording, not getIdentity: disarming a throwaway the
    // disposer has just removed must still be able to say which container it was.
    const container = open?.container ?? "that container";
    if (!armed.delete(cookieStoreId)) return { ok: false, reason: "It was not paused." };
    if (open) open.endedAt = clock.now();
    await persist();
    return { ok: true, container };
  }

  return {
    isPaused: (cookieStoreId) => armed.has(cookieStoreId),

    record(cookieStoreId, url, decision) {
      const open = running(cookieStoreId);
      if (!open) return;
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        return; // nothing nameable; the engine has already filtered to http(s) anyway
      }

      const seen = open.hosts.find((h) => h.host === host);
      if (seen) {
        seen.hits++;
        // Deliberately no write: a seven-hop bounce would otherwise be seven storage
        // writes issued from the blocking path. `disarm` flushes, so a FINISHED
        // recording's counts are accurate; a background killed mid-flow loses the hops
        // since the last new host, which is the same class of loss as an unflushed row.
        return;
      }
      open.hosts.push({ host, hits: 1, wouldHave: wouldHaveLabel(decision) });
      void persist().catch((e) => console.warn("[pause] write failed", e));
    },

    arm,
    disarm,

    async hydrate() {
      const raw = await port.readStored(PAUSE_STORAGE_KEY);
      // Anything that is not the shape we wrote is treated as absent rather than
      // trusted: a corrupt value must not be able to leave a container unrouted.
      const state = raw as Partial<PauseState> | null;
      if (typeof state !== "object" || state === null) return;
      if (Array.isArray(state.armed)) {
        for (const id of state.armed) if (typeof id === "string") armed.add(id);
      }
      if (Array.isArray(state.recordings)) recordings = state.recordings.filter(isRecording);
      await port.setBadge(armed.size === 0 ? "" : String(armed.size));
    },

    snapshot,
  };
}
