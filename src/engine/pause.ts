import { targetLabel, type RecordedNav } from "./engine";
import { patternForUrl } from "../matcher/matcher";
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

// The same bound one level down, for the URLs recorded under a host. It is much lower
// because a URL row grows with BROWSING, not with the handful of hops a flow makes: fifty
// pages read at one site is fifty rows, where the host is still one. Twenty is well above
// the few paths a payment or SSO chain touches at any one host, and past it the recording
// stops writing for that host, as it does for the recording as a whole at the cap above.
export const MAX_RECORDED_URLS_PER_HOST = 20;

// What a host row says when its URLs did not all resolve the same way. Before match
// patterns a host had exactly one answer; now `github.com` can be `inherit` under
// `/login/oauth/` and a permanent container everywhere else, and a host row still claiming
// one of the two is the silent wrong answer the URL rows exist to prevent — it sends the
// reader to write the one rule that breaks the sign-in.
export const VARIED = "varies by URL";

export interface RecordedUrl {
  // The match pattern for this navigation — `*://github.com/login/oauth/authorize*` — and
  // also the text the row copies. Stored rather than the raw path because it is what gets
  // pasted into `match:`, and building it here and again in the options page is two things
  // to keep in step. `patternForUrl` drops the query, so no token is written down.
  pattern: string;
  hits: number;
  // Distinct methods, first-seen order. A top-level navigation is a GET unless a form
  // posted it, and a POST is the hop no rule can move at all: `tabs.create` issues a GET,
  // so a `reopen` for a request with a body is declined (F9) however right the rule is.
  // Reading POST off the row is what says the rule there has to be `inherit`/`ignore`.
  methods: string[];
  wouldHave: string; // the declined action AT THIS URL, in the F9 toast's words
}

export interface RecordedHost {
  host: string;
  hits: number; // main_frame hops that resolved to this host
  wouldHave: string; // the declined action, in the F9 toast's words, or VARIED
  urls: RecordedUrl[]; // first-seen order, at most MAX_RECORDED_URLS_PER_HOST of them
  // Distinct URLs seen at this host after its cap was reached — `Recording.dropped` one
  // level down, and counted for the same reason.
  dropped: number;
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
  // failed write must not break routing. The navigation is passed whole rather than as two
  // adjacent strings, which is a swap the compiler cannot catch.
  record(cookieStoreId: string, nav: RecordedNav, decision: Decision): void;
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

// A stored recording, read back into the shape this build expects, or null for anything
// that is not one — the "a corrupt value counts as absent" rule hydrate() applies to the
// whole state, since a recording that cannot be read must not stop the armed set from being.
//
// It NORMALIZES rather than only checking, which the type-guard version it replaced could
// not: a host row written before URL detail existed has no `urls`, and a build that read it
// and trusted the type would call `.find` on undefined — inside the blocking handler, where
// a throw is a navigation that never completes. Filling the missing fields in is the
// upgrade, and it is why `urls` and `dropped` can be required in the type rather than
// optional-and-checked at every use. `Recording.dropped` stays optional there for the
// separate reason below: it is what a pre-cap recording lacks, and it is a plain number.
function readRecording(v: unknown): Recording | null {
  if (typeof v !== "object" || v === null) return null;
  // `Partial`, not `Recording`: cast to the whole shape and every check below reads as
  // comparing a `string` to "string", which is to say as dead code — the assertion turns
  // off the checking this function exists to do.
  const r = v as Partial<Recording>;
  if (
    typeof r.id !== "string" ||
    typeof r.cookieStoreId !== "string" ||
    typeof r.container !== "string" ||
    typeof r.startedAt !== "number" ||
    !(r.endedAt === null || typeof r.endedAt === "number") ||
    !(r.dropped === undefined || typeof r.dropped === "number") ||
    !Array.isArray(r.hosts)
  ) {
    return null;
  }
  const out: Recording = {
    id: r.id,
    cookieStoreId: r.cookieStoreId,
    container: r.container,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    hosts: r.hosts.map(readHost).filter((h): h is RecordedHost => h !== null),
  };
  // Spread in conditionally rather than writing `dropped: undefined`: absent and undefined
  // are different values to `exactOptionalPropertyTypes`, and only one of them round-trips
  // through JSON as the key a pre-cap recording did not have.
  return r.dropped === undefined ? out : { ...out, dropped: r.dropped };
}

function readHost(v: unknown): RecordedHost | null {
  if (typeof v !== "object" || v === null) return null;
  const h = v as Partial<RecordedHost>;
  if (typeof h.host !== "string" || typeof h.hits !== "number" || typeof h.wouldHave !== "string") {
    return null;
  }
  return {
    host: h.host,
    hits: h.hits,
    wouldHave: h.wouldHave,
    urls: (Array.isArray(h.urls) ? h.urls : []).map(readUrl).filter((u): u is RecordedUrl => u !== null),
    dropped: typeof h.dropped === "number" ? h.dropped : 0,
  };
}

function readUrl(v: unknown): RecordedUrl | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Partial<RecordedUrl>;
  if (
    typeof u.pattern !== "string" ||
    typeof u.hits !== "number" ||
    typeof u.wouldHave !== "string" ||
    !Array.isArray(u.methods)
  ) {
    return null;
  }
  return {
    pattern: u.pattern,
    hits: u.hits,
    wouldHave: u.wouldHave,
    methods: u.methods.filter((m): m is string => typeof m === "string"),
  };
}

// One hop's URL row, added or updated in place. True when it changed something a reader
// would notice — a new URL, a method not seen at that URL before, or the cap being reached
// for the first time — which is what earns a storage write from the blocking path.
//
// A URL with no pattern form is skipped rather than stored raw: `patternForUrl` refuses an
// IPv6 literal, and a row whose text cannot be pasted into `match:` is a Copy button that
// lies about what it is for. The host row above it still counts the hop.
function recordUrl(row: RecordedHost, nav: RecordedNav, wouldHave: string): boolean {
  const pattern = patternForUrl(nav.url);
  if (pattern === null) return false;

  const seen = row.urls.find((u) => u.pattern === pattern);
  if (seen) {
    seen.hits++;
    // A top-level navigation is a GET unless a form posted it, so this list is two entries
    // long at worst — and the second is the entry that matters.
    if (seen.methods.includes(nav.method)) return false;
    seen.methods.push(nav.method);
    return true;
  }
  if (row.urls.length >= MAX_RECORDED_URLS_PER_HOST) {
    // Counted, not dropped in silence, exactly as `Recording.dropped` is: a list a reader
    // takes for everything CC saw at this host, while it quietly is not, is what a
    // path-scoped rule then gets written against. Worth one write the first time only.
    row.dropped++;
    return row.dropped === 1;
  }
  row.urls.push({ pattern, hits: 1, methods: [nav.method], wouldHave });
  return true;
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

    record(cookieStoreId, nav, decision) {
      const open = running(cookieStoreId);
      if (!open) return;
      let host: string;
      try {
        host = new URL(nav.url).host;
      } catch {
        return; // nothing nameable — the engine already filtered to http(s)
      }
      const wouldHave = wouldHaveLabel(decision);

      // `newFact` decides whether to write, and a hop that only bumps a counter is not one:
      // a seven-hop bounce would otherwise be seven storage writes from the blocking path.
      // `disarm` flushes, so a finished recording's counts are accurate; a background killed
      // mid-flow loses the hops since the last thing that WAS new.
      let newFact = false;
      let row = open.hosts.find((h) => h.host === host);
      if (!row) {
        if (open.hosts.length >= MAX_RECORDED_HOSTS) {
          // Counted, not dropped in silence. A list a reader takes for the whole flow and
          // that quietly is not would be the silent wrong answer this cap exists to avoid —
          // rules written from it would miss the host that actually broke. Not persisted
          // here for the reason above; `disarm` flushes it with the hit counts.
          open.dropped = (open.dropped ?? 0) + 1;
          return;
        }
        row = { host, hits: 0, wouldHave, urls: [], dropped: 0 };
        open.hosts.push(row);
        newFact = true;
      } else if (row.wouldHave !== wouldHave && row.wouldHave !== VARIED) {
        // Two URLs at this host resolved differently, which is what a path-scoped rule looks
        // like from the outside. The host row stops claiming either answer; the URL rows
        // below it carry both.
        row.wouldHave = VARIED;
        newFact = true;
      }
      row.hits++;
      if (recordUrl(row, nav, wouldHave)) newFact = true;

      if (newFact) void persist().catch((e) => console.warn("[pause] write failed", e));
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
      if (Array.isArray(state.recordings)) {
        recordings = state.recordings.map(readRecording).filter((r): r is Recording => r !== null);
      }
      await port.setBadge(armed.size === 0 ? "" : String(armed.size));
    },

    snapshot,
  };
}
