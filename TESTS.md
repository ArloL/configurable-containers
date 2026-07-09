# Behaviour scenarios

BDD-style scenarios describing the intended behaviour of the resolution engine,
for reviewing edge cases before implementation. See [CONFIG.md](CONFIG.md) for the
model these exercise. Every scenario runs against the one example config below.

The Gherkin notation here is **spec notation only** — the scenarios are
implemented as plain BDD-style test code (one test per scenario, named after its
title), not executed by a Gherkin/cucumber runner. See
[TESTING.md](TESTING.md#l5--acceptance-testsmd-as-bdd-test-code).

## Example config

```yaml
rules:
  # Container-less: stay in the initiating container.
  - match: accounts.google.com
    inherit: true
  - match: login.company.com
    inherit: true

  # Ignored: engine does nothing; tab left as-is.
  - match: getpocket.com
    ignore: true

  # Redirector shim: hop not isolated; auto-closed only if left stranded.
  - match: t.co
    redirector: true

  # Auto-named: container name = the matched host.
  - match: bandcamp.com

  # Curated single-container name.
  - match: mail.google.com
    open: Gmail

  # Multiple hosts, one container.
  - match: [deutschepost.de, dhl.com]
    open: DHL

  # Multi-container, auto-default.
  - match: trello.com
    open: [Personal, Work]
    default: Work

  # Multi-container, no default -> choice screen.
  - match: figma.com
    open: [Personal, Work]

  # Temporary by default, escalatable, reopen restricted; seeded cookie overlay.
  - match: youtube.com
    open: [Temporary, Personal]
    default: Temporary
    cookies:
      - { name: wide, url: "https://www.youtube.com/", value: "1" }

  # Temporary via rule, member of NO group: continuity comes from same-site only.
  - match: pinterest.com
    open: Temporary

# Isolation-continuity groups: separate top-level list, order-significant,
# first-match wins, a URL resolves to at most one group. NOTE youtube.com also
# appears in a rule above; the two lists are independent.
groups:
  - [google.com, google.de, youtube.com]
```

---

## Feature: Temporary by default

```gherkin
Scenario: An unmatched site opens in a temporary container
  Given a blank tab
  When I navigate to reddit.com
  Then the tab opens in a new temporary container

Scenario: Two blank tabs to the same unmatched site are isolated
  Given two blank tabs
  When I navigate both to reddit.com
  Then each tab opens in its own separate temporary container
  And the two containers share no cookies

Scenario: A temporary container is disposed after its last tab closes
  Given a temporary container T with exactly one open tab
  When I close that tab
  Then T is removed 15 minutes later
  And its cookies are gone
```

## Feature: Same-site continuity (temporary path)

```gherkin
Scenario: Navigating within the same site keeps the temporary container
  Given I am on reddit.com in temporary container T
  When I click a link to old.reddit.com
  Then I stay in T
  And no new temporary container is created

Scenario: Navigating to a different site isolates into a new container
  Given I am on reddit.com in temporary container T
  When I click a link to imgur.com
  Then a new temporary container is created
  And I leave T
```

## Feature: Rule enforcement (mechanism 1)

```gherkin
Scenario: A matched site always opens in its container
  Given a blank tab
  When I navigate to mail.google.com
  Then the tab opens in the Gmail container

Scenario: Rule enforcement overrides same-site continuity
  Given I am on www.google.com in temporary container T
    # www.google.com is unmatched -> temporary
  When I navigate to mail.google.com
  Then the tab switches to the Gmail container
  And I do NOT stay in T, despite the shared registrable domain google.com

Scenario: A multi-host rule routes every host to one container
  When I navigate to deutschepost.de
  Then the tab opens in the DHL container
  When I then navigate to dhl.com
  Then I stay in the DHL container
```

## Feature: Auto-named containers

```gherkin
Scenario: A bare match opens a container named after the host
  When I navigate to bandcamp.com
  Then the tab opens in a container named "bandcamp.com"

Scenario: The shorthand covers subdomains
  When I navigate to anartist.bandcamp.com
  Then the tab opens in the same "bandcamp.com" container

Scenario: A multi-host match is named after the first host
  When I navigate to notion.com
  Then the tab opens in a container named "notion.com"
  When I then navigate to notion.so
  Then I stay in the "notion.com" container
```

## Feature: Multiple containers and the choice screen

```gherkin
Scenario: Multi-open with a default auto-opens the default
  Given a blank tab
  When I navigate to trello.com
  Then the tab opens in Work automatically
  And Personal is available as a manual switch target

Scenario: Multi-open without a default shows a choice screen
  Given a blank tab
  When I navigate to figma.com
  Then a keyboard-driven choice screen appears offering Personal and Work

Scenario: A choice is never remembered
  Given I picked Work for figma.com a moment ago
  When I navigate to figma.com again from a blank tab
  Then the choice screen appears again

Scenario: No prompt when already in an eligible container
  Given I am in the Work container
  When I navigate to figma.com
  Then I stay in Work
  And no choice screen appears

Scenario: The reopen picker is restricted to the rule's containers
  Given I am on youtube.com in a temporary container
  When I invoke "reopen this tab in a container"
  Then only Temporary and Personal are offered
  And no other container appears in the picker
```

## Feature: Temporary as a rule target

```gherkin
Scenario: An open:Temporary domain opens in a fresh temporary container
  Given I am in the Work container
  When I navigate to pinterest.com
  Then a new temporary container is created
  And I do NOT stay in Work

Scenario: Same-site continuity applies to an open:Temporary domain
  Given I am on pinterest.com in temporary container T
  When I click a link to www.pinterest.com/ideas/
  Then I stay in T
  And no new temporary container is created
  # The rule matches again, but Temporary defers "which temp" to continuity;
  # pinterest.com is in no group, so this is pure registrable-domain continuity

Scenario: Crossing between two open:Temporary sites isolates
  Given I am on pinterest.com in temporary container T
  When I navigate to youtube.com
  Then a new temporary container is created
  And I leave T
  # Both resolve to Temporary, but different site and different group -> isolate
```

## Feature: Redirector shims

```gherkin
Scenario: A redirector hop is not isolated
  Given I am on an unmatched site in temporary container T
  When I open a t.co link in that tab
  Then the tab stays in T while on t.co
  And no new temporary container is created for the hop

Scenario: A stranded shim tab is closed after its destination reopens elsewhere
  Given a t.co link whose destination is mail.google.com
  When the destination is reopened into the Gmail container
  And the original tab is still sitting on t.co after ~2 seconds
  Then the original tab is auto-closed

Scenario: A shim tab that redirected onward in-place is never closed
  Given I am in the Work container
  And a t.co link whose destination is trello.com
  When the tab redirects in-place to trello.com
  Then the tab stays in Work (trello.com defaults to Work; no reopen needed)
  And the tab is NOT closed
  # The close is conditional on still being stranded on the shim domain
```

## Feature: Rule-attached overlays

```gherkin
Scenario: A seeded cookie is present before the page first reads it
  Given the youtube.com rule seeds the "wide" cookie
  When I navigate to youtube.com
  Then the "wide" cookie exists in the tab's cookie store before document_start
  And the page sees it on its first read

Scenario: A seeded cookie is written per container, never copied across
  Given the youtube.com rule seeded "wide" in temporary container T
  When I reopen youtube.com in the Personal container
  Then "wide" is seeded fresh in Personal's cookie store
  And nothing is copied from T
```

## Feature: Redirect binding across a container switch

```gherkin
Scenario: An OAuth code flow (GET redirect) survives a reopen
  Given a login that completes via a GET redirect carrying a code parameter
  And the redirect target matches a rule that reopens the tab into another container
  When the reopen happens
  Then the code parameter is preserved in the reopened tab's URL
  And the login completes

Scenario: A SAML POST binding is never dropped silently
  Given an IdP that returns its assertion via a POST-binding form
  And the POST target matches a rule that reopens the tab into another container
  When the reopen happens
  Then either the assertion survives the container switch
  Or an explicit, visible error explains that the switch dropped the POST body
  # Handled or loud — never a silent GET that loses the assertion
```

## Feature: Inherit and SSO

```gherkin
Scenario: An inherit domain stays in the initiating container
  Given I am in the Work container
  When I navigate to login.company.com
  Then I stay in Work

Scenario: An inherit domain reached from a temporary container stays temporary
  Given I am on youtube.com in temporary container T
  When I navigate to accounts.google.com
  Then I stay in T

Scenario: No automatic inheritance for unconfigured domains
  Given I am in the Work container
  When I click a link to reddit.com
  Then a new temporary container is created
  And I do NOT stay in Work

Scenario: Strict default breaks an unconfigured auth domain (by design)
  Given newapp.com redirects its login to auth.newidp.com
  And auth.newidp.com has no rule
  When the login redirects to auth.newidp.com
  Then auth.newidp.com opens in a fresh temporary container
  And the login does not complete
  # Fix: add `- match: auth.newidp.com` with `inherit: true`
```

## Feature: Ignored domains

```gherkin
Scenario: An ignored domain is left in the current container
  Given I am in the Work container
  When I navigate to getpocket.com
  Then I stay in Work
  And no temporary container is created

Scenario: An ignored domain in a blank tab is not isolated
  Given a blank tab
  When I navigate to getpocket.com
  Then the tab stays in the default (no) container
  And no temporary container is created
  # Contrast: an unmatched domain here would open in a fresh temporary container
```

## Feature: Groups (isolation continuity)

```gherkin
Scenario: Continuity between group members
  Given I am on google.com in temporary container T
  When I navigate to youtube.com
  Then I stay in T
  And no new temporary container is created

Scenario: Entering a group from outside isolates
  Given a blank tab
  When I navigate to youtube.com
  Then a new temporary container is created

Scenario: Leaving a group isolates
  Given I am on youtube.com in temporary container T
  When I navigate to reddit.com
  Then a new temporary container is created
  And I leave T

Scenario: A group does not override an open rule
  Given I am on google.com in temporary container T
  When I navigate to mail.google.com
  Then the tab switches to the Gmail container
  And the group does NOT keep it in T
  # mechanism 1 (open) beats mechanism 2 (temp continuity)
```

## Feature: Group membership is a separate lookup (the tricky one)

```gherkin
Scenario: Disposable, signed-in-for-age-gate YouTube (the full chain)
  Given a blank tab
  When I navigate to youtube.com
  Then a fresh temporary container T is created
  When I hit an age gate and click sign in
  And the tab navigates to accounts.google.com
  Then I stay in T                                   # accounts.google.com -> inherit
  And the Google login cookie is written in T
  When accounts.google.com redirects back to youtube.com
  Then I stay in T                                   # same google group, not a new temp
  And the video plays, signed in
  When I close the tab and 15 minutes pass
  Then T is disposed and the login is gone

Scenario: A domain in both a group and an open rule keeps its group membership
  Given youtube.com has an open rule (open: [Temporary, Personal])
  And youtube.com is also a member of the google group in the separate groups list
  When accounts.google.com in temporary container T redirects to youtube.com
  Then youtube.com resolves to Temporary via its open rule
  But it stays in T, because its google-group membership is honoured
  And membership is looked up by the target URL, independently of routing
```

## Feature: Cookie isolation

```gherkin
Scenario: Login cookies do not leak into disposable YouTube
  Given I am signed into Gmail in the Gmail container
  And that login also set a youtube.com cookie in the Gmail container
  When I later open youtube.com in a temporary container
  Then the temporary YouTube is signed out
  And it cannot see the youtube.com cookie held by the Gmail container
```

## Feature: Precedence

```gherkin
Scenario: First matching rule wins (within the rules list)
  Given the mail.google.com rule is listed before a broader google.com rule
  When I navigate to mail.google.com
  Then the first matching rule decides routing (Gmail)

Scenario: Rules and groups are independent lists, never shadowing
  Given mail.google.com matches an open rule (routing)
  And mail.google.com also matches the google group shorthand (membership)
  When I navigate to mail.google.com
  Then it opens in Gmail via the rule regardless of group ordering
  And group membership never changes the routing decision
  # Membership only matters on the temporary path; mail.google.com is never temp
```

---

## Undecided — scenarios pending a decision

```gherkin
Scenario: Reopen picker for an unmatched site   # OUTCOME UNDECIDED
  Given I am on reddit.com in a temporary container
  And no rule matches reddit.com
  When I invoke "reopen this tab in a container"
  Then the picker offers ...
    # OPEN: all containers? or a restricted / pinned subset?
```
