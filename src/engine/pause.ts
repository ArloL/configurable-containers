import { targetLabel, type Declinable } from "./engine";
import type { Decision } from "../resolver/types";
import type { ContainerRow, PauseStatusResponse, PauseToggleMessage, PauseToggleResponse } from "../extension/pause-protocol";
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
  // Dispatched to by the wiring's single runtime.onMessage registration. Returns
  // undefined SYNCHRONOUSLY for a message that is not ours, so the reply channel stays
  // free for the sibling it was addressed to.
  handleMessage(msg: unknown): Promise<PauseStatusResponse | PauseToggleResponse> | undefined;
}

const DEFAULT_STORE_ID = "firefox-default";
const NOTIFY_TITLE = "Configurable Containers";

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

  // What the options page renders: the containers that currently hold tabs, each with
  // enough about those tabs to be recognisable, plus the recordings.
  async function status(): Promise<PauseStatusResponse> {
    const identities = await port.queryIdentities();
    const tabs = await port.queryTabs({});
    const named = new Map(identities.map((c) => [c.cookieStoreId, c.name]));

    const hostsByStore = new Map<string, string[]>();
    for (const tab of tabs) {
      const hosts = hostsByStore.get(tab.cookieStoreId) ?? [];
      let host = "";
      try {
        host = new URL(tab.url).host;
      } catch {
        // about:blank, about:newtab and the extension's own pages have no host. The row
        // still counts the tab — it is occupied either way.
      }
      if (host && !hosts.includes(host)) hosts.push(host);
      hostsByStore.set(tab.cookieStoreId, hosts);
    }

    // Containers with no tabs are omitted: you cannot arm a flow you are not in, and a
    // list of every throwaway that ever existed would bury the one that matters.
    const containers: ContainerRow[] = [...hostsByStore.keys()]
      .filter((csid) => csid === DEFAULT_STORE_ID || named.has(csid))
      .map((csid) => ({
        cookieStoreId: csid,
        name: named.get(csid) ?? "Default",
        tabCount: tabs.filter((t) => t.cookieStoreId === csid).length,
        hosts: hostsByStore.get(csid) ?? [],
        armed: armed.has(csid),
        armable: csid !== DEFAULT_STORE_ID,
        reason: csid === DEFAULT_STORE_ID ? "The default container cannot be paused." : undefined,
      }));

    return { containers, recordings };
  }

  async function toggle(cookieStoreId: unknown): Promise<PauseToggleResponse> {
    // The sender here is the options tab, which is not the tab under discussion — so
    // unlike the choice page there is nothing to derive the container from, and the
    // payload is validated instead. arm() does the real checking (a real identity, never
    // the default container); this only rejects a value of the wrong type.
    if (typeof cookieStoreId !== "string") return { ok: false, message: "No container named." };
    const wasPaused = armed.has(cookieStoreId);
    const result = wasPaused ? await disarm(cookieStoreId) : await arm(cookieStoreId);
    if (!result.ok) return { ok: false, message: result.reason };
    return {
      ok: true,
      message: wasPaused ? `Resumed in ${result.container}.` : `Paused in ${result.container}.`,
    };
  }

  async function clearAll(): Promise<PauseToggleResponse> {
    // Disarm first: a cleared list must not leave a container silently unrouted with no
    // recording left to show for it.
    for (const cookieStoreId of [...armed]) await disarm(cookieStoreId);
    recordings = [];
    await persist();
    return { ok: true, message: "Cleared." };
  }

  // The toolbar button. It holds NO logic of its own, and must not acquire any: WebDriver
  // cannot click a browser_action, so anything living only here would ship with no
  // end-to-end coverage at all. The options-page route (which an e2e does drive) reaches
  // the same arm()/disarm(), so what goes uncovered is the argument access below.
  //
  // Firefox supplies `tab`, so there is no payload to validate and nothing craftable can
  // reach this — unlike the options page, which names a container and is checked.
  port.onActionClicked((tab) => {
    void (async () => {
      const wasPaused = armed.has(tab.cookieStoreId);
      const result = wasPaused ? await disarm(tab.cookieStoreId) : await arm(tab.cookieStoreId);
      await port.notify({
        title: NOTIFY_TITLE,
        message: !result.ok
          ? result.reason
          : wasPaused
            ? `Routing resumed in ${result.container}.`
            : `Routing paused in ${result.container} — CC will record the sites it sees and move nothing.`,
      });
    })().catch((e) => console.warn("[pause] toolbar click failed", e));
  });

  // A tab closing is the only way a container becomes empty, so it is the only trigger
  // needed. WHICH tab closed does not matter — the browser is asked — and that is what
  // lets this survive a restart with no per-tab bookkeeping to rebuild. mock-port fires
  // onTabRemoved for a tab CC itself closed, so a reopen that consumed the container's
  // last tab is seen here too.
  port.onTabRemoved(() => {
    void (async () => {
      if (armed.size === 0) return;
      const occupied = new Set((await port.queryTabs({})).map((t) => t.cookieStoreId));
      for (const cookieStoreId of [...armed]) {
        if (!occupied.has(cookieStoreId)) await disarm(cookieStoreId);
      }
    })().catch((e) => console.warn("[pause] disarm-on-empty failed", e));
  });

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

    // Not `async`: the "not ours" answer has to be a synchronous undefined, and an async
    // function cannot give one.
    handleMessage(msg) {
      const type = (msg as { type?: unknown } | null | undefined)?.type;
      if (type === "cc-pause-status") return status();
      if (type === "cc-pause-toggle") return toggle((msg as PauseToggleMessage).cookieStoreId);
      if (type === "cc-pause-clear") return clearAll();
      return undefined;
    },

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
