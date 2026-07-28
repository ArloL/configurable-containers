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
The build instructions below were verified by extracting the source archive
(`git archive --format=zip HEAD`), running them in a clean directory, and comparing the
result file-by-file against the submitted package — see "Reproducibility check" after
the block.

```text
BUILD INSTRUCTIONS

Environment: any OS with Node.js and npm. Node 22 or newer; the reviewer default
(Node 24.14.0 / npm 11.9.0 on Ubuntu 24.04) works. No system dependencies beyond
Node — the end-to-end tests need Firefox, but building does not. All build tools
are open source, installed from npm, and run locally: esbuild (bundler) and tsx
(TypeScript runner). package-lock.json is included.

From the root of the source archive:

    npm ci
    npm run package -- VERSION

replacing VERSION with the version string in the submitted manifest.json. This
writes dist/configurable-containers-VERSION.xpi and the unpacked build in dist/cc/.

COMPARING THE RESULT

The .xpi is a zip archive, and zip records file modification times, so the checksum
of the .xpi file itself will NOT match. The contents are identical. Please compare
the extracted files:

    background.js  options.js  choice.js  manifest.json  options.html  choice.html

All six are byte-identical between a build from this source archive and the
submitted package.

Only background.js, options.js and choice.js are generated: esbuild bundles three
TypeScript entry points into three classic scripts. Output is NOT minified.
manifest.json, options.html and choice.html are copied verbatim from extensions/cc/.
scripts/package.ts stages extensions/cc/ into dist/cc/ and stamps the version there,
which is why manifest.json in the source tree carries a placeholder version.

PERMISSIONS AND WHY EACH IS NEEDED

- webRequest, webRequestBlocking, <all_urls> — the core mechanism. A blocking
  webRequest.onBeforeRequest listener on main_frame decides which container a
  navigation belongs in; when it belongs in a different one, the request is
  cancelled and the tab reopened in the target container. It has to be blocking
  because the decision must happen before the request proceeds. <all_urls> because
  the user's configuration may route any domain.
- contextualIdentities — create, query and remove containers.
- cookies — required by Firefox for tabs.create({ cookieStoreId }); without it
  every container reopen throws "No permission for cookieStoreId". Also used by the
  optional per-site cookie-seeding feature.
- tabs — create, remove and update tabs when moving a navigation into a container.
- storage — stores the user's configuration. storage.local only.

USER-CONFIGURED CONTENT SCRIPTS — PLEASE NOTE

The configuration format has an optional "scripts" key. If a user adds one, the
add-on calls browser.contentScripts.register() with the JavaScript string from
their own configuration so it runs on the domains they specified. This is why
src/engine/script-injector.ts registers a content script from a code string.

That code comes only from the user's own configuration in storage.local. It is
never fetched from the network. There is no remote code execution anywhere in the
add-on: no eval, no new Function, no remotely loaded scripts. The default
configuration that ships with the add-on contains no "scripts" entries.

PRIVACY

The add-on collects and transmits nothing. There is no analytics or telemetry, and
it makes no network requests of its own. The only stored data is the user's
configuration in storage.local. The manifest declares
data_collection_permissions: { required: ["none"] }.

WHAT IT DOES

Routes each site into a Firefox container according to a single YAML configuration
the user edits in the add-on's options page. Anything no rule matches opens in a
fresh temporary container. The shipped default configuration contains 18 rules,
all of them exemptions (inherit / redirector / ignore) — it routes nothing into a
named container.
```

### Reproducibility check

Re-run this before a submission if the build changes. It is what the claim above rests on.

```sh
git archive --format=zip --output /tmp/src.zip HEAD
mkdir -p /tmp/repro && unzip -q /tmp/src.zip -d /tmp/repro
( cd /tmp/repro && npm ci && npm run package -- 2607.0.101 )
npm run package -- 2607.0.101
for f in background.js options.js choice.js manifest.json options.html choice.html; do
  diff -q "dist/cc/$f" "/tmp/repro/dist/cc/$f" || echo "DIFFERS: $f"
done
```

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
