# Follow-ups

Things deliberately left in a state that needs re-checking later, with what to
check and what would let us drop them. Delete an entry once it is resolved.

## `overrides` in package.json — dev-dependency security fixes (2026-07-28)

```json
"overrides": {
  "adm-zip": "^0.6.0",
  "shell-quote": "^1.9.0"
}
```

Both clear Dependabot alerts on transitive **dev** dependencies of `web-ext`
(nothing here ships: `npm audit --omit=dev` is clean, and the xpi is an esbuild
bundle of `src/` with no `node_modules`):

| package | advisory | pinned by |
| --- | --- | --- |
| `adm-zip` `<0.6.0` | crafted ZIP triggers a 4GB allocation | `firefox-profile` asks for `~0.5.x` |
| `shell-quote` `<=1.8.4` | quadratic-complexity DoS in `parse()` | `fx-runner` pins exactly `1.8.4` |

An override forces a version its own dependents never declared support for, so
it is a standing risk, not a fix — `firefox-profile` was written against
`adm-zip` 0.5.

**Re-check when `web-ext` publishes a release past 10.5.0.** If it ships
`firefox-profile`/`fx-runner` versions that already ask for the patched
packages, delete the override and let the tree resolve normally.

Verify after any change here:

```
npm ls adm-zip shell-quote     # expect 0.6.x and >=1.9
npm audit --omit=dev           # expect 0 vulnerabilities
npm run lint:ext               # web-ext lint — the tool these packages belong to
```

### Known, not overridden

`npm audit` reports 8 high advisories rooted in `brace-expansion`, reached via
`eslint → addons-linter → web-ext`. The installed `1.1.16` is the newest `1.x`
that exists and the advisory flagging it (`<= 5.0.7`) is only fixed in `5.0.8`,
which `minimatch@3` cannot take — forcing it breaks the linter to silence a
dev-only warning. GitHub raises no Dependabot alert for it. Re-check if
`addons-linter` moves to a `minimatch` major that carries `brace-expansion` 5.
