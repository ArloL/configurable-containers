import { targetLabel } from "./engine";
import type { Decision } from "../resolver/types";
import type { ContainerRow, PauseStatusResponse, PauseToggleMessage, PauseToggleResponse } from "../extension/pause-protocol";
import type { BrowserPort, Clock } from "./port";

// storage.local key holding the armed set and the recordings. The background is its ONLY
// writer; the options page reads through a message instead, since a host row landing
// mid-render would race a toggle and lose one of the two writes.
export const PAUSE_STORAGE_KEY = "pauseState";

// A cap on how many recordings are kept, so the list stays readable.
export const MAX_RECORDINGS = 10;

// A cap on how many distinct hosts ONE recording names, and the only bound in this file
// that is about memory rather than readability.
//
// Everything else CC keeps dies with the browser. This does not: `record()` appends a row
// per distinct host seen while a container is armed and `persist()`s the whole pause state
// on each new one, into storage.local. A container armed and forgotten therefore grows a
// stored array for as long as browsing continues — the one structure here that a restart
// does not empty.
//
// 200 is two orders of magnitude above a real payment or SSO chain, which is a handful of
// hops. Reaching it means the recording stopped being the flow the user armed for, and that
// flow is at the TOP of a first-seen-ordered list, so the rows worth reading are the ones
// kept. Past the cap the recording also stops writing at all, which is the other half of
// what it costs to leave one running.
export const MAX_RECORDED_HOSTS = 200;

export interface RecordedHost {
  host: string;
  hits: number; // main_frame hops that resolved to this host
  wouldHave: string; // the declined action, in the F9 toast's words
}

export interface Recording {
  id: string;
  cookieStoreId: string;
  // The display name AT ARM TIME. Usually a throwaway, which the disposer deletes minutes
  // after the flow ends, so by the time the user reads the recording getIdentity() returns
  // null — and a recording that cannot name its container is hard to read.
  container: string;
  startedAt: number;
  endedAt: number | null; // null while running
  hosts: RecordedHost[]; // first-seen order, at most MAX_RECORDED_HOSTS of them
  // Distinct hosts seen after the cap was reached. Optional because a recording written by
  // a build without the cap has no such field, and refusing those on hydrate would throw
  // the user's history away over a key they never had.
  dropped?: number;
}

export interface PauseState {
  armed: string[];
  recordings: Recording[]; // newest first
}

export type ArmResult = { ok: true; container: string } | { ok: false; reason: string };

export interface Pause {
  // Called inside the blocking onBeforeRequest handler, so synchronous and storage-free:
  // an await here is latency on every navigation in the browser, armed or not.
  isPaused(cookieStoreId: string): boolean;
  // Returns void and is never awaited: a navigation must not wait on bookkeeping, and a
  // failed write must not break routing.
  record(cookieStoreId: string, url: string, decision: Decision): void;
  arm(cookieStoreId: string): Promise<ArmResult>;
  disarm(cookieStoreId: string): Promise<ArmResult>;
  hydrate(): Promise<void>;
  snapshot(): PauseState;
  // Dispatched to by the wiring's single runtime.onMessage registration. Returns undefined
  // SYNCHRONOUSLY for a message that is not ours, leaving the reply channel to its owner.
  handleMessage(msg: unknown): Promise<PauseStatusResponse | PauseToggleResponse> | undefined;
}

const DEFAULT_STORE_ID = "firefox-default";
const NOTIFY_TITLE = "Configurable Containers";

// The F9 toast's own words for a declined action, plus the case F9 never sees: a decision
// that would not have moved the tab. Recording those is what answers "was this rule even
// needed?" — without them the record only proves CC saw the host.
function wouldHaveLabel(decision: Decision): string {
  return decision.kind === "reopen" || decision.kind === "choice"
    ? targetLabel(decision)
    : "no action";
}

function isRecording(v: unknown): v is Recording {
  if (typeof v !== "object" || v === null) return false;
  // `Partial`, not `Recording`: cast to the whole shape and every check below reads as
  // comparing a `string` to "string", which is to say as dead code — the assertion turns
  // off the checking this function exists to do.
  const r = v as Partial<Recording>;
  return (
    typeof r.id === "string" &&
    typeof r.cookieStoreId === "string" &&
    typeof r.container === "string" &&
    typeof r.startedAt === "number" &&
    (r.endedAt === null || typeof r.endedAt === "number") &&
    (r.dropped === undefined || typeof r.dropped === "number") &&
    Array.isArray(r.hosts)
  );
}

// Suspends routing inside chosen containers and records what routing would have done, so
// the hosts of an unconfigured payment or SSO chain can be read off afterwards and turned
// into rules.
//
// One property carries the feature: `isPaused` is called from the blocking webRequest
// handler. Hence an in-memory armed set hydrated once at startup, and hence nothing here can
// be made async "to be safe" without a storage round-trip before every navigation.
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
    // A scope decision, not a technical limit: pausing the default container is close
    // enough to pausing globally that it should be its own feature if ever wanted.
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
    // From the recording, not getIdentity: disarming a throwaway the disposer just removed
    // must still name it.
    const container = open?.container ?? "that container";
    if (!armed.delete(cookieStoreId)) return { ok: false, reason: "It was not paused." };
    if (open) open.endedAt = clock.now();
    await persist();
    return { ok: true, container };
  }

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
        // about:blank, about:newtab and extension pages have no host. The row still counts
        // the tab: the container is occupied either way.
      }
      if (host && !hosts.includes(host)) hosts.push(host);
      hostsByStore.set(tab.cookieStoreId, hosts);
    }

    // Containers with no tabs are omitted: you cannot arm a flow you are not in, and every
    // throwaway that ever existed would bury the one that matters.
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
    // The sender is the options tab, not the tab under discussion, so unlike the choice
    // page there is nothing to derive the container from and the payload is validated
    // instead. arm() does the real checking; this only rejects the wrong type.
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
    // Disarm first: a cleared list must not leave a container unrouted with no recording
    // left to show for it.
    for (const cookieStoreId of [...armed]) await disarm(cookieStoreId);
    recordings = [];
    await persist();
    return { ok: true, message: "Cleared." };
  }

  // The toolbar button. It holds NO logic of its own and must not acquire any: WebDriver
  // cannot click a browser_action, so anything living only here ships uncovered. The
  // options-page route an e2e does drive reaches the same arm()/disarm(), leaving only the
  // argument access below uncovered. Firefox supplies `tab`, so there is no payload to
  // validate and nothing craftable reaches this.
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
  // needed. WHICH tab closed does not matter — the browser is asked — so this survives a
  // restart with no per-tab bookkeeping to rebuild. mock-port fires onTabRemoved for a tab
  // CC itself closed, so a reopen consuming the last tab is seen here too.
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
        return; // nothing nameable — the engine already filtered to http(s)
      }

      const seen = open.hosts.find((h) => h.host === host);
      if (seen) {
        seen.hits++;
        // Deliberately no write: a seven-hop bounce would be seven storage writes from the
        // blocking path. `disarm` flushes, so a finished recording's counts are accurate; a
        // background killed mid-flow loses the hops since the last new host.
        return;
      }
      if (open.hosts.length >= MAX_RECORDED_HOSTS) {
        // Counted, not dropped in silence. A list a reader takes for the whole flow and
        // that quietly is not would be the silent wrong answer this cap exists to avoid —
        // rules written from it would miss the host that actually broke. Not persisted
        // here for the reason above; `disarm` flushes it with the hit counts.
        open.dropped = (open.dropped ?? 0) + 1;
        return;
      }
      open.hosts.push({ host, hits: 1, wouldHave: wouldHaveLabel(decision) });
      void persist().catch((e) => console.warn("[pause] write failed", e));
    },

    arm,
    disarm,

    // Not `async`: "not ours" must be a synchronous undefined, which an async function
    // cannot give.
    handleMessage(msg) {
      const type = (msg as { type?: unknown } | null | undefined)?.type;
      if (type === "cc-pause-status") return status();
      if (type === "cc-pause-toggle") return toggle((msg as PauseToggleMessage).cookieStoreId);
      if (type === "cc-pause-clear") return clearAll();
      return undefined;
    },

    async hydrate() {
      const raw = await port.readStored(PAUSE_STORAGE_KEY);
      // Anything that is not the shape we wrote counts as absent: a corrupt value must not
      // leave a container unrouted.
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
