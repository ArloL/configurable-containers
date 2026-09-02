# Static analysis

Read this before changing lint configuration, answering a SonarCloud finding, adding a
suppression, or editing a workflow — `.oxlintrc.json`, `sonar-project.properties`,
`.github/workflows/check-actions.yaml`, or any `oxlint-disable` / `Stryker disable` /
`v8 ignore` comment.

The gates themselves run on every push, so a session that merely writes code meets them as
a red build with its own message. What is here is the part no failure explains: why the
obvious tool is the wrong one, which three rules are off and which of them is off because
it is wrong about this code, and the two suppressions whose advice would break the build if
taken.

- **`typescript@7` is the Go port, and it exports no JS compiler API** — the package's
  `exports` are `lib/version.cjs` plus `unstable/*`. typescript-eslint builds every
  type-aware rule on the API that is gone, so making it work means resolving a second
  TypeScript 5 for the linter alone and letting lint and `npm run typecheck` disagree
  about the language. `oxlint` + `oxlint-tsgolint` reads types through tsgo — the same
  compiler `npm run typecheck` runs. Type-aware rules only fire with `--type-aware`; the
  `lint` script passes it, and `--deny-warnings`, because a rule that only warns is a rule
  nobody fixes.
- **Three rules are off and one of them is off because it is WRONG about this code.**
  `unicorn/no-useless-spread` flags `[...armed]` in `pause` and `[...live]` in the reaper;
  both loop bodies (`disarm`, `reapProfile`) delete from the collection being iterated, so
  taking its advice introduces the bug. `typescript/unbound-method` has no true positive
  here — the two classes in `src/` are `Error` subclasses with no methods, so no method is
  ever passed as a value.
  `no-unnecessary-condition` is off for `test/**` only: the mock builds states the types
  call impossible on purpose, while in `src/` the same rule is a dead-defence detector.
- **A suppression comment disables the line after the DIRECTIVE, not after the reason.**
  `// oxlint-disable-next-line <rule> -- because…` spanning three lines suppresses the
  second comment line and nothing else, silently. Put the prose above and the directive
  immediately over the code. Stryker is the other way round and the two rules must not
  be swapped: its `next-line` binds to the start line of the *node* the comment leads
  (`@stryker-mutator/instrumenter`, `directive-bookkeeper.js`), so the multi-line reasons
  in `config/parse.ts` reach the code below them and "fixing" them would be a no-op at best.
- **`lint` passes `--report-unused-disable-directives`**, so an `oxlint-disable` for a rule
  this config does not enable fails the build instead of outliving whoever wrote it. It
  found one on the push that added the flag: a `typescript/no-explicit-any` directive over
  the `declare module "vitest"` merge, where the rule is pedantic and has never been on.
- **The workflows have their own two gates — `actionlint` and `zizmor`** (`check-actions.yaml`),
  and zizmor fails the build on any finding. There are no zizmor suppressions, and its
  `cache-poisoning` finding on a release trigger is the reason: the fix is real, not an
  ignore. `actions/setup-node` caches BY DEFAULT — `package-manager-cache` defaults to
  `true` and turns caching on as soon as `package.json` declares `packageManager` or
  `devEngines.packageManager` — so omitting `cache:` disables nothing, and a suppression
  would go on lying the day that field is added. Both verifiers
  (`verify-release.yaml`, `nightly.yaml`'s reproducible-build) therefore pass
  `package-manager-cache: false`: a job deciding whether a published artefact is
  trustworthy must not install from a mutable cache an earlier run could have poisoned, or
  a tampered build gets certified reproducible. zizmor only reports the pairing on a
  publishing trigger, so the nightly's half was never going to be flagged.
- **A SonarCloud finding is answered in `sonar-project.properties`, never in the web UI.**
  Resolving one as "won't fix" there is what the service invites and it loses the only part
  worth keeping: the reasoning, where a reviewer would see it, in a project that can be
  recreated. Suppression is per rule and path
  (`sonar.issue.ignore.multicriteria.<id>.{ruleKey,resourceKey}`), and each id in that file
  carries the comment saying why. Unlike zizmor — which has no suppressions on purpose —
  a few of these rules are simply wrong about this code, and one of them is wrong in the
  direction that matters: `S2871` asks for `localeCompare` behind the `.sort()` in
  `scripts/package.ts`, and taking that advice breaks reproducible builds, since that sort
  is what makes the xpi's entry order the same on every machine and collation is not. The
  other two are `S4036` (absolute paths for `git`/`gh`/`npm`/`curl` in dev scripts) and
  `S5332` (the `"http://" + hostish + "/"` in `bareHost`, which parses a string and fetches
  nothing). Everything else gets fixed.
- **`?? ""` on a `spawnSync().stdout` is not a dead defence**, whatever the types say:
  `@types/node` declares `string` once an encoding is set, and a spawn that never started
  reports null — which is the case `harness/reaper.ts` exists for. Both sites carry a
  suppression rather than a "fix".
- **`exactOptionalPropertyTypes` draws a real line at the port seam.** A property mapped
  *out* of a browser object carries `| undefined` because Firefox sets it that way;
  `CreateTabProps.url` does not, because absent and `undefined` are different requests
  and only one of them lands on the new-tab page. Keep the two call sites spreading the
  key in conditionally rather than passing `url: undefined` and trusting Firefox's
  tolerance.
