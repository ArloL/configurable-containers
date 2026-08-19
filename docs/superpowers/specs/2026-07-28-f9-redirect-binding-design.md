# Redirect Binding Across a Container Switch (F9) — Design

**Date:** 2026-07-28
**Status:** Implemented
**Topic:** Close the last open failure class in TESTING.md's coverage matrix. A GET
redirect carrying a `code` parameter must survive a reopen intact; a POST-binding
navigation that would change container must **not** be reopened — because reopening it
silently drops the body — and CC must say so out loud.

## 1. Goal & scope

F9 is the only class in the [coverage matrix](../../../TESTING.md) with no test at any
level, and the only one the document itself describes as having no deterministic owner:
POST bodies and redirect bindings don't exist in a pure resolver, so it is owned by the
real-Firefox levels. This slice gives it an L3 owner as well as an L4 one.

The GET half is already correct and needs only a regression test. The POST half is a
live silent bug: `reopen` executes via `port.createTab({ url })`, which is
unconditionally a GET, so a SAML assertion posted to a rule-matched host is dropped
without a trace.

### In scope

- A **non-GET guard** in the engine's effects switch: a `main_frame` request whose
  method is not GET and whose decision is `reopen` or `choice` is left alone.
- A **notification** for every declined POST, behind a new `BrowserPort.notify` seam,
  deduplicated per target host per background session.
- The `"notifications"` manifest permission.
- A **mock IdP** in `harness/server.ts`: an OAuth code-flow redirect, a SAML
  POST-binding form, and POST-body reflection.
- A **probe echo** behind an esbuild define, so L4 can observe a notification Selenium
  cannot otherwise see, plus a `notifications` probe command and a `readNotifications`
  helper.
- Tests at L3 and L4, and the documentation changes the new policy forces.

### Out of scope (deferred)

- **Replaying the POST** into the target container via a generated auto-submitting form
  page. It is the only option that would actually route the assertion, and it has no
  prior art in either upstream. It needs the `requestBody` webRequest opt-in, multipart
  and urlencoded handling, and a `moz-extension:` page forging a cross-origin POST.
  Section 2 is deliberately shaped so this remains a change to *how the engine executes
  an unchanged decision*.
- **The L5 acceptance layer** — TESTING.md describes a suite mirroring TESTS.md one test
  per scenario with a CI drift check. That is its own slice; F9's two scenarios would be
  its first residents.
- **Notification click actions** (jump to the options page, pre-fill an `inherit` rule).

## 2. Behaviour

A `main_frame` request whose method is **not GET**, and whose decision is `reopen` or
`choice`, is left alone: no `cancel`, no tab created, no choice screen. The navigation
proceeds in the tab's current container, and a notification is raised.

`stay` and `leaveAlone` never reach the guard. **Same-site POSTs already resolve to
`stay`** via `disposablePath`, so an ordinary form submission back to the site you are
on is untouched without the guard doing anything.

### 2.1 Why the guard lives in the engine

CLAUDE.md's rule is that routing logic belongs in the resolver and never in the engine.
The guard is placed in the engine anyway, on the grounds that it is not a routing rule:
the resolver's answer — "work.example belongs in Work" — is still correct. What is
untrue is that the engine can *carry it out*. `tabs.create` issues a GET; that is a fact
about `tabs.create`, not about where sites belong.

Two consequences follow, and they are the reason for the choice:

1. **If POST replay ever lands**, the engine learns a second way to execute an unchanged
   decision. Had the resolver returned `leaveAlone` instead, the decision itself would
   have been wrong and would need reverting, along with every test asserting it.
2. **Loudness is a side effect**, and a pure resolver cannot fire one. A resolver-side
   guard would have to distinguish this from an `ignore`-rule `leaveAlone` for the engine
   to know which deserves a warning — meaning a new `Decision` variant. The engine
   placement needs no type change at all.

In fairness to the rejected option: the rule exists because engine logic is hard to test
and hard to find. A four-line guard sitting directly above the `reopen` it modifies,
covered at L3, does not have that problem.

### 2.2 Ordering inside `onBeforeRequest`

The guard sits at the top of the effects switch (step 4), which places it:

- **After the `reopenedNav` guard (step 1b).** A POST arriving inside a navigation we
  already reopened returns at 1b and never reaches here — correct, that navigation is
  ours and already contained.
- **Before `macOwns`.** No reason to message MAC about a navigation we have decided not
  to act on.
- **Before `handled.add(key)`.** The path adds no state, so it is fail-open by
  construction.

```ts
// (4) Effects.
switch (decision.kind) {
  case "leaveAlone":
  case "stay":
    return;

  case "choice":
  case "reopen":
    // tabs.create can only issue a GET, so reopening this navigation would drop its
    // body. Leave it where it is and say so — F9.
    if (d.method !== "GET") {
      void announceDeclined(d, tab, decision);
      return; // no cancel: the POST proceeds in the tab's current container
    }
    …
}
```

### 2.3 Blast radius, stated honestly

*Cross-site `main_frame` POSTs are never routed.* In practice: SAML assertions,
payment-gateway returns, some cross-site search forms.

For payment flows, staying put is usually the desirable outcome — it is why checkout
survives. For an SSO chain it is a configuration miss with a concrete fix: give the IdP
`inherit: true` (TESTS.md, "Inherit and SSO"), which puts the IdP in the app's container,
so the assertion posts back to the same container, `resolve` returns `stay`, and the
guard never fires. **F9's POST branch is the symptom of a missing `inherit`.**

Both cases notify. The alternative — notifying only when the denied target was a
permanent container — was considered and rejected: it hides every isolation that didn't
happen, and an unmatched host sharing a shop's cookie jar is worth knowing about even
when it is the outcome you wanted. Noise is controlled by deduplication (§3.2), not by
suppressing a category.

### 2.4 Neither upstream does this

`tcp/src/background/isolation.ts:328` is the only method-awareness in either submodule:
`shouldSkipSameDomainPostInTemporaryTab` declines to isolate a POST **to the same
hostname the tab is already on**, in a temporary container. It is silent (a `debug()`
line) and does not touch the cross-container case. CC gets that case for free from
`disposablePath`'s same-site continuity, which TCP's isolation model lacks.

MAC has none. `assignManager.js:222` filters `frameId !== 0 || tabId === -1` and nothing
else; `reloadPageInContainer` → `createTabWrapper` → `tabs.create(url)` — every
assigned-domain reopen silently converts POST to GET, the same bug CC has today. Its
`confirm-page.html` interstitial (`assignManager.js:806`) is prior art for the
cancel-and-show-an-extension-page shape, but it is used for confirmation and still drops
the body on click-through.

## 3. The notification

### 3.1 Message

`announceDeclined` is a helper inside the `createEngine` closure — it owns the dedupe set
(§3.2), composes the text, and calls `port.notify`. The engine has both container names:
the tab's own via `port.getIdentity(tab.cookieStoreId)` (null for `firefox-default`), and
the target from the `Decision`.

> **Configurable Containers**
> A form submission to **work.example** stayed in **tmp3** instead of **Work** — moving
> it would have dropped the form data.

Target rendering by kind: `permanent` → its name; `temporary` → "a new temporary
container"; `default` → "the default container"; a `choice` decision → "one of:
Personal, Work".

### 3.2 Deduplication

A `Set<string>` of target hosts already warned, held in the engine's closure. Session
scoped, no eviction. `browser.runtime.reload()` on a config save clears it, which is the
behaviour we want: the rules just changed, so the user should hear about them again.

### 3.3 Fire-and-forget

`announceDeclined` is invoked with `void` and never awaited. `onBeforeRequest` is a
blocking listener — Firefox waits on the promise it returns — and a navigation must not
be delayed to paint a toast. Its failure is caught and logged; a notification that
cannot be raised must not break routing.

Two costs, both accepted: L3 tests flush a microtask before asserting on the mock's
recorded calls, and the L4 helper polls (§5.3) rather than reading once. Polling is
already the harness convention (`awaitContainerTab`).

## 4. Port seam

`BrowserPort` gains one method:

```ts
notify(n: { title: string; message: string }): Promise<void>;
```

**Real adapter** (`browser-port.ts`):

```ts
declare const __CC_NOTIFY_ECHO_TO__: string; // "" in every shipped build

async notify(n) {
  await browser.notifications.create({ type: "basic", ...n });
  if (__CC_NOTIFY_ECHO_TO__) {
    await browser.runtime.sendMessage(__CC_NOTIFY_ECHO_TO__, { cmd: "cc-notification", ...n });
  }
}
```

**The `await` before the echo is a design invariant, not formatting.** Forget the
`notifications` permission and `create` throws, the echo never runs, and the L4
assertion goes red. Echo first and the suite would report green with the notification
entirely broken — this project has shipped that exact false green twice (CLAUDE.md,
"Revert-verify every new regression test").

The define carries the *recipient id* rather than a boolean, so the test extension's
identity never appears in shipped source: `harness/build-extension.ts` sets
`"probe@configurable-containers.test"`, `npm run package` and `npm run manual` set `""`,
and esbuild eliminates `if ("")` outright. Firefox needs no manifest declaration on the
sender — only the receiver needs `onMessageExternal`, which is why the MAC handshake
already works.

**Mock port** records the calls for L3 assertions.

**Manifest**: add `"notifications"` to `extensions/cc/manifest.json`.

## 5. Harness

### 5.1 Mock IdP

`harness/server.ts` grows two endpoints and one parser. Both destinations are **fixed
constants**, never read from the query string: the existing `REDIRECT_TARGET_HOST`
comment records that a reflected destination is an open redirect (CodeQL
`js/server-side-unvalidated-url-redirection`), and that applies here identically.

- `GET /authorize` → 302 to `http://work.example:<port>/callback?code=<OAUTH_CODE>`.
- `GET /saml` → a page whose form auto-submits `SAMLResponse=<SAML_ASSERTION>` by POST
  to `http://work.example:<port>/acs`.
- Any POST → parse `application/x-www-form-urlencoded` and reflect it into
  `data-seen-post` on `<body>`, the exact shape of the existing `data-seen-cookie`.

`OAUTH_CODE` and `SAML_ASSERTION` are exported so tests assert against constants.
`work.example` is already mapped to `Work` in `TEST_CONFIG_YAML`; no config change.

### 5.2 Probe

A `notifications` command on the existing relay, returning the list the probe has
collected from `onMessageExternal`, plus `readNotifications(driver)` in
`harness/firefox.ts` alongside `readContainerList`.

**A command, not a `data-cc-` attribute.** The probe writes attributes when a page
finishes loading, but the echo arrives at request time — concurrent with that load. An
attribute read would be racy; the relay is polled on demand, like `listTabs`.

## 6. Testing

### 6.1 The trap: the naive OAuth test asserts nothing

Navigate a fresh tab straight to `nomatch.example/authorize` and CC reopens it into a
throwaway. The reopened tab then performs `/authorize`, and **the 302 reuses the same
requestId**, so `reopenedNav` holds the whole chain — commit `c93481f`, working exactly
as designed. The callback lands in the throwaway, no container switch ever happens, and
a test asserting "the code survived" passes while proving nothing about a reopen.

Both L4 tests therefore drive from a **committed** page, mirroring the existing
same-tab-link case in `test/e2e/routing.test.ts`:

1. Fresh tab → `nomatch.example/` → lands in `tmp1`, commits.
2. Click a same-site link to `/authorize` or `/saml` — same site, so `stay`, no reopen,
   no guard.
3. The hop out of it is an unguarded navigation the engine resolves normally.

### 6.2 L4 — `test/e2e/redirect-binding.test.ts`

- **OAuth code flow survives a reopen.** The `/authorize` 302 to
  `work.example/callback?code=…` is reopened into **Work**, and `listTabs` reports the
  URL with `code=<OAUTH_CODE>` intact. A real container switch, with the parameter
  surviving it.
- **A POST that would change container is left where it is, loudly.** The auto-submitted
  POST to `work.example/acs` is **not** reopened: a tab exists on `/acs`, its container
  is still `tmp1`, its `data-seen-post` carries `<SAML_ASSERTION>`, and
  `readNotifications` reports a warning naming `work.example`, `tmp1` and `Work`. One
  test proves all three halves — not routed, not dropped, not silent.

### 6.3 L3 — `test/engine/post-binding.test.ts`

Against the mock port and its recorded `notify` calls:

- POST + `reopen` into a permanent container → no `createTab`, no `cancel`, notifies.
- POST + `reopen` into a temporary container → same.
- POST + `choice` → no choice screen, no `cancel`, notifies.
- POST + `stay` → untouched, silent.
- GET + `reopen` → unchanged (the regression guard).
- Two POSTs to one host → one notification.
- A POST inside a navigation held by `reopenedNav` → returns at 1b, silent.

### 6.4 Revert-verification

Per CLAUDE.md, every new regression test is confirmed to fail with the fix backed out.
Two matter most:

- Back out the `await` before the echo → the L4 notification assertion must go red.
- Back out the guard entirely → the SAML test must fail on **container**, not on a
  missing tab. Failing on a missing tab would mean the test is measuring something else.

## 7. Documentation

The chosen policy makes the current spec text false, so these are deliverables, not
housekeeping.

- **`TESTS.md`** — both scenarios under "Redirect binding across a container switch" are
  replaced. The POST one is premised on `When the reopen happens`, which is now false by
  design, and it offers two outcomes where the real one is a third: the switch never
  happens.

  ```gherkin
  Scenario: An OAuth code flow (GET redirect) survives a reopen
    Given a login that completes via a GET redirect carrying a code parameter
    And the redirect target matches a rule that opens it in another container
    When the redirect is reopened into that container
    Then the code parameter is preserved in the reopened tab's URL

  Scenario: A POST that would change container is left where it is, loudly
    Given an identity provider that returns its assertion via a POST-binding form
    And the POST target matches a rule that opens it in another container
    When the POST is submitted
    Then CC does not reopen the tab, because a reopen would drop the form data
    And the assertion arrives intact at its destination
    And the destination loads in the container the submission came from
    And a notification names the host, the container it stayed in, and the container
        the rule asked for
  ```

- **`TESTING.md`** — F9 gains an L3 ✅ in the matrix, and the closing paragraph ("F9 is
  the exception by nature") is retired: it now has a deterministic owner like every other
  class.
- **`CONFIG.md`** — document the policy under F9: cross-site POSTs are never routed, and
  `inherit: true` on the IdP is the fix for SSO chains.
- **`CLAUDE.md`** — three entries: the guard and why it sits before `macOwns`; the
  echo-after-`await` invariant and the false green it prevents; the redirect-chain
  interaction that dictates the test shape (§6.1).

## 8. Risks & mitigations

- **A silent wrong container.** The declined POST writes the site's session cookie into a
  container the rules said it doesn't belong in — the F11 shape arriving through the F9
  door. Mitigated by the notification; that is the entire reason loudness is in this
  slice rather than deferred.
- **Notification fatigue.** Every checkout POST to a payment processor raises one.
  Mitigated by per-host deduplication (§3.2). If it still proves noisy in daily use, the
  narrower "permanent targets only" trigger is a one-line change at the same site.
- **False green on a missing permission.** Mitigated by the echo ordering (§4) and
  revert-verified (§6.4).
- **Testing the echo instead of the toast.** The L4 assertion proves CC asked Firefox to
  raise a notification and that Firefox accepted the call — not that a toast painted. The
  alternative (`alerts.useSystemBackend=false` plus `driver.setContext(Context.CHROME)`)
  reads Firefox-internal XUL that no version contract covers, in a separate top-level
  window, possibly suppressed headless. Rejected as a source of unprovoked reds in a
  suite that already runs a `latest`/`esr` matrix. Rendering is Firefox's job.
- **`fileParallelism: false` still required** — a new e2e file bundles to the same
  `extensions/cc/background.js` as the others.

## 9. What this slice does *not* prove

POST replay, the L5 acceptance layer, MV3 restart behaviour (F8), and that a toast is
actually painted on screen. It proves F9 is closed: a GET redirect's parameters survive a
container switch, and a POST that would change container keeps its body, keeps its
container, and announces both — deterministically at L3 and once for real at L4.
