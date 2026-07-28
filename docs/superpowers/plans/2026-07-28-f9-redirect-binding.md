# F9 Redirect Binding Across a Container Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F9 — prove a GET redirect's `code` parameter survives a reopen, and stop CC from silently dropping a POST body when it reopens a navigation into another container.

**Architecture:** A non-GET guard at the top of the engine's effects step declines to execute `reopen` and `choice` decisions, because `tabs.create` can only issue a GET. The declined navigation proceeds in the tab's current container and raises a desktop notification through a new `BrowserPort.notify` seam. A test-only esbuild define makes the real port echo each notification to the e2e probe extension, since a desktop notification is in no DOM and Selenium cannot otherwise see it.

**Tech Stack:** TypeScript, esbuild, Vitest, Selenium/geckodriver, Firefox MV2 WebExtensions.

## Global Constraints

- Design of record: `docs/superpowers/specs/2026-07-28-f9-redirect-binding-design.md`. Read it before starting.
- Routing decisions live in `src/resolver/`; this guard lives in the engine deliberately (spec §2.1) because it is about the *effect* being lossy, not about where sites belong. Do not move it into `resolve()`.
- The echo in `browser-port.ts` MUST be sent **after** `await browser.notifications.create(...)` resolves. Reversing that order produces a test suite that passes with the notification entirely broken.
- Every new regression test is **revert-verified**: back the fix out, watch it go red, restore it. Restore from an editor undo or a copy, never `git checkout`.
- `npm test` runs unit and e2e together and opens real Firefox windows. `npm run typecheck` runs `tsc --noEmit` over `src/`, `test/`, `harness/` and `scripts/`.
- Keep `fileParallelism: false` in `vitest.config.ts`.
- esbuild constant-folds literals in the bundle; assert against esbuild's output form, not the source literal.
- The probe's extension id is `probe@configurable-containers.test`. It must not appear in any shipped bundle.

---

### Task 1: The `notify` port seam

Adds the seam and its real adapter. No behaviour change yet — nothing calls `notify` until Task 2.

**Files:**
- Modify: `src/engine/port.ts`
- Modify: `src/engine/browser-port.ts:20-160`
- Modify: `extensions/cc/manifest.json:13-21`
- Modify: `harness/build-extension.ts:34-52`
- Modify: `vitest.config.ts:22-25`
- Modify: `test/engine/mock-port.ts`
- Test: `test/engine/browser-port.test.ts`, `test/extension/package.test.ts`

**Interfaces:**
- Produces: `NotificationSpec { title: string; message: string }` exported from `src/engine/port.ts`; `BrowserPort.notify(n: NotificationSpec): Promise<void>`; `MockPort.calls.notify: NotificationSpec[]`; `MockPort.flush(): Promise<void>`; `buildExtension({ notifyEchoTo?: string })` defaulting to `""`.

- [ ] **Step 1: Add the type and the seam to the port**

In `src/engine/port.ts`, after the `Cookie` interface:

```ts
// A desktop notification. CC raises one when it declines to perform a routing action
// it cannot perform losslessly — today, reopening a non-GET navigation (F9).
export interface NotificationSpec {
  title: string;
  message: string;
}
```

and inside `interface BrowserPort`, after `getURL`:

```ts
  // Loud surface for a routing action CC declined to take (F9). The real port raises a
  // desktop notification; the mock records the call.
  notify(n: NotificationSpec): Promise<void>;
```

- [ ] **Step 2: Run typecheck to verify both implementations now fail**

Run: `npm run typecheck`
Expected: FAIL — `createBrowserPort` and `createMockPort` are missing `notify`.

- [ ] **Step 3: Write the failing adapter tests**

In `test/engine/browser-port.test.ts`, replace the `runtime` entry of `fakeBrowser()` and add a `notifications` entry alongside it:

```ts
    notifications: {
      create: async (opts: Record<string, unknown>) => {
        if (f.notifications._throws) throw new Error("No permission for notifications");
        f.notifications._created.push(opts);
        return "id-1";
      },
      _created: [] as Record<string, unknown>[],
      _throws: false,
    },
    runtime: {
      sendMessage: async (ext: string, msg: unknown) => {
        f.runtime._sent.push({ ext, msg });
        return { echoed: msg };
      },
      _sent: [] as { ext: string; msg: unknown }[],
    },
```

and add these cases at the end of the `describe("createBrowserPort")` block:

```ts
  it("notify raises a basic notification", async () => {
    const port = createBrowserPort();
    await port.notify({ title: "T", message: "M" });
    expect(f.notifications._created).toEqual([{ type: "basic", title: "T", message: "M" }]);
  });

  it("notify echoes to the probe AFTER the notification is created", async () => {
    const port = createBrowserPort();
    await port.notify({ title: "T", message: "M" });
    expect(f.runtime._sent).toEqual([
      { ext: "probe@configurable-containers.test", msg: { cmd: "cc-notification", title: "T", message: "M" } },
    ]);
  });

  // The ordering is the whole design: a missing "notifications" permission must make
  // the e2e assertion fail. Echo first and the suite reports green with the
  // notification entirely broken.
  it("does not echo when the notification itself failed", async () => {
    f.notifications._throws = true;
    const port = createBrowserPort();
    await expect(port.notify({ title: "T", message: "M" })).rejects.toThrow(/No permission/);
    expect(f.runtime._sent).toEqual([]);
  });
```

- [ ] **Step 4: Define the echo target for unit tests**

In `vitest.config.ts`, add to the `define` block:

```ts
    // The unit tests exercise the echo branch, so it is defined here. buildExtension
    // defaults it to "" so no shipped bundle can contain it — asserted in
    // test/extension/package.test.ts.
    __CC_NOTIFY_ECHO_TO__: JSON.stringify("probe@configurable-containers.test"),
```

- [ ] **Step 5: Run the adapter tests to verify they fail**

Run: `npx vitest run test/engine/browser-port.test.ts`
Expected: FAIL — `port.notify is not a function`.

- [ ] **Step 6: Implement the real adapter**

In `src/engine/browser-port.ts`, add above `export function createBrowserPort()`:

```ts
// The extension id the harness build echoes notifications to, so an e2e can observe a
// toast that lives in no DOM. "" in every shipped build, which esbuild folds away.
declare const __CC_NOTIFY_ECHO_TO__: string;
```

and add this method to the returned object, after `getURL`:

```ts
    async notify(n) {
      await browser.notifications.create({ type: "basic", title: n.title, message: n.message });
      // AFTER the create resolves, never before: a missing "notifications" permission
      // must make the e2e assertion fail, not pass with the notification broken.
      if (__CC_NOTIFY_ECHO_TO__) {
        await browser.runtime.sendMessage(__CC_NOTIFY_ECHO_TO__, { cmd: "cc-notification", ...n });
      }
    },
```

- [ ] **Step 7: Add the permission**

In `extensions/cc/manifest.json`, add `"notifications"` to the `permissions` array after `"contextualIdentities"`.

- [ ] **Step 8: Run the adapter tests to verify they pass**

Run: `npx vitest run test/engine/browser-port.test.ts`
Expected: PASS

- [ ] **Step 9: Add the mock recorder**

In `test/engine/mock-port.ts`: add `NotificationSpec` to the type import list from `../../src/engine/port`; add `notify: NotificationSpec[];` to the `calls` block of `interface MockPort`; add `flush(): Promise<void>;` to `interface MockPort`; add `notify: [] as NotificationSpec[],` to the `calls` object literal; add this method to the `port` object after `getURL`:

```ts
    async notify(n) {
      calls.notify.push(n);
    },
```

and add this to the returned object, after `setActiveTab`:

```ts
    // The engine floats its notification rather than awaiting it (a navigation must
    // not wait on a toast), so a test asserting on calls.notify must settle first.
    flush: flushMicrotasks,
```

- [ ] **Step 10: Write the failing packaged-bundle guard**

In `test/extension/package.test.ts`, add inside `describe("packageExtension")`:

```ts
  it("ships no echo target, so the packaged build cannot talk to the test probe", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    try {
      const { stageDir } = await packageExtension({ version: "2607.0.103", outDir });
      const bundle = readFileSync(path.join(stageDir, "background.js"), "utf8");
      expect(bundle).not.toContain("probe@configurable-containers.test");
      expect(bundle).not.toContain("cc-notification");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run test/extension/package.test.ts`
Expected: FAIL — `__CC_NOTIFY_ECHO_TO__` is not defined by `buildExtension`, so esbuild leaves the identifier and the branch in the bundle.

- [ ] **Step 12: Add the build option**

In `harness/build-extension.ts`, extend the `opts` parameter type of `buildExtension` with `notifyEchoTo?: string;` and add to the `define` block:

```ts
      __CC_NOTIFY_ECHO_TO__: JSON.stringify(opts.notifyEchoTo ?? ""),
```

- [ ] **Step 13: Run the full suite**

Run: `npm run typecheck && npx vitest run test/engine test/extension`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add src/engine/port.ts src/engine/browser-port.ts extensions/cc/manifest.json \
        harness/build-extension.ts vitest.config.ts test/engine/mock-port.ts \
        test/engine/browser-port.test.ts test/extension/package.test.ts
git commit -m "feat(port): a notify seam, echoed to the probe only in test builds"
```

---

### Task 2: The non-GET guard in the engine

**Files:**
- Modify: `src/engine/engine.ts:64-182`
- Test: `test/engine/post-binding.test.ts` (create)

**Interfaces:**
- Consumes: `BrowserPort.notify`, `MockPort.calls.notify`, `MockPort.flush` (Task 1).
- Produces: no new exports. `createEngine` keeps returning `{ reopen }`.

- [ ] **Step 1: Write the failing tests**

Create `test/engine/post-binding.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createEngine } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };
const noop = () => {};

function counter(): () => string {
  let n = 0;
  return () => String(++n);
}

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "POST", ...over };
}

// example.com opens the permanent "Work" container.
function workConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work"] } }], groups: [] };
}

// example.com offers two containers and no default — resolve() returns a choice.
function choiceConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Personal", "Work"] } }], groups: [] };
}

describe("engine — a non-GET navigation is never reopened (F9)", () => {
  it("declines to reopen a POST into a permanent container, and says where it stayed", async () => {
    const mp = createMockPort();
    const tmp = mp.addIdentity({ name: "tmp1" });
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: tmp.cookieStoreId });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    // tabs.create can only issue a GET, so reopening would drop the body. The POST
    // proceeds where it is: no cancel, no new tab.
    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toEqual([]);
    expect(mp.calls.removeTab).toEqual([]);
    expect(mp.calls.notify).toHaveLength(1);
    expect(mp.calls.notify[0].message).toBe(
      "A form submission to example.com stayed in tmp1 instead of Work — moving it would have dropped the form data.",
    );
  });

  it("declines a POST that would have bought a fresh throwaway", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: { rules: [], groups: [] }, deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toEqual([]);
    expect(mp.calls.notify[0].message).toContain("stayed in the default container instead of a new temporary container");
  });

  it("declines a POST that would have raised the choice screen", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const offered: string[][] = [];
    createEngine({ port: mp.port, config: choiceConfig(), deps, onChoice: (o) => void offered.push(o), tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    // The choice screen reopens through engine.reopen too, so it drops the body just
    // as surely — decline before showing it.
    expect(res).toBeUndefined();
    expect(offered).toEqual([]);
    expect(mp.calls.updates).toEqual([]);
    expect(mp.calls.notify[0].message).toContain("instead of one of: Personal, Work");
  });

  it("leaves a POST that was already going to stay put alone, and stays silent", async () => {
    const mp = createMockPort();
    const work = mp.addIdentity({ name: "Work" });
    const tab = mp.addTab({ url: "https://example.com/a", cookieStoreId: work.cookieStoreId });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    expect(res).toBeUndefined();
    expect(mp.calls.notify).toEqual([]);
  });

  it("still reopens a GET", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, method: "GET" }));
    await mp.flush();

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(1);
    expect(mp.calls.notify).toEqual([]);
  });

  it("warns once per host, not once per attempt", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: tab.id, requestId: "1" }));
    await mp.fire(req({ tabId: tab.id, requestId: "2", url: "https://example.com/other" }));
    await mp.flush();

    expect(mp.calls.notify).toHaveLength(1);
  });

  it("says nothing about a POST inside a navigation the engine itself reopened", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: tab.id, method: "GET" })); // reopens into Work
    const created = mp.calls.createTab[0];
    const openedTab = [...mp.tabs.values()].find((t) => t.cookieStoreId === created.cookieStoreId)!;

    // A form POST arriving as the reopened tab's own first request is ours already —
    // it returns at the reopenedNav guard and never reaches the F9 check.
    const res = await mp.fire(req({ tabId: openedTab.id, requestId: "2" }));
    await mp.flush();

    expect(res).toBeUndefined();
    expect(mp.calls.notify).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/engine/post-binding.test.ts`
Expected: FAIL — the first case reopens the POST (`calls.createTab` has one entry, `res` is `{cancel:true}`) and `calls.notify` is empty.

- [ ] **Step 3: Add the label helpers**

In `src/engine/engine.ts`, add `Decision` to the type import from `../resolver/types`, then add above `export function createEngine`:

```ts
// The two decisions the engine executes by opening a tab — and therefore the two it
// cannot execute for a request that carries a body.
type Declinable = Extract<Decision, { kind: "reopen" } | { kind: "choice" }>;

// How the notification names where the tab is, and where the rules wanted it.
async function containerLabel(port: BrowserPort, cookieStoreId: string): Promise<string> {
  const ci = await port.getIdentity(cookieStoreId);
  return ci ? ci.name : "the default container";
}

function targetLabel(decision: Declinable): string {
  if (decision.kind === "choice") return `one of: ${decision.options.join(", ")}`;
  switch (decision.into.kind) {
    case "permanent":
      return decision.into.name;
    case "temporary":
      return "a new temporary container";
    case "default":
      return "the default container";
  }
}
```

- [ ] **Step 4: Add the dedupe set and the announcer**

In `src/engine/engine.ts`, inside `createEngine` next to `const handled = new Set<string>();`:

```ts
  // Hosts already warned about a declined non-GET. Session-scoped: the
  // runtime.reload() a config save triggers clears it, which is what we want — the
  // rules just changed, so the user should hear about them again.
  const warnedHosts = new Set<string>();

  async function announceDeclined(d: WebRequestDetails, tab: Tab, decision: Declinable): Promise<void> {
    const host = new URL(d.url).host;
    if (warnedHosts.has(host)) return;
    warnedHosts.add(host);
    await port.notify({
      title: "Configurable Containers",
      message:
        `A form submission to ${host} stayed in ${await containerLabel(port, tab.cookieStoreId)} ` +
        `instead of ${targetLabel(decision)} — moving it would have dropped the form data.`,
    });
  }
```

- [ ] **Step 5: Add the guard**

In `src/engine/engine.ts`, between `const decision = resolve(nav, config, deps);` and `// (4) Effects.`:

```ts
    // (3b) F9 — tabs.create can only issue a GET, so reopening a navigation that
    // carries a body would drop it silently. Leave it where it is and say so. Placed
    // before macOwns (no reason to ask MAC about a navigation we will not act on) and
    // before handled.add (this path adds no state, so it is fail-open by construction).
    // The reopenedNav guard has already returned for navigations that are ours.
    if ((decision.kind === "reopen" || decision.kind === "choice") && d.method !== "GET") {
      // Floated, never awaited: a navigation must not wait on a toast, and a
      // notification that cannot be raised must not break routing.
      void announceDeclined(d, tab, decision).catch((e) => console.warn("[engine] notify failed", e));
      return; // no cancel — the POST proceeds in the tab's current container
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/engine/ && npm run typecheck`
Expected: PASS, including the existing `engine.test.ts` and `engine.props.test.ts`.

- [ ] **Step 7: Revert-verify**

Comment out the four-line `if` from Step 5, run `npx vitest run test/engine/post-binding.test.ts`, and confirm six of the seven cases go red (the GET case stays green — it is the regression guard). Restore the block **by uncommenting it**, not with `git checkout`.

- [ ] **Step 8: Commit**

```bash
git add src/engine/engine.ts test/engine/post-binding.test.ts
git commit -m "fix(engine): never reopen a navigation that carries a body"
```

---

### Task 3: Mock IdP in the harness server

**Files:**
- Modify: `harness/server.ts:14-57`
- Test: `test/harness/server.test.ts`

**Interfaces:**
- Produces: `OAUTH_CODE`, `SAML_ASSERTION`, `IDP_TARGET_HOST` exported from `harness/server.ts`; `GET /authorize`, `GET /saml`, and a `data-seen-post` attribute on every POST response.

- [ ] **Step 1: Write the failing tests**

Add to `test/harness/server.test.ts` (extend the existing import to `import { startServer, REDIRECT_TARGET_HOST, OAUTH_CODE, SAML_ASSERTION, IDP_TARGET_HOST } from "../../harness/server";`):

```ts
  it("/authorize redirects to the matched host carrying an OAuth code", async () => {
    const server = await startServer();
    try {
      const res = await fetch(new URL("/authorize", server.url), { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.hostname).toBe(IDP_TARGET_HOST);
      expect(location.pathname).toBe("/callback");
      expect(location.searchParams.get("code")).toBe(OAUTH_CODE);
      expect(location.port).toBe(new URL(server.url).port);
    } finally {
      await server.close();
    }
  });

  it("/saml serves a self-submitting POST-binding form aimed at the matched host", async () => {
    const server = await startServer();
    try {
      const body = await (await fetch(new URL("/saml", server.url))).text();
      expect(body).toContain(`action="http://${IDP_TARGET_HOST}:${new URL(server.url).port}/acs"`);
      expect(body).toContain(`value="${SAML_ASSERTION}"`);
      expect(body).toContain(".submit()");
    } finally {
      await server.close();
    }
  });

  it("reflects a urlencoded POST body into a body attribute", async () => {
    const server = await startServer();
    try {
      const res = await fetch(new URL("/acs", server.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `SAMLResponse=${SAML_ASSERTION}`,
      });
      expect(await res.text()).toContain(`data-seen-post="SAMLResponse=${SAML_ASSERTION}"`);
    } finally {
      await server.close();
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/harness/server.test.ts`
Expected: FAIL — `OAUTH_CODE` is not exported.

- [ ] **Step 3: Add the constants**

In `harness/server.ts`, below `REDIRECT_TARGET_HOST`:

```ts
// The mock IdP's fixed destination and payloads. Like REDIRECT_TARGET_HOST these are
// constants rather than query parameters on purpose: reading a destination off the
// request makes this an open redirect (CodeQL js/server-side-unvalidated-url-redirection).
// The host is a launch() local domain that CC's test config routes to "Work", so a
// navigation to it is one CC wants to move into another container.
export const IDP_TARGET_HOST = "work.example";
export const OAUTH_CODE = "cc-test-code-42";
export const SAML_ASSERTION = "cc-test-assertion";
```

- [ ] **Step 4: Serve the two endpoints and reflect the POST body**

In `harness/server.ts`, restructure the request handler. Replace the body of `createServer((req, res) => { … })` with:

```ts
  const server = createServer((req, res) => {
    const requested = new URL(req.url ?? "/", "http://127.0.0.1");
    const params = requested.searchParams;

    // /redirect answers 302 to REDIRECT_TARGET_HOST on this same server, so a test can
    // drive a real cross-host redirect chain — the browser keeps the tab pre-commit
    // ("about:blank") across every hop of it.
    if (requested.pathname === "/redirect") {
      res.writeHead(302, { location: `http://${REDIRECT_TARGET_HOST}:${port}/` });
      res.end();
      return;
    }

    // /authorize is the OAuth code flow: a GET redirect into a host CC routes
    // elsewhere, carrying the parameter that must survive the reopen (F9).
    if (requested.pathname === "/authorize") {
      res.writeHead(302, { location: `http://${IDP_TARGET_HOST}:${port}/callback?code=${OAUTH_CODE}` });
      res.end();
      return;
    }

    // /saml is the POST binding: a form that submits itself to a host CC routes
    // elsewhere. Reopening it would turn the POST into a GET and drop the assertion,
    // which is exactly what CC must decline to do.
    if (requested.pathname === "/saml") {
      const action = `http://${IDP_TARGET_HOST}:${port}/acs`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>idp</title></head><body>" +
          `<form id="saml" method="POST" action="${escapeAttr(action)}">` +
          `<input type="hidden" name="SAMLResponse" value="${escapeAttr(SAML_ASSERTION)}">` +
          "</form><script>document.getElementById('saml').submit();</script></body></html>",
      );
      return;
    }

    // ?link=<url> puts an anchor on the page so a test can CLICK it with a real user
    // gesture: target=_blank by default (the new tab then inherits its opener's
    // container the way a middle-click does, which no scripted tabs.create
    // reproduces), or a plain same-tab link with &same=1.
    const link = params.get("link");
    const target = params.has("same") ? "" : ` target="_blank"`;
    const anchor = link ? `<a id="go"${target} href="${escapeAttr(link)}">go</a>` : "";

    // Reflect the request's Cookie header into a body attribute so an external driver
    // can assert the FIRST request already carried a seeded cookie (F12 wire side).
    const cookie = req.headers.cookie ?? "";

    // Reflect a POST body the same way, so a test can prove an assertion arrived
    // intact rather than being lost to a reopen's GET (F9).
    const respond = (post: string) => {
      const html =
        "<!doctype html><html><head><title>probe-target</title>" +
        // This inline script runs at parse time, AFTER document_start content scripts.
        // If CC's script-injector already set localStorage.cc_script, it's visible here —
        // proving the injected script ran before the page's own scripts (F12 timing).
        "<script>document.documentElement.setAttribute('data-cc-script-at-start', localStorage.getItem('cc_script') || '');</script>" +
        `</head><body data-seen-cookie="${escapeAttr(cookie)}" data-seen-post="${escapeAttr(post)}">ok${anchor}</body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => respond(body));
      return;
    }
    respond("");
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/harness/server.test.ts && npm run typecheck`
Expected: PASS — including the existing cookie-reflection and redirect cases.

- [ ] **Step 6: Commit**

```bash
git add harness/server.ts test/harness/server.test.ts
git commit -m "test(harness): a mock IdP with an OAuth code flow and a POST binding"
```

---

### Task 4: L4 — the OAuth code flow survives a reopen

**Files:**
- Test: `test/e2e/redirect-binding.test.ts` (create)

**Interfaces:**
- Consumes: `OAUTH_CODE` (Task 3); `launch`, `awaitContainerTab`, `listTabs` from `harness/firefox.ts`.

**The trap this test is shaped to avoid:** navigating a fresh tab straight to `/authorize` makes CC reopen it into a throwaway first; the 302 then reuses that request's id, so `reopenedNav` holds the whole chain and the callback lands in the throwaway. No container switch happens and the test proves nothing. So the navigation must start from a **committed** page, exactly like the same-tab-link case in `test/e2e/routing.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/e2e/redirect-binding.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import { launch, awaitContainerTab, listTabs, type Session } from "../../harness/firefox";
import { OAUTH_CODE } from "../../harness/server";

describe("redirect binding — an OAuth code flow (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("preserves the code parameter across the container switch", async () => {
    // Start from a page that has COMMITTED. Driving /authorize from a fresh tab would
    // have CC reopen that tab first, and the 302 would then be another hop of a
    // navigation the reopen guard already owns — no container switch, nothing proven.
    const authorize = `http://nomatch.example:${port}/authorize`;
    const article = `http://nomatch.example:${port}/?same=1&link=${encodeURIComponent(authorize)}`;
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(article);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const { name: from } = await awaitContainerTab(session.driver, article);
    expect(from).toMatch(/^tmp/);

    // Same-site link, so no reopen and no guard: the 302 out of it is the first
    // navigation CC gets to route, and work.example belongs in Work.
    await session.driver.findElement(By.id("go")).click();

    const callback = `http://work.example:${port}/callback`;
    const { name: landed } = await awaitContainerTab(session.driver, callback);
    expect(landed).toBe("Work");

    const opened = (await listTabs(session.driver)).find((t) => t.url.startsWith(callback));
    expect(opened, "the callback must have opened in its container").toBeDefined();
    expect(opened!.url).toContain(`code=${OAUTH_CODE}`);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/e2e/redirect-binding.test.ts`
Expected: PASS — this half of F9 is already correct; the test is the regression guard.

- [ ] **Step 3: Revert-verify that it is actually watching something**

Temporarily change `reopen` in `src/engine/engine.ts:111` to drop the query string — `url: url.split("?")[0]` — and re-run. Expected: FAIL on the `code=` assertion (not on a missing tab). Restore the line by undoing the edit.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/redirect-binding.test.ts
git commit -m "test(e2e): prove an OAuth code survives the container switch (F9)"
```

---

### Task 5: L4 — a POST keeps its body, its container, and is announced

**Files:**
- Modify: `extensions/probe/background.js:54-88`
- Modify: `harness/firefox.ts:14-30, 151-190, 290-310`
- Modify: `test/e2e/redirect-binding.test.ts`

**Interfaces:**
- Consumes: `MockPort`-independent — this is all real Firefox. Uses `SAML_ASSERTION`, `IDP_TARGET_HOST` (Task 3) and the guard from Task 2.
- Produces: `ProbeNotification { title: string; message: string }`, `readNotifications(driver, match, timeoutMs?)`, `readSeenPost(driver)` from `harness/firefox.ts`; a `notifications` probe command.

- [ ] **Step 1: Collect echoed notifications in the probe**

In `extensions/probe/background.js`, add above the `browser.runtime.onMessage.addListener` block:

```js
// Notifications echoed by CC's test build (harness/build-extension.ts sets the echo
// target; shipped builds set ""). Collected here because a desktop notification lives
// in no DOM, so WebDriver has no other way to observe one.
const notifications = [];
browser.runtime.onMessageExternal.addListener((msg) => {
  if (msg && msg.cmd === "cc-notification") {
    notifications.push({ title: msg.title, message: msg.message });
  }
  return Promise.resolve({ ok: true });
});
```

and add to the command listener, before its closing `return null;`:

```js
  if (msg && msg.cmd === "notifications") {
    return notifications;
  }
```

Also extend that listener's doc comment with:

```js
//   notifications — every notification CC's test build echoed to us so far.
```

- [ ] **Step 2: Turn the echo on for e2e builds**

In `harness/firefox.ts`: add below `CC_EXTENSION_UUID`:

```ts
// The probe's own id, from extensions/probe/manifest.json. CC's e2e build echoes its
// notifications here; buildExtension defaults this off for every shipped build.
export const PROBE_EXTENSION_ID = "probe@configurable-containers.test";
```

add `notifyEchoTo?: string;` to the `opts` parameter type of `buildXpiFor`, and add to the object `launch` passes to `buildXpiFor`:

```ts
        notifyEchoTo: PROBE_EXTENSION_ID,
```

- [ ] **Step 3: Add the read helpers**

In `harness/firefox.ts`, after `readScriptAtStart`:

```ts
// The POST body the server saw on this page's own request — empty for a GET. Proves an
// assertion arrived intact rather than being lost to a reopen's GET (F9).
export async function readSeenPost(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.body.getAttribute('data-seen-post') || '';"
  )) as string;
}

export interface ProbeNotification {
  title: string;
  message: string;
}

// Notifications CC's test build echoed to the probe. Polls, because the echo races the
// page load the driver is parked on; a desktop notification is in no DOM, so this
// relay is the only way L4 can observe one at all.
export async function readNotifications(
  driver: WebDriver,
  match: (n: ProbeNotification) => boolean,
  timeoutMs = 15_000,
): Promise<ProbeNotification> {
  const deadline = Date.now() + timeoutMs;
  let seen: ProbeNotification[] = [];
  while (Date.now() < deadline) {
    seen = await probeCommand<ProbeNotification[]>(driver, "notifications");
    const hit = seen.find(match);
    if (hit) return hit;
    await driver.sleep(300);
  }
  throw new Error(`no matching notification; saw ${JSON.stringify(seen)}`);
}
```

- [ ] **Step 4: Write the failing test**

Append to `test/e2e/redirect-binding.test.ts` (and extend its imports to
`import { launch, awaitContainerTab, listTabs, readContainerName, readNotifications, readSeenPost, type Session } from "../../harness/firefox";`
and `import { OAUTH_CODE, SAML_ASSERTION } from "../../harness/server";`):

```ts
describe("redirect binding — a SAML POST binding (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("keeps the assertion, keeps the container, and says so", async () => {
    const idp = `http://nomatch.example:${port}/saml`;
    const article = `http://nomatch.example:${port}/?same=1&link=${encodeURIComponent(idp)}`;
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(article);
    } catch {
      // CC reopened the blank tab away — expected.
    }
    const { name: from } = await awaitContainerTab(session.driver, article);
    expect(from).toMatch(/^tmp/);

    // Same-site hop to the IdP, whose form then POSTs itself to work.example — a host
    // CC's rules put in Work. Reopening that POST would turn it into a GET.
    await session.driver.findElement(By.id("go")).click();

    const acs = `http://work.example:${port}/acs`;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await session.driver.getCurrentUrl()).startsWith(acs)) {
      await session.driver.sleep(300);
    }
    expect(await session.driver.getCurrentUrl()).toMatch(acs);

    // The tab was never reopened, so the driver is still on it: the POST completed
    // in place, with its body, in the container it started in.
    expect(await readSeenPost(session.driver)).toContain(SAML_ASSERTION);
    expect(await readContainerName(session.driver)).toBe(from);
    expect((await listTabs(session.driver)).filter((t) => t.url.startsWith(acs))).toHaveLength(1);

    const note = await readNotifications(session.driver, (n) => n.message.includes("work.example"));
    expect(note.title).toBe("Configurable Containers");
    expect(note.message).toContain(`stayed in ${from}`);
    expect(note.message).toContain("instead of Work");
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run test/e2e/redirect-binding.test.ts`
Expected: PASS. If it fails, the diagnosis matters: a failure on `readContainerName` means the guard is not firing; a failure on `readNotifications` means the echo path is broken; a failure on `readSeenPost` means the server is not reflecting the body.

- [ ] **Step 6: Revert-verify both halves**

Comment out the Task 2 guard (`src/engine/engine.ts`, the `(3b)` block) and re-run. Expected: FAIL on **container** — the assertion is dropped and `/acs` loads in `Work` — not on a missing tab. Restore it by uncommenting.

Then, in `src/engine/browser-port.ts`, move the `browser.runtime.sendMessage` echo **above** the `await browser.notifications.create(...)` line and remove `"notifications"` from `extensions/cc/manifest.json`. Re-run. Expected: PASS — which is the false green this ordering exists to prevent. Restore both, re-run, confirm still green.

- [ ] **Step 7: Commit**

```bash
git add extensions/probe/background.js harness/firefox.ts test/e2e/redirect-binding.test.ts
git commit -m "test(e2e): prove a POST keeps its body, its container, and is announced (F9)"
```

---

### Task 6: Documentation

The chosen policy makes existing spec text false, so this is a deliverable, not housekeeping.

**Files:**
- Modify: `TESTS.md:251-268`
- Modify: `TESTING.md:213-232`
- Modify: `CONFIG.md`
- Modify: `CLAUDE.md`
- Modify: `FOLLOWUPS.md`

- [ ] **Step 1: Rewrite the TESTS.md scenarios**

Replace the whole `## Feature: Redirect binding across a container switch` gherkin block. The existing POST scenario is premised on `When the reopen happens`, which the implemented policy makes false, and it offers two outcomes where the real one is a third — the switch never happens.

```gherkin
Scenario: An OAuth code flow (GET redirect) survives a reopen
  Given a login that completes via a GET redirect carrying a code parameter
  And the redirect target matches a rule that opens it in another container
  When the redirect is reopened into that container
  Then the code parameter is preserved in the reopened tab's URL

Scenario: A POST that would change container is left where it is, loudly
  Given an identity provider that returns its assertion via a POST-binding form
  And the POST target matches a rule that opens it in another container
  When the POST is submitted
  Then CC does not reopen the tab, because a reopen would drop the form data
  And the assertion arrives intact at its destination
  And the destination loads in the container the submission came from
  And a notification names the host, the container it stayed in, and the container
      the rule asked for
  # Fix for an SSO chain: give the IdP `inherit: true`, and no switch is needed
```

- [ ] **Step 2: Update the TESTING.md matrix**

Change the F9 row to `| F9 redirect binding        |    |    | ✅ | ✅ | ✅ |    |` and replace the paragraph beginning "Every class except F9 has at least one deterministic owner" with:

```markdown
Every class now has at least one deterministic owner (L1–L3) *and*, where the browser is
the source of truth (F1, F2, F7, F9, F10, F11, F12), a real-Firefox confirmation. F9 was
the long-standing exception: POST bodies and redirect bindings don't exist in a pure
resolver. It gained an L3 owner when the decision *not* to reopen a non-GET navigation
moved into the engine, where a mock port can drive it.
```

- [ ] **Step 3: Document the policy in CONFIG.md**

Add to the F9 entry of the feature list:

```markdown
A navigation that carries a body (a form POST) is **never reopened**: `tabs.create` can
only issue a GET, so moving it would drop the body — a SAML assertion, a payment
return. CC leaves it in the container it started in and raises a notification naming
the container the rules asked for. For an SSO chain the fix is `inherit: true` on the
identity provider: the IdP then sits in the app's container, the assertion posts back
to that same container, and no switch is needed.
```

- [ ] **Step 4: Record the three cold-start traps in CLAUDE.md**

Add to the "Firefox extension constraints" section:

```markdown
- **A navigation that carries a body is never reopened** (`d.method !== "GET"` in the
  engine, before the effects switch). `port.createTab` issues a GET, so reopening a POST
  drops the body — TESTS.md's SAML case. The guard sits *before* `macOwns` (no reason to
  message MAC about a navigation we will not act on) and *before* `handled.add`, so the
  path adds no state and is fail-open by construction. It is in the engine rather than
  the resolver on purpose: the routing answer is still correct, the *effect* is what
  cannot be performed losslessly — so a future POST-replay is a change to how the engine
  executes an unchanged decision. Same-site POSTs never reach it (`disposablePath`
  already returns `stay`), which is the case TCP needs an explicit check for
  (`tcp/src/background/isolation.ts:328`) and MAC has no answer to at all.
- **The notification echo must be sent AFTER `notifications.create` resolves**
  (`src/engine/browser-port.ts`). A desktop notification is in no DOM, so L4 observes it
  by having CC's test build forward it to the probe — `__CC_NOTIFY_ECHO_TO__`, an esbuild
  define that is `""` in every shipped build. Echo *before* the create and a missing
  `notifications` permission still produces a green e2e with the notification entirely
  broken. `test/extension/package.test.ts` separately asserts the probe's id never
  reaches a packaged bundle.
- **An F9 e2e must start from a COMMITTED page.** Driving `/authorize` from a fresh tab
  has CC reopen that tab first, and the 302 is then another hop of a navigation
  `reopenedNav` already owns — the callback lands in the throwaway, no container switch
  happens, and a test asserting "the code survived" proves nothing. Both cases in
  `test/e2e/redirect-binding.test.ts` therefore click a same-site link out of a page that
  has already loaded.
```

- [ ] **Step 5: Record the deferred half in FOLLOWUPS.md**

Add:

```markdown
## Notification volume on declined POSTs (2026-07-28)

Every cross-site form POST that would change container now raises a notification,
deduplicated per host per background session. Payment-gateway returns are the common
case, and there staying put is the *desirable* outcome — so the toast may prove to be
noise. The narrower trigger (notify only when the denied target was a **permanent**
container, i.e. a rule that went unapplied) is a one-line change at the same site in
`src/engine/engine.ts`. Revisit after real use.

Not done here either: **replaying** the POST into the target container via a generated
auto-submitting form page. It is the only option that would actually route the
assertion, and neither Temporary Containers nor Multi-Account Containers attempts it.
It needs the `requestBody` webRequest opt-in, urlencoded and multipart handling, and a
`moz-extension:` page forging a cross-origin POST. See the design spec's §1.
```

- [ ] **Step 6: Verify the whole suite**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add TESTS.md TESTING.md CONFIG.md CLAUDE.md FOLLOWUPS.md
git commit -m "docs: F9 is closed — a POST keeps its body and its container, loudly"
```

---

## Self-Review

**Spec coverage.** §2 behaviour → Task 2. §2.1 placement → Task 2 Steps 3–5 plus the CLAUDE.md entry in Task 6. §2.2 ordering → Task 2 Step 5's comment and placement. §2.3 blast radius → CONFIG.md (Task 6 Step 3) and FOLLOWUPS.md (Step 5). §2.4 upstreams → CLAUDE.md entry. §3.1 message → Task 2 Steps 3–4, asserted verbatim in Step 1. §3.2 dedupe → Task 2 Step 4, tested by the "warns once per host" case. §3.3 fire-and-forget → Task 2 Step 5, with `MockPort.flush` from Task 1. §4 seam → Task 1. §5.1 mock IdP → Task 3. §5.2 probe → Task 5 Steps 1–3. §6.1 the trap → Task 4's preamble and both e2e tests. §6.2 → Tasks 4 and 5. §6.3 → Task 2 Step 1. §6.4 revert-verification → Task 2 Step 7, Task 4 Step 3, Task 5 Step 6. §7 docs → Task 6. No gaps.

**Placeholder scan.** Every code step carries the code. No "TBD", no "similar to Task N", no "add error handling".

**Type consistency.** `NotificationSpec { title, message }` is defined in Task 1 Step 1 and used unchanged by the mock (Step 9), the engine (Task 2 Step 4), and the probe echo payload `{ cmd: "cc-notification", title, message }` (Task 1 Step 6, consumed in Task 5 Step 1). `ProbeNotification` mirrors it on the harness side. `Declinable` is defined once in Task 2 Step 3 and used by `targetLabel` and `announceDeclined`. `buildExtension`'s `notifyEchoTo` (Task 1 Step 12) is passed by `buildXpiFor`/`launch` (Task 5 Step 2). `__CC_NOTIFY_ECHO_TO__` is declared in `browser-port.ts`, defined in `harness/build-extension.ts` and `vitest.config.ts` — the two places the codebase already defines `__CC_CONFIG_YAML__`.

## One judgement call worth a reviewer's attention

Task 1 defines `__CC_NOTIFY_ECHO_TO__` in `vitest.config.ts` as the probe's real id, so the unit tests can exercise the echo branch and pin its ordering deterministically rather than relying on L4 revert-verification alone. The risk that introduces — a build accidentally shipping the echo — is covered by the packaged-bundle assertion in Task 1 Step 10, which greps the staged `background.js` for both the probe id and the `cc-notification` marker.
