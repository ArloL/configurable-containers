# AMO listing copy

Source of truth for what appears on the addons.mozilla.org listing. The Developer Hub
has no version history for listing text, so edit here first, then paste across.

`web-ext sign --amo-metadata <file.json>` can set some of this via the API if the
listing is ever managed automatically; today it is entered by hand.

## Name

    Configurable Containers

## Summary

Capped at **250 characters**, but [AMO's own guidance][listing] is to stay well under:
"do not consider it a challenge to use all the available characters." Current: **131**.

    One YAML file decides which Firefox container each site opens in: named containers where you want them, throwaways everywhere else.

## Description

The description field takes **Markdown**, not HTML — see [Make use of markdown][listing].
Supported: `**bold**`, `*italic*`, `[text](link)`, `>` blockquotes, ``` code fences,
`-` unordered lists, `1.` ordered lists, and `*[abbr]: …`. **Headings are not
supported**, so section titles are bold text. Paste the block below verbatim.

```markdown
Configurable Containers decides which Firefox container each site opens in, from one YAML file you edit as text.

Write a rule for the sites you want a named container for. Everything else opens in a fresh throwaway, cleaned up once you close its tabs.

**What it does**

- A bare domain is the common case: it opens in a container named after it. Add detail for a different name, several domains in one container, or a choice between containers.
- Single sign-on keeps working: identity providers stay in the container the login started from, so "Sign in with Google / Microsoft / Okta" does not break.
- Sites you group together share one throwaway; an unrelated site gets a clean one.
- A rule can offer several containers and let you pick.
- Known link redirectors are not isolated, and the tab closes itself if it strands you on one.
- Optional per-site cookies and content scripts, applied in the routed container.
- Reopen the current tab in another container with Ctrl+Shift+O.

**How you configure it**

There is no settings screen — the YAML file is the whole interface. You edit it in the add-on's own editor (about:addons → Configurable Containers → Preferences). Saving checks the file and applies it at once; an invalid config is refused.

The shipped default routes nothing by name. It marks the few hosts where isolating would break something, and includes commented examples to start from.

**Privacy**

Nothing is collected and nothing is transmitted. Your configuration stays in your browser.

Source code and configuration reference: [github.com/ArloL/configurable-containers](https://github.com/ArloL/configurable-containers)
```

## Other listing fields

| Field | Value |
|---|---|
| Category | Privacy & Security |
| License | MIT (matches `LICENSE`) |
| Data collection | None — mirrors `data_collection_permissions: { required: ["none"] }` in the manifest |

## Notes for reviewer

Paste verbatim into the "Is there anything our reviewers should bear in mind?" field.
Verified against a real rebuild — see "Reproducibility check" below.

```text
BUILD INSTRUCTIONS

Needs Node 22+.

    git clone https://github.com/ArloL/configurable-containers
    cd configurable-containers
    git checkout v<version>
    npm ci
    BUILD_TIMESTAMP=<value> npm run package -- <version>

<version> is the version in the submitted manifest.json. <value> is in that
release's notes at https://github.com/ArloL/configurable-containers/releases.

The result, dist/configurable-containers-<version>.xpi, matches the submitted file
byte for byte, so comparing checksums is enough.

esbuild bundles three TypeScript entry points into background.js, options.js and
choice.js. Nothing is minified; everything else is copied verbatim.

WHAT IT DOES

Routes each site into a Firefox container per a YAML config the user edits in the
options page. Unmatched sites open in a fresh temporary container.

PERMISSIONS

- webRequest, webRequestBlocking, <all_urls> — the whole mechanism. A blocking
  onBeforeRequest listener on main_frame decides the container; if it differs from
  the current one the request is cancelled and the tab reopened there. It must
  block because the decision precedes the request, and any domain may be routed.
- cookies — Firefox requires it for tabs.create({ cookieStoreId }), which
  otherwise throws "No permission for cookieStoreId". Also used by the optional
  cookie-seeding feature.
- contextualIdentities, tabs — create/query/remove containers and tabs.
- storage — the user's config. storage.local only.

CONTENT SCRIPTS

The config has an optional "scripts" key. If the user sets it,
src/engine/script-injector.ts passes that string to contentScripts.register().
The code comes only from their own storage.local config, never the network. No
eval, no new Function, no remotely loaded code. The shipped default has no
"scripts" entries.
```

### Reproducibility check

Re-run before a submission if the build changes — it is what the claim above rests on.
Mirrors what a reviewer does: a clean clone, built and compared.

```sh
TS=1785200000   # any fixed value
git clone --quiet . /tmp/repro
( cd /tmp/repro && npm ci && BUILD_TIMESTAMP=$TS npm run package -- 2607.0.101 )
BUILD_TIMESTAMP=$TS npm run package -- 2607.0.101
cmp dist/configurable-containers-2607.0.101.xpi \
    /tmp/repro/dist/configurable-containers-2607.0.101.xpi && echo identical
```

`test/extension/package.test.ts` guards the same properties without the network round
trip. Note the test asserts the timestamp *recorded in the archive* rather than
comparing two builds — two builds land inside zip's two-second granularity and match
whether or not the mtimes were normalised, which made the obvious version a false green.

`tcp/` and `mac/` are git submodules and arrive as empty directories in the archive.
They are read-only upstream reference only; the build never touches them.

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
