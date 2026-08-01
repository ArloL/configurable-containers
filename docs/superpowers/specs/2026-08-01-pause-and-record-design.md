# Pause & Record — Design

**Date:** 2026-08-01
**Status:** Implemented
**Topic:** Arm a container so CC stops routing inside it, and record — deduped by host,
in first-seen order — every top-level navigation it saw and what it *would* have done.
The record is read afterwards and turned into config **by hand**; CC never proposes a
rule.

## 1. Goal & scope

CC's routing fails at the worst possible moment. A checkout hands off to a payment
provider, an SSO chain bounces through hosts nobody has configured, CC reopens the tab
into a fresh throwaway, and the session dies mid-transaction. The rule that would have
prevented it (`inherit: true` on the provider) can only be written once you know the
provider's hostname — and the way you learn it today is to break the flow, or to set
`network.http.redirection-limit` to 0 in `about:config` and read the chain off the error
page one hop at a time.

This slice replaces that workaround. Before entering a flow you don't trust — a shop
you've never bought from, a Microsoft login that bounces — you **arm** the container
you're in. CC stands down there: nothing is reopened, no choice screen appears. The flow
completes. Meanwhile CC records each host it saw and, for each, the routing action it
declined to take. Afterwards you open the record beside the config editor and write the
rules yourself.

The expected trajectory is that the feature is used less over time: each recording
produces a few rules, and the set of unconfigured payment and identity providers a
single user meets is finite.

### In scope

- A new **`pause`** module (`src/engine/pause.ts`), a sibling of the engine, disposer,
  cookie-seeder, script-injector and redirector-closer. It owns the armed set, the
  recordings, their persistence, and the badge.
- **One engine hook**: after `resolve()`, before the F9 non-GET check — if the tab's
  container is armed, hand the decision to the recorder and return without acting.
- An **options-page section**, beside the config editor: the containers that currently
  have tabs (each armable), and the last 10 recordings with click-to-copy per host and a
  clear button.
- A **`browser_action` with no popup**: the badge is the armed indicator, and clicking
  the button toggles the pause on the active tab's container.
- **`BrowserPort` additions**: `setBadge(text)` and `onActionClicked(handler)`, the
  latter delivering the `Tab` Firefox passes to `browserAction.onClicked`. `notify` is
  reused as-is. `mock-port` gains a `clicksAction(tab)` arranger and one handler slot
  for the new event, matching `receivesCommand`.
- A **message router** in `wiring.ts` that owns the single `port.onMessage`
  registration (see §6 — this is a prerequisite, not a nicety).
- Tests down the pyramid: pure recorder logic at L1/L2, engine bypass and recording at
  L3, restart survival in the L3 restart harness.

### Out of scope (deliberate, with reasons)

- **Any automatic rule proposal.** No "add `inherit: true` for you", no generated YAML
  snippet, not even a suggested action. Choosing between `inherit`, `ignore` and
  `open:` is a judgement about what a domain *is* to the user; CC does not have the
  information to make it, and a wrong guess applied silently is the failure mode the
  whole extension exists to avoid. The record copies a **host** and stops there.
- **Always-on recording.** Rejected in favour of arm-before-a-flow (§9), because a
  permanent record of visited hosts is a liability that buys a partial answer.
- **Paths, queries, and full URLs in the record.** Hosts only — see §4.2. Revisit when
  the config supports path/regex matching *and* those are in routine use; the record's
  granularity should follow what a rule is actually written at.
- **A timer.** The pause has no expiry — see §3.3.
- **Pausing the default container.** Refused at the arming step, §5.1.
- **Exemption from MAC.** A paused container is not exempt from Multi-Account
  Containers. See §7.1.
- **A toolbar popup.** Dropped in favour of the options page — see §9.

## 2. Architecture & model

The `pause` module is a sibling, not a layer. The engine consults it through a **narrow,
synchronous** interface and is otherwise unchanged:

```ts
export interface PauseRecorder {
  // Is this container armed? Called inside the blocking onBeforeRequest handler, so
  // it MUST be synchronous and MUST NOT touch storage — see §4.3.
  isPaused(cookieStoreId: string): boolean;
  // Record one main_frame navigation and the decision CC declined to act on.
  // Fire-and-forget: never awaited by the engine.
  record(cookieStoreId: string, url: string, decision: Decision): void;
}
```

Two properties of that interface carry the design:

- **Synchronous `isPaused`.** The check sits in a blocking `webRequest` listener that
  every top-level navigation waits on. An `async` check would put a storage read (or
  even a microtask) into the latency of every navigation in the browser, armed or not.
  The armed set therefore lives in memory and is hydrated at startup (§4.3).
- **`record` returns `void`, not a promise.** The engine floats it, exactly as it
  already floats `announceDeclined`. A navigation must not wait on bookkeeping, and a
  failed write must not break routing.

Everything else the module does — arming, disarming, persistence, last-tab-close, the
badge — happens outside the blocking path, on its own `tabs.onRemoved` listener and in
response to messages from the options page.

### 2.1 Why the engine, and not another sibling

The redirector-closer precedent says lifecycle side-effects belong outside the engine.
The pause does not qualify: it changes what the engine *does with a decision*, which is
the engine's own contract (it already owns the `reopenedNav` guard, the non-GET
declination, the MAC handshake and the `handled` dedupe — the pause is the fifth member
of that family). Putting it anywhere else would mean a second module that can cancel a
navigation, which is precisely the split `supersede.ts` exists to prevent.

## 3. The engine hook

### 3.1 Placement

Inside `port.onBeforeRequest`, the new step sits **after (3) `resolve()` and before (3b)
the non-GET check**:

```
(0)  scope: main_frame + http(s)
(1)  handled guard
(1b) reopenedNav guard
(2)  getTab + buildNavContext
(3)  resolve()            ← pure decision
(3a) PAUSE  ← new: if isPaused(tab.cookieStoreId) → record(…); return
(3b) F9 non-GET declination
(4)  effects
```

Each boundary is required by something specific, and moving the step breaks it:

- **After `resolve()`**, because the record's whole value is the *counterfactual* — "this
  host would have been reopened into a new temporary container" is what tells the user
  the rule was needed, and "no action" is what tells them it was not. `resolve` is pure
  and cheap, so computing a decision we then decline to act on costs nothing.
- **Before (3b)**, so a paused POST does not raise the F9 notification. While paused the
  form submission is staying put *by request*, not by declination; a toast there would
  be noise on exactly the flow the user armed the pause for.
- **After (1b)**, so the `reopenedNav` guard still runs. Arming mid-flow, one hop after
  CC reopened a tab, must not orphan that guard's state.

The step returns with **no `cancel`** and adds nothing to `handled`. Like the F9 path it
is fail-open by construction: it accumulates no state that a later navigation could
inherit.

### 3.2 What "paused" does and does not suspend

Suspended: `reopen`, `choice`, and the F9 notification (by placement). That is the whole
list of things the engine does with a decision.

Untouched, and deliberately so:

- **Overlays** (`cookies`, `scripts`) — they act *within* whatever container the tab is
  in and never move identity across one. A paused checkout should still get its consent
  banner pre-dismissed.
- **Auto-temp** — it containerises a tab that is on `about:newtab`, which by definition
  is not part of a flow in progress. A new tab from an armed container is pre-commit
  `about:blank`, which auto-temp ignores by design, so there is no interaction to model.
- **The disposer** — a paused throwaway is still disposed when it goes empty. Since the
  pause itself ends when the container's last tab closes (§3.3), the disposer's grace
  and the pause's lifetime end together for the throwaway case.
- **The redirector-closer** — a `redirector` rule's auto-close is a tab-lifecycle
  effect, not a routing one, and closing a stranded shim tab is desirable during a
  recording too.

### 3.3 Lifetime: no timer

The pause ends on **manual disarm**, or when the armed container's **last tab closes**.
There is no expiry.

A timer was considered and rejected: an auto-expiry that fires mid-checkout reproduces
exactly the failure the feature exists to prevent, and does it unpredictably. The
last-tab-close rule gives the right lifetime for free in the common case — for a
throwaway container it is the container's entire life — and the badge (§5.2) covers the
case where a tab in a permanent container is left open for days.

Last-tab-close is implemented on `tabs.onRemoved` + `queryTabs({ cookieStoreId })`, the
same shape the disposer already uses. `mock-port` fires `onTabRemoved` from `removeTab`,
so a tab CC itself closes is visible here too.

## 4. State, storage, and the record

### 4.1 Shape

One `storage.local` key (`readStored`/`writeStored` on `BrowserPort`), owned entirely by
the pause module:

```ts
interface PauseState {
  armed: string[];           // cookieStoreIds currently armed
  recordings: Recording[];   // newest first, capped at 10
}

interface Recording {
  id: string;                // start timestamp; identifies the recording
  cookieStoreId: string;
  container: string;         // display name AT ARM TIME — see below
  startedAt: number;
  endedAt: number | null;    // null while running
  hosts: RecordedHost[];     // first-seen order
}

interface RecordedHost {
  host: string;
  hits: number;              // how many main_frame hops resolved to this host
  wouldHave: string;         // prose label, see §4.2
}
```

`container` stores the **display name at arm time**, not just the id. The dominant case
is a throwaway, which the disposer deletes within minutes of the flow ending — so by the
time the user reads the recording, `getIdentity(cookieStoreId)` returns `null`. A
recording that cannot say which container it came from is much harder to interpret.

The cap is 10, newest first. Hosts-only means the storage cost is trivial; the cap exists
so the list stays readable.

### 4.2 What a row says, and why hosts only

`hits` is what collapses a bounce: a Microsoft login that goes through
`login.microsoftonline.com` seven times is one row with `hits: 7`, not seven rows. That
collapse is the substantive improvement over the `redirection-limit=0` workaround, which
produces the raw chain and leaves the deduplication to the reader.

`wouldHave` is the prose already produced by `targetLabel()` in `engine.ts`, which is
today private to the F9 notification. **Export it and share it** — the toast and the
record then describe a declined action in identical words, and cannot drift. Decisions
map as:

| `Decision` | `wouldHave` |
|---|---|
| `reopen` into `temporary` | `a new temporary container` |
| `reopen` into `permanent` | the container name |
| `reopen` into `default` | `the default container` |
| `choice` | `one of: A, B` |
| `stay` / `leaveAlone` | `no action` |

Every hop is recorded, not only the ones that would have moved the tab. The question the
user asks after a recording is "was this even needed?", and that is only answerable if
the untouched hosts are visible too — the ones marked with a real target are then the
ones that stand out.

**Hosts only; no path, no query.** A payment URL's query string is where session tokens
live, and this record is written to disk during a checkout. The host is also already the
granularity a rule is written at (`match:` is host-shorthand in the common case), so the
trim costs nothing today. Accepted cost, stated so a future reader knows it was chosen:
a path-based rule cannot be written from a recording. Revisit alongside path/regex
matching becoming routine.

### 4.3 Persistence and the restart problem

Reviewing a recording means editing the config, and a config save calls
`runtime.reload()` — so a recording held only in memory would be destroyed by the exact
action it exists to enable. Both halves of the state are therefore written through:

- **Writes are floated and deduped.** A write happens only when a *new host* is added to
  the running recording (or on arm/disarm), so a 7-hop bounce through one host writes
  once. `record()` never awaits, so no navigation waits on a write.
- **Reads happen once, at startup.** The armed set and the running recording's host set
  are hydrated behind the existing `configReady` gate in `wiring.ts` — extended to also
  await hydration. Reading storage inside the blocking handler is not an option; that is
  every navigation's latency.
- **In-memory dedupe is rebuilt from the stored recording** at hydration, so a restart
  mid-flow does not produce duplicate rows for hosts already seen.

The gate extension is the one change to `wiring.ts`'s startup contract, and it preserves
the invariant that matters: **every `browser.*` listener still registers synchronously**
as `background.ts` evaluates. Only the blocking handler's *body* waits.

Losing an unflushed row costs one host in one recording, and the user can re-run the
flow. That is the correct side to fail on.

## 5. UI surfaces

There are **two ways to arm a container and one implementation of arming**: the toolbar
button (§5.3), which is how it is done in practice, and the options-page list (§5.1),
which is how it is *tested*. Both call the same `arm(cookieStoreId)` on the pause
module; neither has logic the other lacks. There is no popup — see §9.

### 5.1 Arming, on the options page

The options page opens in a tab of its own, in its own container, so it cannot ask
"which container am I in". It therefore **lists** containers and the user picks one.

This path exists for two reasons: it is the only one an e2e can drive (§8.3), and it is
the only way to arm a container whose tab is not the active one.

The list is *the containers that currently have tabs*, each annotated with its tab count
and the hosts of those tabs — `tmp12 · 1 tab · shop.example.com`. The annotation is not
decoration: throwaway names (`tmp3`, `tmp8`, `tmp12`) carry no clue which one holds the
checkout you are trying to protect, and a list of bare names would be unusable at the
one moment the feature is reached for. `queryTabs` supplies it for free. Containers with
no tabs are omitted — you cannot arm a flow you are not in.

`firefox-default` is listed but **not armable**, with the reason shown inline rather
than the row simply not responding. "I clicked it and nothing happened" is the worst
outcome for a control reached for under time pressure. The refusal is a scope decision,
not a technical limit: pausing the default container is close enough to pausing globally
that it should be a separate, deliberate feature if it is ever wanted.

**This is the one message in CC that names a container instead of deriving it from the
sender.** The choice page's rule — take the tab from the sender, never from the payload
(`picker-protocol.ts`) — cannot apply, because the sender here is the options tab and
that is not the tab under discussion. So the background **validates the payload
instead**: the `cookieStoreId` must resolve through `getIdentity()` and must not be
`firefox-default`. A crafted `moz-extension://<id>/options.html` link is
attacker-reachable, and while it can only ever open the page (not act on it), the
validation means the message cannot arm something that is not a real container.

### 5.2 Recordings, on the options page

Below the arming list: the last 10 recordings, newest first, each showing container,
time, and its host rows with `hits` and `wouldHave`. Per-host click-to-copy, and a
clear-all button.

Placement is the point — reviewing a recording *is* writing config, and the config
editor is on this page.

The section subscribes to `browser.storage.onChanged` and re-renders, so a recording
grows **live** while you watch it: leave the options page open in a second window and you
can watch hosts appear as the checkout progresses. That gives back most of what the popup
was for.

**As built, the subscription is only a signal.** The data still arrives through
`cc-pause-status`, so the background remains the sole reader of its own storage shape and
the page holds no second copy of it. (An earlier draft of this section had `options.ts`
read `storage.local` directly, by analogy with `config.ts`. That analogy does not hold:
the config has one writer *and* one reader, whereas the pause state is written by the
background while the page renders it, so a shared shape would be two things to keep in
step for no gain.) The storage key is exported from `pause.ts`; the message and row types
live in `pause-protocol.ts`.

### 5.3 The toolbar button

`browser_action` stays in the manifest with **no `default_popup`**: `setBadgeText`
requires the manifest key anyway, and without a popup the button fires
`browserAction.onClicked` instead. Clicking it toggles the pause on the active tab's
container. No HTML entry point, no message protocol.

**Firefox hands `onClicked` the active `tab` as its first argument**, so the background
reads `tab.cookieStoreId` straight off it. That is a better provenance than the popup
would have had: no page is involved, so there is no payload to validate and nothing
craftable to reach it. This is why the button is the ergonomic path and the options
list is the fallback, rather than the other way round — the button is the version that
knows which container you mean.

A click is one action, so the button **cannot also open the options page**. Reaching the
recordings goes through the ordinary add-on route (about:addons → Preferences), plus
CC's existing startup `openOptionsPage()`.

With no popup there is nowhere inline to answer a click, so the button path speaks
through `port.notify` — the channel F9 already uses:

- **On arm and on disarm**, naming the container: *"Routing paused in tmp12 — CC will
  record hosts and move nothing."* The success toast is the only thing that says
  **which** container was armed; the badge merely becomes `1`, and `tmp12` is not
  something the user can otherwise confirm they hit.
- **On refusal** (the active tab is in `firefox-default`, or on a non-http page), saying
  why. A silent no-op is the worst outcome for a control reached for under time
  pressure.

This is a handful of notifications a week — one per deliberate user action — not F9's
per-host volume, and unlike F9 there is no dedupe to design because the user initiated
each one.

### 5.4 The badge

`setBadge(text)` on `BrowserPort`; the real adapter also sets a warning background
colour once at startup. Text is the number of armed containers, empty when none.

The badge is **global, not per-tab**. Per-tab would be the better UX — the badge would
light up only on tabs actually inside an armed container — but it needs `tabs.onActivated`
and `tabs.onUpdated` bookkeeping that can silently fall out of sync. An armed pause with
no visible sign is a silent isolation hole; a badge that is occasionally shown on an
unrelated tab errs toward *more* visible, which is the right direction for this
particular error.

Like the button, the badge has no L4 coverage — nothing in the harness can read chrome
UI (§8.3). Accepted knowingly: it displays state that L3 already asserts, so what goes
untested is the rendering, not the fact.

## 6. Message routing (prerequisite)

`createPicker` today calls `port.onMessage` itself and returns `undefined` for anything
that is not `cc-pick`. A second sibling registering a second `onMessage` handler breaks
in two ways:

- **In tests**, `mock-port` holds exactly **one** handler slot per event
  (`messageHandler = h`), so the second registration silently clobbers the first and the
  picker's L3 coverage evaporates without a failure.
- **In Firefox**, the picker's handler is `async`, so it returns a Promise for *every*
  message including ones not its own. A listener that returns a promise is telling
  Firefox it will answer, so it can swallow the reply to a message meant for another
  listener.

So: **`wiring.ts` owns the single `port.onMessage` registration** and dispatches on
`msg.type`. `createPicker` exposes `handleMessage(msg, sender)` instead of registering;
`pause` exposes the same. The router returns `undefined` synchronously for an unknown
type, which is the only shape that leaves the reply channel free.

This is a prerequisite for the slice, not incidental cleanup — the options page cannot
reach the background without it.

**Why messages at all, when the options page can write `storage.local` directly?**
Because arming by storage write would make the options page a *second writer* of the
pause state, racing the background's own writes (a new host row landing while the user
toggles a container: whoever writes last clobbers the other). Keeping the background as
the single writer is the same instinct that governs `storage.sync`, and it puts the
validation of §5.1 somewhere the page cannot bypass. The options page reads storage
directly and writes nothing.

## 7. Failure modes and what this does not fix

### 7.1 MAC still routes

A paused container is not exempt from Multi-Account Containers. If MAC holds an
assignment for a host in the chain, MAC reopens the tab — CC standing down does not stop
another extension. The recording will show the hop, the tab moves anyway, and the
session may still break.

This is correct behaviour, not a defect: CC's F7 handshake exists precisely to let MAC
own what MAC owns. It does mean a MAC-assigned host is the one case where an armed pause
does not deliver an unbroken session, and the user's remedy is MAC's own settings.

### 7.2 A recording is not a diagnosis of the broken run

The pause must be armed **before** the flow. The first breakage still costs a
transaction; the recording describes the *retry*. This is inherent to the arm-before
model chosen in §9 and is the accepted cost.

Note that a paused run's chain is also *different* from a broken run's chain — the hops
after the point where a broken run bails out only exist because the session survived.
That is the reason the paused run is the useful artefact, not merely a more complete one.

### 7.3 An armed container is unrouted

While armed, a container gets no isolation at all — a link from it to any site stays
inside it. That is the feature. The badge is the mitigation, and last-tab-close is what
keeps a forgotten pause from outliving the flow in the common (throwaway) case.

## 8. Testing

### 8.1 Pure / L2

The recorder's own logic with no port: first-seen ordering, `hits` accumulation, host
dedupe, the 10-recording cap, decision → `wouldHave` mapping (shared with the F9 label),
and hydration rebuilding the dedupe set from a stored recording.

### 8.2 L3 (mock port)

- An armed container's navigation is **not** reopened, **not** cancelled, and appears in
  the recording with the target it would have gone to.
- The same navigation in an unarmed container is unchanged — this is the revert-verify
  anchor: back the pause step out and the first test goes red while this one stays green.
- A paused non-GET raises **no** F9 notification (pins the step at 3a, ahead of 3b).
- `reopenedNav` state survives arming mid-flow (pins the placement after 1b).
- Overlays still fire in an armed container.
- Last tab closing disarms and stamps `endedAt`.
- A toolbar click on a tab in container X arms X — and a second click disarms it. Driven
  through `clicksAction(tab)`, so the `onClicked` handler is exercised even though L4
  cannot reach it.
- A toolbar click on a `firefox-default` tab arms nothing and raises a refusal
  notification; arming and disarming each raise one naming the container.
- The badge text tracks the number of armed containers, and is empty at zero.
- **Restart harness**: armed set and running recording survive; the rebuilt dedupe set
  does not re-add a host already recorded. Restart from a settled state — the harness
  does not model async work in flight.

### 8.3 L4 (real Firefox)

Putting arming on the options page is what makes an end-to-end case possible, and it is
the reason the popup was dropped (§9). CC already calls `openOptionsPage()` at startup,
so the page is open and `test/e2e/options.test.ts` already drives it — the driver can
*operate* an extension page something else opened, which is exactly this arrangement.

One case, following the whole loop:

1. The probe opens a tab and navigates it to an unmatched host; CC routes it into a
   throwaway. The probe reports the tab's `CSID` and container name.
2. The driver switches to the options tab and arms that container by name.
3. The probe navigates the same tab **cross-site** to a second unmatched host — a
   navigation that would normally buy a fresh throwaway.
4. Assert the tab's `CSID` is **unchanged**: the pause held.
5. Assert the options page shows a recording row for the second host reading *a new
   temporary container* — the counterfactual, live via `storage.onChanged`, no reload.

Step 4 is the revert-verify anchor: back the §3.1 engine step out and the `CSID` changes.
Step 5 fails independently if the recording never reaches storage.

Three harness rules this case has to respect. The probe provisions its own container and
tab, so the container list carries one extra row. Step 3's *non*-reopen has nothing to
wait for, so `awaitContainerTab` covers step 1's reopen but step 4 needs
`awaitProbeReport`. And — found by hitting it — **the tab id must be read before parking
on the options page**: the probe's command relay is a DOM event injected into http(s)
pages only, so from `moz-extension://` `listTabs` and `nav` go unanswered and read as a
timeout, not an error.

What stays untested at L4, all of it chrome UI the harness cannot reach:

- **The toolbar button** (§5.3). WebDriver cannot click a `browser_action` any more than
  it can open a popup — which is exactly why the options list exists and the e2e drives
  *it*. What goes uncovered shrinks to one line, `tab.cookieStoreId` off the `onClicked`
  argument, because both paths call the same `arm()`. Keep it that way: any logic that
  lives only in the `onClicked` handler is logic with no coverage at all.
- **The badge** (§5.4) and the button's notifications — display of state that L3 already
  asserts.
- **Last-tab-close disarm** — closing the probe's tab tears down the observation surface
  the assertion needs. Covered at L3.

**Do not add a build-time seed to arm a container**, whatever pressure a later case
applies. `__CC_NOTIFY_ECHO_TO__` already shows the cost — `launch()` sets it
unconditionally, so no test build is byte-equivalent to a packaged one — and a
test-only path that arms by name would be worse: it would make the shipped extension
capable of starting up with routing disabled.

## 9. Decisions taken, with the alternatives rejected

- **Arm-before-a-flow, not an always-on journal.** A rolling record of every navigation
  would diagnose the *first* breakage instead of only the retry, but it keeps a
  permanent record of visited hosts on disk for a partial answer: a broken run's chain
  stops where the flow bailed out, and the hosts that matter most (the ones after the
  provider hands back) never occur. The manifest also declares
  `data_collection_permissions: { required: ["none"] }`, and while a local-only record
  is not collection, a continuous one sits far closer to that line than a user-armed
  one. **The record must never reach `storage.sync`** — that namespace is the config
  mirror and the background is its only writer.
- **Scoped to the container, not the tab or globally.** Tab scope loses the chain at a
  `target=_blank` or 3DS popup — exactly where it is needed, since the new tab inherits
  its opener's `cookieStoreId`. Container scope follows the flow through a popup for
  free. It is also the honest privacy unit: the container is already the boundary that
  says "these pages may see each other's cookies", so exempting one from routing widens
  nothing that is not already shared. Global scope silently unroutes every unrelated tab.
- **A badge-only `browser_action`, not a keyboard command or context menu.** Only the
  toolbar button can carry a persistent indicator, and the indicator is what makes the
  feature safe to leave in the product.
- **Two arming paths over one `arm()`, and no popup.** A popup cannot be driven by
  WebDriver, so making it the only route would have left the whole arm → record → review
  loop with no L4 coverage — unacceptable in a feature whose failure mode is *routing
  silently disabled*. But the popup's appeal was never the panel; it was that a toolbar
  interaction knows which container you are in. `browserAction.onClicked` supplies that
  directly (Firefox passes the active `tab`) **without** a popup, so the ergonomics
  survive while the HTML entry point and its message protocol do not.
  The options-page list then exists to be *driven by a test*, and secondarily to arm a
  container whose tab is not focused. Because both routes call the same `arm()`, the
  untestable surface is one argument access rather than a feature. Cost of the split:
  two entry points to keep honest, and a reviewer must resist putting logic behind the
  button (§8.3).

## 10. Open questions

- **Naming in the UI.** "Pause routing in this container" is the working label. "Pause"
  is accurate and "record" is the payoff; a single word covering both has not been found.
- **Per-tab badge.** Deferred (§5.2). Revisit only if the global badge proves confusing
  in daily use.
- **Recording without pausing.** CC's `onBeforeRequest` sees every `main_frame` hop
  including redirects, whether or not it acts — so a record-only mode is mechanically
  free. It is not offered because a record of a run that CC broke is the misleading
  artefact described in §7.2. If daily use shows the broken run's chain is usually
  enough, this becomes the cheaper default.
