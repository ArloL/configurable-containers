---
name: firefox-is-obtainable-in-a-sandbox
description: "A sandbox with no Firefox can still get one — run scripts/get-firefox.sh before concluding the e2e levels cannot be run"
metadata: 
  node_type: memory
  type: project
---

**Do not conclude that L4/L5 cannot be run here.** That conclusion has been reached wrongly
in more than one session, and each time it silently dropped the only levels that see a real
browser — leaving changes to `supersede`, `browser-port` and the engine's effects verified
by nothing but a mock.

Run **`./scripts/get-firefox.sh`**. It fetches both channels into `.firefox/`, takes a few
seconds, and then:

```
git clone --depth 1 https://github.com/mozilla/multi-account-containers.git mac
FIREFOX_BIN=.firefox/latest/firefox npm test
FIREFOX_BIN=.firefox/esr/firefox npm test
```

The full suite is ~150s per channel.

**What made this look impossible, and why it was wrong:**

- `ftp.mozilla.org` returns 403 through the agent proxy. It is a legacy alias, and a
  network policy that omits it says nothing about the hosts that actually serve builds:
  **`download.mozilla.org`** (302, redirects to **`archive.mozilla.org`**, 200) is where
  `get-firefox.sh` fetches from. Probe the specific host before concluding anything.
- geckodriver looked like a second blocker. It is not: **Selenium Manager** ships inside
  `selenium-webdriver` and fetches it the first time `new Builder().forBrowser("firefox")`
  runs, so there is nothing to install and nothing on PATH to arrange.
- **Always set `FIREFOX_BIN`.** Without it Selenium Manager goes and downloads Firefox
  itself — from `ftp.mozilla.org`, the one blocked host — and the failure reads
  `Unable to obtain browser driver`, which looks like a geckodriver problem and is not.
  That is very likely what made this look impossible in the first place.
- `mac/` is gitignored and absent from a fresh clone, and `mac-interop.test.ts` **fails
  rather than skips** without it, with a bare ENOENT that reads like a broken case rather
  than a missing checkout.

**How to apply:** when a task touches `src/engine`, `harness/`, or anything whose behaviour
is a Firefox fact, get a Firefox and run the suite rather than reporting L4/L5 as
unverifiable. If a download genuinely is blocked, say which host and what the status code
was — "no Firefox here" on its own has been wrong every time so far.
