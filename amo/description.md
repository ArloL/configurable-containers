Configurable Containers decides which Firefox container each site opens in, from one YAML file you edit as text.

Write a rule for the sites you want a named container for. Everything else opens in a fresh throwaway, cleaned up once you close its tabs.

**What it does**

- A bare domain is the common case: it opens in a container named after it. Add detail for a different name, several domains in one container, or a choice between containers.
- Single sign-on keeps working: identity providers stay in the container the login started from, so "Sign in with Google / Microsoft / Okta" does not break.
- Sites you group together share one throwaway; an unrelated site gets a clean one.
- A rule can offer several containers and let you pick.
- Known link redirectors are not isolated, and the tab closes itself if it strands you on one.
- Optional per-site cookies and content scripts, applied in the routed container.
- Reopen the current tab in another container with Ctrl+Shift+O.
- The toolbar button pauses routing in the container you are in: nothing is moved, and the sites seen while it is paused are recorded with the container each one would have gone to — so you can write the rule from what actually happened.

**How you configure it**

There is no settings screen — the YAML file is the whole interface. You edit it in the add-on's own editor (about:addons → Configurable Containers → Preferences). Saving checks the file and applies it at once; an invalid config is refused.

Your config follows your Firefox Account. An edit on one machine reaches every other machine signed into the same account through Firefox Sync, with nothing to turn on and no file to copy. The last edit wins, and if an incoming one replaces yours the editor offers the replaced text back.

The shipped default routes nothing by name. It marks the few hosts where isolating would break something, and includes commented examples to start from.

**Privacy**

The add-on has no server. Nothing is collected, and nothing is sent to its author or to anyone else. What is inside your containers — cookies, logins, the throwaway containers themselves — belongs to Firefox and never leaves the machine.

The one thing that leaves it is the config text, carried to your other machines by Firefox Sync as described above: your own account, end-to-end encrypted between your machines and nowhere else. On a machine that is not signed in it stays put.

Source code and configuration reference: [github.com/ArloL/configurable-containers](https://github.com/ArloL/configurable-containers)
