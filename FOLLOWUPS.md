# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry
once it is resolved.

## `reopenedNav` does not survive a background restart (2026-07-28)

The F1 reopen guard (`src/engine/engine.ts`) is the one piece of guard state nothing can
rebuild, and `test/engine/restart.test.ts` pins the price rather than fixing it. The
window is between `port.createTab` and the reopened tab's first request; a restart
inside it costs **one** extra reopen, converges (the fresh engine guards the reopen it
performs), and leaks no container — the abandoned throwaway is disposed on the grace.

It is not reconstructible because a reopened pre-commit tab and a middle-clicked one are
both `about:blank` in a real container, and the middle-clicked one must still be
isolated into a throwaway of its own. The requestId in `reopenedNav` is the only thing
that separates them. Persisting it needs a storage seam on `BrowserPort`, which is a
poor trade for a millisecond window the user currently chooses (a config save calls
`runtime.reload()`). **Revisit on an MV3 migration**, where suspension is involuntary
and the window stops being user-chosen — the cost side is already measured.

**Priced against the seam, 2026-07-28, and the answer is still no.** The disposer's grace
fix built `readStored`/`writeStored` on `BrowserPort`, so the seam this was waiting for
now exists and the implementation would be cheap: hydrate the map at startup, write
through on each reopen, and extend the existing `configReady` gate to also await the
hydration (reading storage inside the blocking handler is not an option — that is every
navigation's latency). Two things nonetheless argue against it:

- **The window coincides with peak activity, not idleness.** It runs from `port.createTab`
  to the reopened tab's first request — milliseconds during which the extension has just
  handled a blocking request and is mid-reopen. Firefox suspends an event page when it is
  *idle*, so the involuntary-suspension frequency that justified revisiting this is much
  lower here than the MV2-vs-MV3 framing suggested. The window did not really stop being
  rare.
- **Persisting it adds a worse failure than the one it removes.** Entries are keyed by
  tab id, and tab ids restart with the browser — so a stale entry (the reopened tab's
  request never arrived: load aborted, tab closed) could be claimed by an unrelated later
  tab of the same id. That is the mis-absorption the in-memory version already had to be
  taught to avoid, and its cost is a navigation loading **unrouted inside a permanent
  container** (F11 by way of F1). A TTL bounds it, but the trade is then "a silent
  wrong-container risk" against "one wasted reopen that converges and leaks nothing".

Revisit only if dogfooding shows the wasted reopen actually happening — it is visible as
a `tmp` container created and abandoned in the same second.

Harness gap while here: `test/engine/restart.ts` does not model async work already in
flight at the restart (a floated `containerize` mid-`await`). Firefox kills it; the
harness lets it land. Every current case drives the restart from a settled state, so
nothing is in flight — a future case that needs it has to close this first.

## Notification volume on declined POSTs (2026-07-28) — CLOSED, narrowed 2026-08-14

Every cross-site form POST that would change container raised a notification,
deduplicated per host per background session. Payment-gateway returns are the common
case, and there staying put is the *desirable* outcome — so the toast may prove to be
noise. The narrower trigger (notify only when the denied target was a **permanent**
container, i.e. a rule that went unapplied) is a one-line change at the same site in
`src/engine/engine.ts`. Revisit after real use.

**Narrowed as proposed, but "revisit after real use" was the wrong test and the volume
framing was the wrong question.** Two things came out of pricing it against a real config
(`configurable-containers.config.yaml`) rather than waiting:

- **The volume worry was unfounded, and no soak would have shown it.** Almost nothing can
  reach the guard. An `inherit` rule resolves `desired` to `nav.initiator ?? current`, and
  for a tab that is on a page those are the same container — so the whole SSO and 3DS
  exemption block returns `stay` and is structurally incapable of toasting. A named rule
  short-circuits the same way once the tab is already in its container, which is where
  every auth return lands, having started there. What survives is a top-level POST to a
  host **no rule matches** — a card payment at an unmatched shop — a handful of times a
  month. Nobody was ever going to be annoyed by the count.
- **What settles it is the message, not the rate.** In that surviving case both halves of
  the sentence name a throwaway: *stayed in tmp9 instead of a new temporary container*.
  There is no user-visible difference between those states and nothing to act on, so the
  message carries no information at any frequency. That is readable off `targetLabel`
  today and needed no production data at all.

So the split lands where the followup guessed, for a better reason: announce only when the
decision names a container the **config** names, because only then is there an unapplied
rule to report. `namesAConfiguredContainer` in `src/engine/engine.ts`, with the decline
left unconditional; two L3 cases in `test/engine/post-binding.test.ts` pin the silence
(revert-verified), and the e2e keeps the permanent-target toast.

Deliberately silenced with it: *stayed in Haeger instead of a new temporary container* —
a POST out of a **permanent** container that would have been isolated. Unlike the
throwaway-to-throwaway case that message does say something (the body went out under a
named identity rather than an isolated one), but it still reports no unapplied rule and
offers nothing to do about it. Reopen this if a case turns up where that distinction
matters.

Also learned, and worth knowing before anyone tests the `choice` half by hand: **a POST
that resolves to `choice` may be unreachable in ordinary browsing.** The choice screen
only appears when the tab is in none of the eligible containers, and picking one puts it
in an eligible container — which is exactly the condition under which multi-open returns
`stay`. Every auth POST comes back *after* that pick. It would take a cross-site POST into
a multi-open host from a tab in none of its containers. L3 covers the path; the wild may
not contain it.

Not done here either: **replaying** the POST into the target container via a generated
auto-submitting form page. It is the only option that would actually route the
assertion, and neither Temporary Containers nor Multi-Account Containers attempts it.
It needs the `requestBody` webRequest opt-in, urlencoded and multipart handling, and a
`moz-extension:` page forging a cross-origin POST. See
`docs/superpowers/specs/2026-07-28-f9-redirect-binding-design.md` §1.
