# Configurable Containers

One config to route every site to the right container.

It combines the two things Firefox's container ecosystem does separately today —
persistent, named identity containers (like **Multi-Account Containers**) and
disposable, auto-created ones (like **Temporary Containers**) — and puts a
single, user-defined configuration in charge of both.

You describe, in one place, how domains should map to containers. Configurable
Containers does the rest: routing each site into the right permanent container,
spinning up a temporary one when nothing matches, and keeping single-sign-on
flows from breaking along the way.

## Goals

- **Domain → container mapping.** Declare which domains open in which
  container — the feature Multi-Account Containers is most missing.
- **Minimal ceremony.** The common case is one line: a bare domain opens a
  container named after it. You add detail only when you want something
  other than the default — a curated name, several domains sharing one
  container (named after the first), or a choice between containers.
- **One text-edited config.** Everything lives in a single file, edited as
  text through a built-in editor. There is no form-based settings UI to
  click through, and the config only *routes* — it never owns container
  lifecycle. Containers are created on demand by name; ones no rule
  mentions are left untouched.
- **A management overview.** See and manage many containers at a glance, without
  the friction of MAC's current UI.
- **SSO that just works.** Make single-sign-on providers painless to use within
  permanent containers, instead of the fiddly setup Temporary Containers Plus
  requires.
- **Temporary by default, permanent by choice.** Anything no rule matches
  opens in a fresh throwaway container; long-lived named containers are
  opt-in, one rule at a time.
- **Continuity without leakage.** Isolation-continuity groups keep related
  sites in the same throwaway as you move between them, while crossing to
  an unrelated site still spins up a clean container — disposable sessions
  that survive a redirect but never bleed across a real boundary.

## Configuration

How domains map to containers is defined in a single user configuration. See
[CONFIG.md](CONFIG.md) for the design.

## Status

Early exploration — a personal tool first. Built on Firefox's container APIs for
now, with the door left open to other browsers later.
