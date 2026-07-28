# AMO listing copy

Source of truth for what appears on the addons.mozilla.org listing. The Developer Hub
has no version history for listing text, so edit here first, then paste across.

`web-ext sign --amo-metadata <file.json>` can set some of this via the API if the
listing is ever managed automatically; today it is entered by hand.

## Name

    Configurable Containers

## Summary

AMO caps this at **250 characters**. Current: **178**.

    One text config routes every site to the right container: named containers for the sites you choose, a fresh throwaway for everything else, and single sign-on that keeps working.

## Description

AMO accepts only a subset of HTML here — `<a>`, `<b>`, `<strong>`, `<em>`, `<i>`,
`<code>`, `<blockquote>`, `<ul>`, `<ol>`, `<li>`, `<abbr>`, `<acronym>`. **No headings**,
so section titles are bold text. Blank lines survive as paragraph breaks. Paste the
block below verbatim.

```html
Configurable Containers routes each site into the right Firefox container, from a single configuration you edit as text.

Firefox's container ecosystem does two things separately today: persistent, named containers you assign by hand, and disposable ones created automatically. Configurable Containers puts one config in charge of both.

<b>What it does</b>

<ul>
<li><b>Domain to container mapping.</b> The common case is one line — a bare domain opens in a container named after it. Add detail only when you want a curated name, several domains sharing one container, or a choice between containers.</li>
<li><b>Temporary by default, permanent by choice.</b> Anything no rule matches opens in a fresh throwaway. Long-lived containers are opt-in, one rule at a time.</li>
<li><b>Single sign-on that keeps working.</b> Identity providers stay in whichever container started the login, so "Sign in with Google / Microsoft / Okta" doesn't break the way it does when every hop gets a new container.</li>
<li><b>Continuity without leakage.</b> Grouped sites stay in the same throwaway as you move between them, while crossing to an unrelated site still spins up a clean one.</li>
<li><b>A choice screen when you want one.</b> A rule can offer several containers and let you pick, with an optional preselected default.</li>
<li><b>Link shims handled.</b> Known redirectors aren't isolated, and the tab closes itself if it strands you on the shim.</li>
<li><b>Per-site cookie seeds and content scripts</b>, applied inside the container the site was routed to.</li>
<li><b>Reopen the current tab in another container</b> with Ctrl+Shift+O.</li>
</ul>

<b>How you configure it</b>

Everything lives in one YAML file, edited in a full-tab text editor built into the add-on (about:addons → Configurable Containers → Preferences). There is no form-based settings UI — the config is the whole interface. Saving validates it and reloads the extension; an invalid config can't be saved.

The shipped default routes nothing into a named container. It only marks the handful of hosts where isolating would break something, and includes commented examples to start from.

<b>Privacy</b>

Configurable Containers collects and transmits nothing. Your configuration is stored locally in your browser and never leaves it.

Source code and full configuration reference: <a href="https://github.com/ArloL/configurable-containers">github.com/ArloL/configurable-containers</a>
```

## Other listing fields

| Field | Value |
|---|---|
| Category | Privacy & Security |
| License | MIT (matches `LICENSE`) |
| Data collection | None — mirrors `data_collection_permissions: { required: ["none"] }` in the manifest |

## Claims to keep honest

- **Do not advertise a management-overview UI.** `README.md` lists one as a goal, but the
  2026-07-28 design spec defers it — the YAML file *is* the overview. Promising a screen
  that does not exist invites the review that asks where it is.
- **State the YAML barrier plainly, high up.** Someone who wants a click-through settings
  screen should decide against CC on the listing page rather than after installing.
- **Keep the privacy wording identical to the manifest declaration.** Firefox shows the
  manifest's version on the install prompt; a listing that says something different is a
  contradiction a reviewer will find, and CC already asks for `<all_urls>`,
  `webRequestBlocking`, and `cookies`.
- Every bullet describes shipped behaviour. Check a claim against `CONFIG.md` before
  adding one.
