# AMO listing

The copy itself lives in `amo/`, and is **pushed to AMO by the upload**, not pasted into
the Developer Hub:

| File | AMO field |
|---|---|
| `amo/summary.txt` | Summary |
| `amo/description.md` | Description (markdown) |
| `amo/reviewer-notes.txt` | "anything our reviewers should bear in mind" |

`scripts/amo-metadata.ts` turns them into the JSON `web-ext sign --amo-metadata` merges
into the submit body; `npm run submit` (listed) and `npm run sign:dev` (unlisted) each
write their own. **Editing the listing in the Developer Hub is undone by the next
release** — edit `amo/` instead.

Both channels get all three. The dev add-on is unlisted and displays none of the copy
publicly, and that is why it is sent there: every push to main writes it somewhere only
you can read, which is the one rehearsal before a listed release makes it public.

Three placeholders are substituted in the reviewer notes, and an unknown one throws
rather than shipping the braces:

| Placeholder | Value |
|---|---|
| `{{version}}` | the version being submitted |
| `{{timestamp}}` | `BUILD_TIMESTAMP`, the instant the xpi was packaged |
| `{{package_args}}` | `<version>`, plus `--dev` on the unlisted channel |

Not sent, ever: `name`, `categories`, `license`. They never change, they are mandatory at
add-on *creation* rather than per version, and a wrong value there is a rejected upload
rather than a bad paragraph. The description field takes
[markdown, not HTML][listing], and headings are not supported — section titles are bold
text. The summary is capped at **250 characters** (enforced in
`scripts/amo-metadata.ts`), but [AMO's guidance][listing] is to stay well under it.

## Other listing fields

| Field | Value |
|---|---|
| Category | Privacy & Security |
| License | MIT (matches `LICENSE`) |
| Data collection | None — mirrors `data_collection_permissions: { required: ["none"] }` in the manifest |

## Reproducibility check

Re-run before a submission if the build changes — it is what the reproducibility claim in
`amo/reviewer-notes.txt` rests on.
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

`tcp/` and `mac/` are gitignored checkouts, not submodules (there is no `.gitmodules`), so
`git archive HEAD` omits them entirely — not even an empty directory. They are read-only
upstream reference only; the build never touches them.

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
