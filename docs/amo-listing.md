# AMO listing copy

Source of truth for what appears on the addons.mozilla.org listing. The Developer Hub
has no version history for listing text, so edit here first, then paste across.

`web-ext sign --amo-metadata <file.json>` can set some of this via the API if the
listing is ever managed automatically; today it is entered by hand.

## Name

    Configurable Containers

## Summary

Capped at **250 characters**, but [AMO's own guidance][listing] is to stay well under:
"do not consider it a challenge to use all the available characters." Current: **147**.

    One text config routes every site to the right container — named where you want them, disposable everywhere else, with single sign-on left working.

## Description

The description field takes **Markdown**, not HTML — see [Make use of markdown][listing].
Supported: `**bold**`, `*italic*`, `[text](link)`, `>` blockquotes, ``` code fences,
`-` unordered lists, `1.` ordered lists, and `*[abbr]: …`. **Headings are not
supported**, so section titles are bold text. Paste the block below verbatim.

```markdown
Configurable Containers routes each site into the right Firefox container, from a single configuration you edit as text.

Firefox's container ecosystem does two things separately today: persistent, named containers you assign by hand, and disposable ones created automatically. Configurable Containers puts one config in charge of both.

**What it does**

- **Domain to container mapping.** The common case is one line — a bare domain opens in a container named after it. Add detail only when you want a curated name, several domains sharing one container, or a choice between containers.
- **Temporary by default, permanent by choice.** Anything no rule matches opens in a fresh throwaway. Long-lived containers are opt-in, one rule at a time.
- **Single sign-on that keeps working.** Identity providers stay in whichever container started the login, so "Sign in with Google / Microsoft / Okta" doesn't break the way it does when every hop gets a new container.
- **Continuity without leakage.** Grouped sites stay in the same throwaway as you move between them, while crossing to an unrelated site still spins up a clean one.
- **A choice screen when you want one.** A rule can offer several containers and let you pick, with an optional preselected default.
- **Link shims handled.** Known redirectors aren't isolated, and the tab closes itself if it strands you on the shim.
- **Per-site cookie seeds and content scripts**, applied inside the container the site was routed to.
- **Reopen the current tab in another container** with Ctrl+Shift+O.

**How you configure it**

Everything lives in one YAML file, edited in a full-tab text editor built into the add-on (about:addons → Configurable Containers → Preferences). There is no form-based settings UI — the config is the whole interface. Saving validates it and reloads the extension; an invalid config can't be saved.

The shipped default routes nothing into a named container. It only marks the handful of hosts where isolating would break something, and includes commented examples to start from.

**Privacy**

Configurable Containers collects and transmits nothing. Your configuration is stored locally in your browser and never leaves it.

Source code and full configuration reference: [github.com/ArloL/configurable-containers](https://github.com/ArloL/configurable-containers)
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

[listing]: https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/#make-use-of-markdown
