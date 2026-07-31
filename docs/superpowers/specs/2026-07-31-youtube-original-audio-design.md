# Always Play YouTube's Original Audio — Design

**Date:** 2026-07-31
**Status:** Approved, pending implementation plan
**Topic:** YouTube auto-selects an auto-dubbed audio track for a German-locale browser.
Force the original track — whatever language it is — on every watch page, via the
`scripts` overlay.

## 1. Goal & scope

YouTube generates auto-dubbed audio tracks and selects one **by locale**. A German
browser lands on the German machine dub of an English video, with no persisted way to
say "never do that". The wanted behaviour: **always the original audio, whatever
language the original happens to be** — not "always English".

### In scope

- One self-contained IIFE under `scripts:` on the `youtube.com` rule in
  `configurable-containers.config.yaml`, `at: document_start`.

### Out of scope

- **Automated tests** (§7). Deliberate, with reasons.
- **Changing the interface language.** The UI stays German.
- Signed-in accounts. `CONFIG.md:391` keeps YouTube signed-out and disposable, so there
  is no account preference to reach for.

## 2. What the reversing established

Measured in real Firefox through the Selenium harness — `harness/firefox.ts` `launch()`
was already built for live sites (`localDomains: null`) — against
`youtube.com/watch?v=KIE597NV6WE`, which carries 11 auto-dubs plus an English original.
These are measurements, not inferences, except where marked.

### 2.1 The default is chosen server-side, and `hl` drives it

| `Accept-Language` | PREF `hl` | UI language | track marked `audioIsDefault` |
| ----------------- | --------- | ----------- | ----------------------------- |
| `de-DE`           | *unset*   | German      | `de-DE.10` **auto-dub**       |
| `en-US`           | *unset*   | English     | `en-US.4` original            |
| `de-DE`           | `en`      | **English** | `en-US.4` original            |
| `en-US`           | `de`      | **German**  | `de-DE.10` **auto-dub**       |

PREF's `hl` overrides `Accept-Language`, and drives **interface language and dub
selection together**. So no cookie buys original audio *and* a German interface.
(Inference, untested: `hl=en` would not give "the original" either — it gives "English",
so a German-original video would get an English dub.)

**Nothing persists.** After switching track and playing, no cookie and no `localStorage`
key encoded the choice, and a reload returned to the dub. Signed out, YouTube re-decides
every page load.

### 2.2 The original is identified structurally, not linguistically

All 11 dubs carry `isAutoDubbed: true`; the original carries no such field. Its id ends
`.4` where dubs end `.10`, and the player-side track id is a blob containing the literal
`dubbed-auto`. Three independent signals. `displayName` says "original" but is
localised, so it is not usable as a discriminator.

### 2.3 Patching the player response does not work — the player re-derives

A `document_start` content script intercepted `window.ytInitialPlayerResponse` and
retargeted `audioIsDefault` across all 6 matching formats, verifiably before the player
read it (setter fired t=790, `was=de-DE.10 -> now=en-US.4`). German played anyway. The
player does not trust that global; it re-derives from its own `/youtubei/v1/player`
fetch. This was the approach reasoning alone recommended, and it is dead on measurement.

### 2.4 Events are the wrong trigger, and `loadstart` is the best of them

| signal              | first load        | SPA click      | SPA back          |
| ------------------- | ----------------- | -------------- | ----------------- |
| `loadstart` (video) | t=845, tracks=12  | t=9753         | t=18428, tracks=12 |
| `yt-navigate-finish`| t=1434            | t=10265, tracks=0 | —              |
| `yt-player-updated` | t=1754            | t=9743, tracks=0 | t=18418         |

`yt-navigate-finish` fires ~1s *after* the tracks are usable on first load, and *before*
the player has rebuilt on SPA navigation (`tracks=0`). It can neither replace a wait nor
add anything to one. `loadstart` is strictly better — earliest, correct video id, track
list already populated. It is still not sufficient, because of §2.5.

### 2.5 The player APPLIES a switch and then REVERTS it

The decisive measurement:

```
t=874   cur=und/orig  n=12   SWITCH -> en-US.4
t=1055  cur=en-US.4/orig      <- the switch applied
t=5750  cur=de-DE.10/DUB      <- the player reverted it
```

Several seconds in, around the time playback commits, the player reasserts the
server-chosen dub. This explains two runs of the same code, switching ~150ms apart, that
ended on opposite tracks. **No one-shot design is reliable** — event-triggered or polled,
it is a race against a revert that may land after it.

### 2.6 Nothing announces the revert — there is no event to listen for

`EventTarget.prototype.dispatchEvent` was patched in the page world and every event type
the page fired was recorded — 48 of them, including the full `yt-*` set. In the 700ms
before an observed revert, **not one fired**. The player changes the track silently.

`video.audioTracks` is not an alternative: it sits behind Firefox's `media.track.enabled`
(off by default) and, even with the pref on, reads **length 0**, because YouTube feeds
audio through MSE rather than as discrete media tracks.

So the correction cannot be made reactive. Polling is not laziness here; it is the only
signal available.

### 2.7 `setAudioTrack()` itself works

Switching is effective and costs no audible dub: the player is reachable ~350–900ms in
and the switch lands at `currentTime=0`. The concern that the user would hear a moment of
German before the switch did not materialise.

## 3. Design

A single IIFE injected at `document_start` on `youtube.com`, holding an **invariant**
rather than performing an action:

> The currently selected audio track is never an auto-dub.

Enforcing an invariant instead of acting once is what §2.5 forces, and it collapses the
rest of the design: SPA navigation, back-navigation onto an already-fixed video, and the
player's own revert all become the same case. No video-id bookkeeping and no "already
handled" flag — both were tried, and each broke on one of those three cases (the id-keyed
version silently skipped a video it had fixed before, which is what A → B → A does).

`loadstart` does appear, but only to bound *when* the invariant is enforced (§3.1) — never
to decide *whether* it holds.

### 3.1 The poll is bounded, not permanent

A timer running at 10Hz for the life of every YouTube tab is more than this needs, and
each tick allocates per track. Instead the interval is **armed for 60s on every media
load** — `loadstart`, capture phase — and clears itself when the window expires. Between
videos it costs nothing.

`loadstart` failed as a one-shot *trigger* (§2.5) but is a good *re-arm* signal: §2.4
measured it firing on first load, SPA navigation and back-navigation, always with the
track list already populated, and it fires again at each ad break — covering every
moment the track can change.

60s is a margin, not a bound: reverts were measured at **5.7s** and at **17.1s** after
the switch, and §2.6 established there is no way to observe what schedules them. A
revert landing later than 60s would not be corrected; nothing seen so far suggests one
does.

Verified against the shipped snippet: armed at t=490, enforced at t=900, `clearInterval`
at t=30909 under the earlier 30s window, and re-armed at t=38107 by an SPA
back-navigation which then re-enforced at t=46287.

### 3.2 Per tick (100ms)

1. Get `getAvailableAudioTracks()`. Empty → return (single-track video, or player not
   rebuilt yet).
2. Find the track the **server** marked `isDefault`. If it is **not** auto-dubbed →
   return. This is the hands-off guard for videos with deliberate human alternate
   tracks, where several tracks are non-dubbed and there is no reliable "original".
3. Find the first track with no `isAutoDubbed`. None → return.
4. If the current track is already that one → return. (Invariant holds; this is also
   what makes the loop terminate.)
5. `setAudioTrack(original)`.

Guarding on the **`isDefault` track** rather than the current one is required:
`getAudioTrack()` reports `und` ("Default") until playback commits, so a current-track
guard sees no dub and never fires.

### 3.3 Two hazards that make correct-looking code fail

- **The flags object is found by SHAPE, not key name.** On player track objects the flags
  live under a **minified** key (`qK` at time of writing) that changes with every player
  build. Scan the track's own keys for a value carrying an `isAutoDubbed` property. The
  plain names (`isAutoDubbed`, `audioIsDefault`) hold only in the response JSON, which
  §2.3 established the player ignores.
- **Content scripts are an isolated world: the player's methods are reachable only via
  `wrappedJSObject`.** `document.getElementById("movie_player")` yields an Xray wrapper
  whose `getAvailableAudioTracks` is not visible. A version written without it looks
  right and silently never fires. (Note the asymmetry: WebDriver's `executeScript`
  sandbox *does* reach page methods directly, so probe code and snippet code differ here.)

### 3.4 The snippet

```js
(() => {
  // The flags live under a MINIFIED key that changes with every player
  // build, so find them by shape. The plain names (isAutoDubbed,
  // audioIsDefault) hold only in the response JSON, which the player ignores.
  const flags = (t) => {
    if (!t) return null;
    for (const k of Object.keys(t)) {
      const v = t[k];
      if (v && typeof v === "object" && "isAutoDubbed" in v) return v;
    }
    return null;
  };
  // This fails silently by design -- every giving-up path is a bare return,
  // and the only symptom is a video playing German. So each one says WHY on
  // documentElement, which the page console can read even though the content
  // script's own scope cannot be inspected: `document.documentElement.dataset.ccAudio`.
  let mark = "";
  const state = (s) => {
    if (s === mark) return;
    mark = s;
    try { document.documentElement.dataset.ccAudio = s; } catch (e) {}
  };
  state("armed");

  const enforce = () => {
    // A content script is an isolated world: the player's methods are only
    // reachable through wrappedJSObject. Without it this silently never fires.
    const el = document.getElementById("movie_player");
    const p = el && el.wrappedJSObject;
    if (!p || typeof p.getAvailableAudioTracks !== "function") return state("no-player");
    const tracks = Array.from(p.getAvailableAudioTracks() || []);
    if (!tracks.length) return state("no-alternate-tracks");
    // Guard on the track the SERVER marked default, not the current one:
    // getAudioTrack() reports "und" until playback commits, so a
    // current-track guard never sees the dub and never fires. A video whose
    // default is not a dub is left alone -- its extra tracks are deliberate.
    const def = tracks.find((t) => { const f = flags(t); return f && f.isDefault; });
    if (!def) return state("no-default-marked");
    if (!flags(def).isAutoDubbed) return state("default-not-a-dub:" + flags(def).id);
    const orig = tracks.find((t) => { const f = flags(t); return f && !f.isAutoDubbed; });
    if (!orig) return state("no-original-available");
    const cur = flags(p.getAudioTrack());
    if (cur && cur.id === flags(orig).id) return state("holding:" + cur.id);
    p.setAudioTrack(orig);
    state("switched:" + flags(orig).id);
  };
  // Polling, because NOTHING announces the change: the player reverts the
  // track silently. Verified by patching EventTarget.prototype.dispatchEvent
  // and recording all 48 event types the page fires -- not one landed in the
  // 700ms before a revert. video.audioTracks is no help either: it sits behind
  // media.track.enabled (off by default) and reads length 0, since YouTube
  // feeds audio through MSE.
  //
  // So the poll is bounded instead of dropped: a window re-armed on every
  // media load, rather than a timer running for the life of the tab.
  // loadstart fires on first load, on SPA navigation, on back-navigation onto
  // an already-fixed video, and at each ad break -- every moment the track can
  // change -- and this idles at zero cost in between.
  //
  // 60s because reverts were measured at 5.7s and at 17.1s after the switch.
  // Whatever schedules them is not something we can see, so the window is set
  // by margin over the worst observed, not by a known bound.
  let until = 0;
  let timer = null;
  const arm = () => {
    until = Date.now() + 60000;
    if (timer) return;
    timer = setInterval(() => {
      try {
        enforce();
      } catch (e) {
        // Never throw into the page.
      }
      if (Date.now() > until) {
        clearInterval(timer);
        timer = null;
        state(mark.indexOf("holding") === 0 ? mark : "idle:" + mark);
      }
    }, 100);
  };
  document.addEventListener("loadstart", (e) => {
    if (e.target instanceof HTMLMediaElement) arm();
  }, true);
  arm(); // the first load may already be under way
})();
```

Implementation note: this is multi-line, where `CONFIG.md:363`'s example `run:` is a
single-line string. The plan's first step is to confirm the config parser accepts a YAML
block scalar here, and to fall back to a minified one-liner if not.

## 4. Accepted consequence: manual dub selection is overridden

On a video whose server default is a dub, choosing a dub from YouTube's audio-track menu
is undone within ~200ms. Selecting any **non**-dubbed track is respected, and videos
whose default is not a dub are untouched entirely. This follows directly from "I always
want the original" and is accepted, not overlooked.

This holds **even after the 60s window has expired**, which is not obvious: selecting a
track fires `loadstart`, which re-arms the window (§3.1). Measured with playback never
started and autoplay blocked — a dub picked at t=14.5s was corrected by t=14.7s, and one
picked at t=80.5s fired `loadstart` at t=80.5s and was corrected inside a single 200ms
observation. So bounding the poll did not cost the property; the two mechanisms compose.

## 5. What this does not do

Auto-dubbing is *corrected*, not prevented — YouTube still generates the dubs and still
selects one server-side; we switch away before playback starts and switch back if the
player reverts. The dub's audio stream may still be fetched briefly. Nothing audible
reaches the user.

## 6. Failure mode

If YouTube changes the player, this fails **safely**: no flags object is found, nothing
happens, the dub plays. It is no longer **silent**, though — every giving-up path records
why on `documentElement`, readable from the page console (which cannot otherwise inspect
a content script's scope):

```js
document.documentElement.dataset.ccAudio
// armed | no-player | no-alternate-tracks | no-default-marked
// default-not-a-dub:<id> | no-original-available | holding:<id> | switched:<id>
// idle:<last state>
```

`no-player` distinguishes the case that matters most — the snippet running but unable to
reach the player, as another extension wrapping the YouTube player would cause — from the
snippet not running at all, where the attribute is simply absent. Given §7 there is no
test to catch a regression, so being able to ask the running page is what replaces one. The 100ms interval is alive only inside the 60s window
after a media load (§3.1); its work is two method calls and an array scan, and on any
page without a `#movie_player` it returns before doing even that.

## 7. Testing — verify once, no automated test

Chosen deliberately over a fixture-based harness test and a nightly live test.

The logic ships as a **string inside YAML**, where nothing type-checks or tests it. That
sits badly against the rest of this repo and the tension is real rather than resolved.
It is accepted because the alternatives buy less than they cost: a local fixture would
test a mock of the player API — and §2.3 and §2.5 are both cases where the real player
contradicted a reasonable model of it — while a live nightly test would rest on one
video keeping its auto-dubs and would put network flake into a suite that has none.

Verification is: run the final snippet against the real video in real Firefox and
confirm the resulting track is the original on first load, after SPA navigation, and
after SPA back-navigation. This has already been done for the §3.3 logic (all three legs
green, including an observed re-enforcement after a revert). This is a power-user escape
hatch in a single-user tool — the same justification `CONFIG.md:377` gives the `scripts`
overlay itself.

## 8. Follow-up

Consider a short CLAUDE.md note carrying §2.3 and §2.5 — that patching
`ytInitialPlayerResponse` is ineffective because the player re-derives, and that the
player reverts an audio-track switch seconds later. Both are exactly the "makes a
reasonable-looking change wrong" shape that file collects. Deferred until the snippet
ships.
