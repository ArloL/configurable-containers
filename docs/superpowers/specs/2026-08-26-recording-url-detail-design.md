# Recording URL detail — Design

**Date:** 2026-08-26
**Status:** Implemented
**Topic:** A pause recording keeps the URL of each hop, not only its host — as a ready-made
`match:` pattern, with the method, and with the host row saying when its URLs did not all
resolve the same way. Revisits the deferral in
[`2026-08-01-pause-and-record-design.md`](2026-08-01-pause-and-record-design.md) §4.2.

## 1. Why now

§4.2 of the pause spec deferred paths with a stated condition:

> **Hosts only; no path, no query.** … The host is also already the granularity a rule is
> written at (`match:` is host-shorthand in the common case), so the trim costs nothing
> today. Accepted cost, stated so a future reader knows it was chosen: a path-based rule
> cannot be written from a recording. Revisit alongside path/regex matching becoming
> routine.

Match patterns and regexes landed in
[`2026-08-19-match-patterns-and-regex-design.md`](2026-08-19-match-patterns-and-regex-design.md),
so the premise no longer holds: `match:` is written at a URL whenever part of a site has to
be routed differently from the rest of it. The reported case is a GitHub OAuth hand-off —
`github.com` belongs in a permanent container, but `github.com/login/oauth/…` must stay
where the sign-in started, or the tab lands in the wrong place mid-authorization. A
recording that says only `github.com` cannot tell those two apart, and the user is back to
`network.http.redirection-limit=0` for the half of the answer the record dropped.

The trim is now the more expensive side: the record answers a question the config can act
on at a granularity the config no longer uses.

### Still out of scope

- **Query strings.** §9's reasoning is untouched by URL matching: a payment or OAuth query
  is where the session token and the authorization code live, and this record is written to
  `storage.local` during a checkout and offered for copying afterwards. A pattern's trailing
  `*` covers the query without storing it (§3), so nothing is lost but the secret.
- **Any rule proposal.** Unchanged from §1 of the pause spec. The record copies a `match:`
  value; choosing between `inherit`, `ignore` and `open:` stays the user's, and the row says
  what CC *would have done*, never what the user should write.
- **Always-on recording.** Unchanged; the arm-before model is what keeps the record from
  being a permanent journal of visited hosts, and a per-URL journal would be worse.

## 2. What a row says

A recording is still a list of hosts in first-seen order. Each host row now carries a list
of `RecordedUrl`s, also first-seen:

| Field | Meaning |
|---|---|
| `pattern` | The `match:` value for that URL — `*://github.com/login/oauth/authorize*` |
| `hits` | Hops that produced this pattern |
| `methods` | Distinct methods, first-seen |
| `wouldHave` | The declined action **at this URL**, in the F9 toast's words |

Three decisions inside that table:

- **The row stores the pattern, not the raw path.** It is the text the Copy button puts on
  the clipboard and the text the label shows, so deriving it twice — once to store, once to
  render — is two things to keep in step for no gain. It also means the query is dropped at
  the point of recording rather than at the point of display: nothing writes a token to
  disk and then declines to show it.
- **`methods` is kept because a POST is the hop no rule can move.** `tabs.create` issues a
  GET, so a `reopen` for a request with a body is declined (F9) however right the rule is.
  A record that shows `POST` on the row is the difference between "I wrote the rule and it
  still broke" and knowing the rule there has to be `inherit`/`ignore`. A top-level
  navigation is a GET unless a form posted it, so the list is two entries long at worst.
- **`wouldHave` is per URL as well as per host,** because that is the whole point: with path
  matching, `github.com` genuinely resolves two ways.

### 2.1 A host row that no longer has one answer

Before path matching a host had exactly one counterfactual. Now it may not, and a host row
still claiming one of the two is the silent wrong answer this codebase exists to avoid — it
would send the reader to write the rule that breaks the sign-in. So when a second URL at a
host resolves differently, the host row's `wouldHave` becomes `varies by URL` and the URL
rows below it carry the two answers. It is computed as hops arrive, not at render time: the
options page has no test below L4 (CLAUDE.md, and §5.2 of the pause spec), and this is a
judgement, not a layout.

## 3. `patternForUrl`, and why it is in the matcher

The URL → pattern step lives in `src/matcher/matcher.ts`, beside `matcherToPatterns`, which
is the same question in the other direction. Two consequences, both wanted:

- It is inside the **mutation gate** (`stryker.config.mjs` mutates the five pure modules),
  so every branch of it needs a case in `test/matcher/`.
- It can be **property-tested against `matches()`**: a pattern built from a URL parses
  through `patternMatcher` and answers `true` for the URL it came from, and matches no other
  host. Those two properties are the promise the Copy button makes, and neither is checkable
  from the string alone.

Four narrowings, each of which the obvious version gets wrong:

- **`*://`, not the scheme observed.** HSTS rewrites the scheme before webRequest is told
  about the navigation (CLAUDE.md), so which one a recording caught is an accident of when
  the upgrade landed. `*` is http+https, which is what the bare-host shorthand means too,
  and it also stops an http and an https hop at one path becoming two rows.
- **The host loses its port.** A match pattern's host cannot carry one, and CC does not
  match on it either — `https://company.com:8443/` matches `company.com`. The host row keeps
  the port, since it is what identifies the tab in a local flow.
- **A trailing `*`, which is the query.** A pattern's path is anchored at both ends, so
  `/login/oauth/authorize` alone does not answer `/login/oauth/authorize?client_id=…` —
  which is every OAuth entry point there is. This is what lets the query be dropped and the
  rule still work.
- **`null` rather than a string that will not parse.** An IPv6 literal cannot be a pattern's
  host (`canonicalHost` refuses the colons), so the URL row is skipped and the host row
  still counts the hop. A row whose text the config editor would reject is a Copy button
  that lies.

A literal `*` in a path becomes a wildcard, because a match pattern has no escape for one.
That widens the result at that host and cannot be prevented — which is the second reason the
row shows the pattern it copies rather than deriving it out of sight.

The path is truncated at `MAX_PATTERN_PATH` (200). Truncation only ever widens the result —
a prefix plus the trailing `*` still matches the URL it came from — and it bounds a string
written to disk on every navigation of an armed container.

## 4. The second cap

`MAX_RECORDED_HOSTS` and `Recording.dropped` landed the same day, from the FOLLOWUPS sweep
that found `Recording.hosts` uncapped and invisible to `test/fitness/retained-state.test.ts`
(which scanned for `Set`/`Map`, and it is an array). URL rows need the same treatment one
level down, and need it more: a host row is one per host a flow touches — a handful — while a
URL row grows with **browsing**. Fifty pages read at one site is fifty rows, where the host
is still one. So `MAX_RECORDED_URLS_PER_HOST` (20) caps the list under each host, and URLs
past it are **counted into that host row's own `dropped`**, for the same reason the recording
counts hosts rather than truncating in silence: rules are written from these rows, and a list
a reader takes for everything CC saw at a host, while it quietly is not, is what a
path-scoped rule then gets written against. Hops past the cap still count at the host, so
`×N` does not lie either.

Twenty is well above the few paths a payment or SSO chain touches at any one host, and being
far below the host cap is deliberate: reaching it means the recording has started describing
browsing rather than the flow the user armed for.

The count is written through **once**, on the hop that first reaches the cap, and not again:
every write here comes off the blocking path, and a capped recording that still wrote per
navigation would cost the most in exactly the session that overran it. That generalizes the
rule the host rows already followed — a write happens only when something a reader would
notice changed (a new host, a new URL, a method not seen at that URL, a cap first reached, a
host's answer becoming `varies by URL`) — and `disarm` still flushes the counters.

The fitness inventory sees `urls` (the widened scan reads a field initialised empty in an
object literal), so it carries a row of its own naming this bound.

## 5. Reading back an older recording

A recording written before this change has host rows with no `urls`. That is ordinary state
on a user's disk, not corruption, so hydration **normalizes** rather than only validating:
`readRecording` / `readHost` / `readUrl` rebuild each level, fill the new fields in, and drop
only what is genuinely the wrong shape.

This replaces the `isRecording` type guard, which checked the top level and let the rows
through unread — a distinction that did not matter while a row was three scalars and does
now. `record()` calls `.find` on `row.urls` **inside the blocking handler**, where a throw is
a navigation that never completes, and the options page maps over it. Leniency alone — the
optional-key-plus-`?? []` shape `Recording.dropped` uses — would have meant reaching for that
fallback at every use and getting it right every time; normalizing once means `urls` can be
required in the type.

`Recording.dropped` stays optional and lenient as it was: it is a plain number, the key a
pre-cap recording lacks, and nothing dereferences it.

## 6. Testing

- **L2 (`test/matcher/`)**: `patternForUrl` — the host+path case, the dropped query, the
  `*://` scheme, canonicalization and the dropped port, the bare-URL root path, `null` for
  a non-http(s) URL and for a host with no pattern form, and truncation. Two fast-check
  properties: parses-and-matches, and matches-no-other-host. The gate is at 100% for this
  file (measured).
- **L1/L3 (`test/engine/pause.test.ts`)**: URL rows recorded with their method; a bounce
  collapsing at both levels; a host whose URLs disagree becoming `varies by URL`, and one
  whose URLs agree not; the query absent from storage while the path is present; the
  per-host cap, its count, and the one-write property; hydration of a pre-URL recording
  (upgraded, not dropped) and of a malformed row.
- **L3 (`test/engine/engine.test.ts`)**: the engine hands the recorder the whole navigation,
  method included.
- **L4 (`test/e2e/pause.test.ts`)**: the existing arm → record → review case gains step 7 —
  the URL row appears under the host, without the port, without the cache-buster query, with
  its method.

`test/engine/mock-port.ts` gains a `storageWrites` counter. What the recorder does **not**
write is part of its contract, and counting is the only way to assert a write did not
happen: the value written is the same either way.

## 7. Decisions taken, with the alternatives rejected

- **Store the pattern, render the pattern.** The alternative — store the path, build the
  pattern in `options.ts` — puts the derivation on the one surface with no test below L4 and
  splits it from the recording that has to agree with it.
- **Nest URL rows under host rows, rather than flattening to one row per URL.** The host
  collapse is the substantive improvement over the `redirection-limit=0` workaround (pause
  spec §4.2) and a flat list gives it back. Nesting keeps "which hosts did this flow touch"
  readable at a glance, with the detail one indent down.
- **Show the method on every row, not only on a POST.** "GET" on most rows is the background
  against which the POST stands out; a row that shows a method only sometimes reads as a
  rendering accident.
- **A second cap in the shape of the first, not a reuse of it.** One cap over the total
  number of URL rows in a recording would let a single chatty host consume the whole budget
  and hide every later host's paths. Per host, it bounds the thing that actually grows.
- **Normalize on hydrate, rather than making `urls` optional and defaulting at each use.**
  The optional-key shape works for `Recording.dropped`, which nothing dereferences. `urls`
  is read in the blocking handler and mapped over in the options page, and a fallback that
  has to be remembered at every use is one that will not be.
