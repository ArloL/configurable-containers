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

**How you configure it**

There is no settings screen — the YAML file is the whole interface. You edit it in the add-on's own editor (about:addons → Configurable Containers → Preferences). Saving checks the file and applies it at once; an invalid config is refused.

The shipped default routes nothing by name. It marks the few hosts where isolating would break something, and includes commented examples to start from.

**Privacy**

Nothing is collected and nothing is transmitted. Your configuration stays in your browser.

Source code and configuration reference: [github.com/ArloL/configurable-containers](https://github.com/ArloL/configurable-containers)
