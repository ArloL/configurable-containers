#!/usr/bin/env bash
# Fetch the Firefox builds the e2e suite needs, for a machine that has none.
#
#   ./scripts/get-firefox.sh              # both channels
#   ./scripts/get-firefox.sh latest       # just one
#
# Then run the suite against one of them:
#
#   FIREFOX_BIN=.firefox/latest/firefox npm test
#   FIREFOX_BIN=.firefox/esr/firefox npm test
#
# There is nothing else to install. geckodriver is fetched by Selenium Manager, which is
# bundled in selenium-webdriver and runs the first time a driver is built — the harness
# calls `new Builder().forBrowser("firefox")` and never looks for a geckodriver on PATH.
#
# The one prerequisite the suite has beyond a browser is a `mac/` checkout:
# test/e2e/mac-interop.test.ts builds MAC's xpi from `mac/src` unbuilt and FAILS rather
# than skips without it, with a bare ENOENT that reads like a broken case.
#
#   git clone --depth 1 https://github.com/mozilla/multi-account-containers.git mac
#
# Sandboxes: fetch from download.mozilla.org (which redirects to archive.mozilla.org).
# `ftp.mozilla.org` is a legacy alias that some network policies do not carry, and a 403
# from it is not evidence that Firefox cannot be downloaded — try these hosts before
# concluding the e2e levels cannot be run.
set -euo pipefail

dest="${FIREFOX_DIR:-.firefox}"
want="${1:-both}"

fetch() {
  local name="$1" product="$2"
  if [[ -x "$dest/$name/firefox" ]]; then
    echo "$name: already at $dest/$name/firefox ($("$dest/$name/firefox" --version))"
    return
  fi
  mkdir -p "$dest"
  echo "$name: downloading…"
  # --proto-redir as well as --proto: this url is a REDIRECTOR, and the browser it lands
  # on is installed and run. Pinning only the first hop leaves the hop that carries the
  # bytes free to be downgraded.
  curl --proto '=https' --proto-redir '=https' \
    --fail --silent --show-error --location --output "$dest/$name.tar.xz" \
    "https://download.mozilla.org/?product=$product&os=linux64&lang=en-US"
  # The archive unpacks to a directory called "firefox" whichever channel it is, so each
  # channel is unpacked on its own and moved into place.
  rm -rf "$dest/$name" "$dest/.unpack"
  mkdir -p "$dest/.unpack"
  tar xf "$dest/$name.tar.xz" -C "$dest/.unpack"
  mv "$dest/.unpack/firefox" "$dest/$name"
  rm -rf "$dest/.unpack" "$dest/$name.tar.xz"
  echo "$name: $("$dest/$name/firefox" --version)"
}

case "$want" in
  latest) fetch latest firefox-latest-ssl ;;
  esr) fetch esr firefox-esr-latest-ssl ;;
  both)
    fetch latest firefox-latest-ssl
    fetch esr firefox-esr-latest-ssl
    ;;
  *)
    echo "usage: $0 [latest|esr|both]" >&2
    exit 2
    ;;
esac

echo
echo "FIREFOX_BIN=$dest/latest/firefox npm test   # the channel ci.yml calls latest"
echo "FIREFOX_BIN=$dest/esr/firefox npm test      # the channel it calls latest-esr"
