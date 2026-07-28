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

## Notes for reviewer

Paste verbatim into the "Is there anything our reviewers should bear in mind?" field.
Verified against a real rebuild — see "Reproducibility check" below.

```text
BUILD INSTRUCTIONS

Needs Node 22+. From the root of the source archive:

    npm ci
    BUILD_TIMESTAMP=<value> npm run package -- <version>

<version> is the version in the submitted manifest.json. <value> is in that
version's release notes at
https://github.com/ArloL/configurable-containers/releases — zip stores mtimes, so
it is the one input the source cannot determine.

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

PRIVACY

Collects and transmits nothing — no analytics, no network requests of its own.
Manifest declares data_collection_permissions: { required: ["none"] }.
```

### Reproducibility check

Re-run before a submission if the build changes. It is what the claim above rests on.

```sh
TS=1785200000   # any fixed value; the release uses its build time
git archive --format=zip --output /tmp/src.zip HEAD
mkdir -p /tmp/repro && unzip -q /tmp/src.zip -d /tmp/repro
( cd /tmp/repro && npm ci && BUILD_TIMESTAMP=$TS npm run package -- 2607.0.101 )
BUILD_TIMESTAMP=$TS npm run package -- 2607.0.101
cmp dist/configurable-containers-2607.0.101.xpi \
    /tmp/repro/dist/configurable-containers-2607.0.101.xpi && echo "identical"
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
