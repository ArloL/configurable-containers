// The protocol between the background `pause` module and the options page. Pure — no
// browser, no DOM — like picker-protocol.ts.
//
// It imports NOTHING from `src/engine/`, and that is the point of the module rather than an
// accident of what it happens to need. This boundary crosses two realms (a background
// context and a page, in two esbuild bundles, talking by message) and it used to be crossed
// by one declaration: `Recording` was at once the in-memory model the blocking handler
// mutates, the storage.local schema, the wire type and the page's render model. Four roles,
// one type, so the persisted shape and the rendered shape were required to change together —
// and a mistake made in a type the options page reads was paid inside `onBeforeRequest`,
// where a throw is a navigation that never completes.
//
// The three shapes are now separate and this module owns the far side: `RecordingView` is
// what the page renders and nothing else, and the background maps its own model into it.
// `engine/pause.ts` keeps `StoredRecording` (what a possibly-older build left on disk) and
// `Recording` (in memory, every field present). See that module's normalizers.
//
// Unlike the choice page, this protocol DOES name a container, because the sender is the
// options tab, not the tab under discussion, so there is nothing to derive it from. The
// background therefore VALIDATES the cookieStoreId — a real identity, never the default
// container — instead of trusting it.

// storage.local key holding the armed set and the recordings.
//
// It is declared HERE rather than in the module that writes it because both sides name it:
// the background is the only reader and writer of the VALUE, and the options page subscribes
// to `storage.onChanged` for this key as a signal to refetch through a message. A key two
// realms agree on is protocol, not a private detail one of them borrows — and borrowed, a
// rename broke the page's live refresh in silence, since a subscription that stops matching
// simply stops firing.
export const PAUSE_STORAGE_KEY = "pauseState";

export interface PauseStatusMessage {
  type: "cc-pause-status";
}

export interface PauseToggleMessage {
  type: "cc-pause-toggle";
  cookieStoreId: string;
}

export interface PauseClearMessage {
  type: "cc-pause-clear";
}

export interface ContainerRow {
  cookieStoreId: string;
  name: string;
  tabCount: number;
  // The hosts of that container's open tabs. Not decoration: "tmp3 / tmp8 / tmp12" says
  // nothing about which one holds the checkout the user is trying to protect.
  hosts: string[];
  armed: boolean;
  armable: boolean;
  reason?: string | undefined; // why not, when armable is false
}

// ---- What the page renders ------------------------------------------------------
//
// Every field is REQUIRED. That is the whole difference between these and the stored
// shapes, and it is what the background's normalizers buy: a recording written by a build
// that had never heard of URL rows arrives here with `urls: []` and `dropped: 0` filled in,
// so the page never asks "did this key exist yet?" about a row it is rendering. A field
// that may be absent belongs in `StoredRecording`, on the other side of the normalizer, and
// adding one here is a compile error until it is mapped.

export interface RecordedUrlView {
  // The match pattern for this navigation — `*://github.com/login/oauth/authorize*` — which
  // is also the text the row copies. `patternForUrl` drops the query, so no token is
  // written down.
  pattern: string;
  hits: number;
  // Distinct methods, first-seen order. A top-level navigation is a GET unless a form
  // posted it, and a POST is the hop no rule can move at all: `tabs.create` issues a GET,
  // so a `reopen` for a request with a body is declined (F9) however right the rule is.
  // Reading POST off the row is what says the rule there has to be `inherit`/`ignore`.
  methods: string[];
  wouldHave: string; // the declined action AT THIS URL, in the F9 toast's words
}

export interface RecordedHostView {
  host: string;
  hits: number; // main_frame hops that resolved to this host
  wouldHave: string; // the declined action, in the F9 toast's words, or VARIED
  urls: RecordedUrlView[]; // first-seen order
  // Distinct URLs seen at this host after its cap was reached. Rendered, not hidden: rules
  // are written from these rows, so a reader has to know when they are not the whole of
  // what CC saw at that host.
  dropped: number;
}

export interface RecordingView {
  id: string;
  // The container's display name AT ARM TIME. Usually a throwaway, which the disposer
  // deletes minutes after the flow ends, so by the time the user reads the recording the
  // container is gone — and a recording that cannot name its container is hard to read.
  container: string;
  startedAt: number;
  endedAt: number | null; // null while running
  hosts: RecordedHostView[]; // first-seen order
  dropped: number; // distinct hosts seen after the per-recording cap
}

export interface PauseStatusResponse {
  containers: ContainerRow[];
  recordings: RecordingView[];
}

export interface PauseToggleResponse {
  ok: boolean;
  message: string;
}
