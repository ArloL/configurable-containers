# Releasing

Read this before cutting a release, running `npm run sign:dev` or `npm run submit`, editing
anything under `amo/`, or touching the release workflows and
`scripts/{package,sign-dev,amo-metadata,dev-updates,verify-reproducible}.ts`.

The mistakes this file exists to prevent are the irreversible ones: GitHub releases here are
immutable, an upload publishes the AMO listing over whatever the Developer Hub had, and a
version derived from the clock owns the update channel for the rest of the month. None of
them can be taken back by a follow-up commit.

`docs/amo-listing.md` is the companion: what each `amo/` file maps to, the other listing
fields, and the reproducibility check a reviewer runs. This file is why those mechanisms are
shaped the way they are.

- **`npm run sign:dev` and `npm run submit` UPLOAD.** The credential guard is not a
  dry-run switch, and `npm` under mise carries AMO credentials even when a plain shell
  shows them unset. `sign:dev` takes its version from `VERSION`; to exercise only the
  build half, call `packageExtension` with the dev id. Both now also require
  `BUILD_TIMESTAMP`, because the reviewer notes they upload name it.
- **The AMO listing is PUSHED BY THE UPLOAD, so editing it in the Developer Hub is undone
  by the next release.** The copy is `amo/{summary.txt,description.md,reviewer-notes.txt}`;
  `scripts/amo-metadata.ts` fills its `{{version}}`/`{{timestamp}}`/`{{package_args}}`
  placeholders and both upload paths pass the result to `web-ext sign --amo-metadata`.
  Three things a change here gets wrong. Both channels get the same copy, and the dev
  one is not decoration — an unlisted add-on displays none of it, so the dev add-on's
  Developer Hub page is the only place the copy can be read BEFORE a listed release makes
  it public, and every push to main refreshes it. The cost is that a field AMO rejects
  fails `sign:dev` on every push to main, not on a release someone is watching, which
  is why the validation is in `buildAmoMetadata` rather than left to the API.
  `name`, `categories` and `license` are never sent: they are mandatory at add-on
  *creation* rather than per version, so a wrong value is a rejected upload rather than a
  bad paragraph. And an unknown `{{…}}` throws rather than shipping the braces — the
  hand-pasted notes this replaced told a reviewer to rebuild at `<version>` with
  `BUILD_TIMESTAMP=<value>`, which nobody substituted and which no checksum could match.

  **Every field the submit body carries has an AMO length cap, and the cap applies to the
  SUBSTITUTED text.** `AMO_FIELD_LIMITS` is the priced set — `summary` 250,
  `description` 15000, `approval_notes` 3000 — each read off the addons-server model field
  the API validates against (`addons/models.py`, `versions/models.py`), and it is an exact
  inventory rather than a bound: a fourth field added to the document without a row there
  fails `test/extension/amo-metadata.test.ts` instead of being learnt from a rejected
  upload, which is how `approval_notes` was learnt (the notes reached 4055 characters and
  every push to main failed at the upload, after the build had already succeeded). The
  substituted half is not a detail: `{{timestamp}}` is 13 characters of placeholder and 25
  of value, so a file measured as written sits under the cap while every upload of it is
  refused. The summary's cap is not the only thing it enforces — that field is a
  `NoURLsField`, whose cleaner runs `URL_RE.sub("", …)` and stores the remainder, so a link
  pasted there is not an error anyone would see: it is a sentence with a hole in it on the
  public listing, published by an upload that reported success.

  Because that upload happens on **every push to main**, prose in `amo/` that has gone
  stale is drift that gets PUBLISHED rather than merely sitting in the repo — so the four
  claims most worth keeping honest are pinned rather than reviewed:
  `test/extension/amo-metadata.test.ts` holds the PERMISSIONS bullets to an exact set
  against `extensions/cc/manifest.json`, the storage bullet to every area `src/` reaches,
  the Node version to what the workflows really set, and `description.md`'s privacy
  paragraph to whether `src/` still writes to `storage.sync`. Each case carries the drift
  it was written for; all four are exact in BOTH directions, because a bullet outliving
  its permission tells a reviewer the add-on asks for something it does not. Add a claim
  to `amo/` and the question is whether it can join them — a hand-read is what let all
  four of these ship.
- **Never derive a dev version from the clock** — `YYMM.DD.HHMM` outranks every
  `YYMM.0.<micro>` for the rest of the month, so one local build would own the update
  channel. Nothing enforces this; it is a rule for whoever sets `VERSION`.
- **AMO REPACKS uploads**, so its copy is never byte-comparable with a local rebuild
  (sorted entries + fixed 1980 mtime here, filesystem order + real mtimes there). Verify
  reproducibility against the GitHub release asset and that release's
  `BUILD_TIMESTAMP`.
- **A listed version is signed at APPROVAL, not upload** — in the queue it downloads back
  without `META-INF/`, so nothing is permanently installable. Unlisted signs in minutes:
  `unreviewed` → `public`, +~10KB, `file.url` flips `.zip` → `.xpi`.
- **`update_url` is legal unlisted and REJECTED listed**, and must be stamped *before*
  signing (it lives inside the signed manifest), so a build shipped without one can never
  learn about its successors. `package.test.ts` asserts both directions.
- **Both channels share ONE tag sequence — the `prerelease` flag distinguishes them, not
  the tag.** `scripts/dev-updates.js` filters on it; a tag prefix matches nothing, and
  matching everything pushes the *listed* xpi to dev users under the dev add-on's id.
  The other half of sharing a sequence: the dev channel BURIES a listed release in the
  release list within days, so anything looking for one must page rather than read a
  window. `verify-reproducible.ts` asked for the newest 20 and passed nightly for four
  weeks announcing "No listed release yet" while `v2608.0.112` sat 32 releases down. Its
  `findLatestListedRelease` pages until one turns up and throws when the page cap runs
  out, because "I stopped looking" reported as "there is nothing to check" is what made
  that gate inert.
- **Both channels publish the SAME THREE artefacts** — the reproducible pre-signing xpi,
  the source archive, and `BUILD_TIMESTAMP` in the notes — so one job verifies either and
  `verify-release.yaml` needs no branch. A dev release carries a fourth, the AMO-signed
  xpi Firefox actually installs, and that one must stay distinguishable by name:
  `dev-updates.js` picks the signed asset by excluding `configurable-containers-<v>.xpi`,
  and its old `.endsWith(".xpi")` would have offered the *unsigned* build to every
  dogfooder — uninstallable, silent, and permanent on an immutable release.
- **Those two reproducible artefacts also carry SLSA provenance, which answers a different
  question from the hash check.** `verify-release.yaml` proves the xpi matches the source
  archive published beside it; a release built by hand, from a tree that never existed in
  git, satisfies that perfectly. `actions/attest-build-provenance` (both publishing paths,
  job-level `id-token: write` + `attestations: write`) signs a statement naming the
  workflow, the run and the commit, and the verify job compares that commit with the
  tag's own — `gh attestation verify` alone only says "a workflow in this repo", so the
  digest comparison is the check and the signature is not. Two things it deliberately does
  not cover: the AMO-signed xpi, since AMO repacks and the file Firefox installs is
  byte-comparable with nothing that was attested, and the honesty of the source, since
  provenance says where a build came from and never what is in it. The release notes
  publish the verify command, which makes it a promise —
  `test/fitness/release-provenance.test.ts` is what keeps a third publishing path from
  quietly not making it. A release cut before this existed fails the check by design.
- **AMO's source requirement follows the BUNDLE, not the channel, so `sign:dev` uploads it
  too.** It is triggered by shipping code a reviewer cannot read (`background.js` is an
  esbuild bundle) and unlisted add-ons are "subject to be manually reviewed at any time
  after submission" — so "nothing complained" only means nobody has looked yet, and what
  they would find is a dev add-on already installed on dogfooders' profiles. The GitHub
  asset satisfies none of it; `--upload-source-code` does, and `scripts/sign-dev.ts` builds
  the archive itself rather than taking a path from the workflow, so no upload path can
  skip it. It is safe on a path that runs on every push to main because attaching
  source does not delay unlisted signing: in addons-server, source creates a
  `NeedsHumanReview` only for a version *already pending rejection*
  (`Version.flag_if_sources_were_provided`), and none of `AutoApprovalSummary`'s checks
  reads it — it is a reviewer *queue flag*, not an auto-approval blocker. web-ext PATCHes
  the source on after creating the version, then polls for `public` with a 15-minute
  timeout, which is the thing that would break if that were ever to change.
- **What is NOT symmetric is the add-on itself, and it cannot be.** A dev build has its own
  id (so it installs beside the listed one with its own `storage.local`), its own name, and
  the `update_url` AMO rejects on a listed submission. So a dev release's notes publish
  `npm run package -- <version> --dev`, and `planFor` passes that flag; rebuilding a
  prerelease without it produces the listed identity and a hash mismatch that reads as
  "this release does not reproduce".
- **A release published with `GITHUB_TOKEN` triggers NO workflow**, so `on: release` is a
  dead trigger for every release this repo cuts — GitHub suppresses those events to stop
  workflows recursing. Proof rather than folklore: `publish-dev-manifest.yml` has declared
  `on: release: [published]` since July and has one run ever, a manual dispatch, across
  ~150 releases; it works only because `ci.yml` *calls* it. `verify-release.yaml` is wired
  the same way — `workflow_call` with the tag as an input, invoked by `ci.yml` and
  `release.yaml` after they publish — and keeps `on: release` only for a release a person
  creates in the UI, which does fire.
- **GitHub immutable releases are ENABLED**: assets can't be edited, so the dev xpi ships
  in the same `gh release create`, and a rollback is *deleting* a release plus
  republishing the manifest.
- **`npm audit` is loud and `npm run audit` (`--omit=dev`) is the one that means anything,
  and it gates every push.** The
  xpi is an esbuild bundle of `src/`, so no `node_modules` package ships and every current
  advisory is transitive dev tooling with no upstream fix (`image-size` under
  `addons-linter`, `brace-expansion` under two `minimatch` lines, `nanoid`, `qs`). `npm
  audit fix` advertises a fix and changes nothing — check its `--dry-run` first. Don't
  silence any of it with `overrides`: forcing a transitive dev dependency past what its
  dependent declares is a standing compatibility risk taken for a warning no user sees.
  After any change here `npm run lint:ext` is the check that matters — web-ext is the only
  thing that consumes these packages.
