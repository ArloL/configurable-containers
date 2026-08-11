const REPORT_PREFIX = "CSID:";

// Names of cookies that would be sent to `url` in `storeId` (getAll sees httpOnly too).
async function cookieNames(url, storeId) {
  try {
    const cs = await browser.cookies.getAll({ url, storeId });
    return cs.map((c) => c.name).join(",");
  } catch (_e) {
    return "";
  }
}

// Surface a tab's cookieStoreId into document.title (CSID:<store>, unchanged) AND its
// container name + cross-store cookie names into data attributes, so an external
// driver can read both routing and F11-boundary observations.
async function reportTab(tabId, cookieStoreId, url) {
  let name = "";
  try {
    name = (await browser.contextualIdentities.get(cookieStoreId)).name;
  } catch (_e) {
    // firefox-default has no identity — leave name empty.
  }
  let list = "";
  try {
    list = (await browser.contextualIdentities.query({})).map((c) => c.name).join(",");
  } catch (_e) {
    // ignore
  }
  const here = await cookieNames(url, cookieStoreId);
  const def = await cookieNames(url, "firefox-default");
  try {
    await browser.tabs.executeScript(tabId, {
      code:
        // Command relay: the driver dispatches a `cc-probe-cmd` DOM event on the page;
        // this content script forwards it to the probe background (which has the
        // privileged APIs) and writes the reply into data-cc-result for the driver
        // to poll. Lets tests do things WebDriver can't, e.g. open a real new tab.
        "document.addEventListener('cc-probe-cmd', (e) => {" +
        "  browser.runtime.sendMessage(e.detail).then((r) => {" +
        "    document.documentElement.setAttribute('data-cc-result', JSON.stringify(r));" +
        "  });" +
        "});" +
        "document.title = " + JSON.stringify(REPORT_PREFIX + cookieStoreId) + ";" +
        "document.documentElement.setAttribute('data-cc-container', " + JSON.stringify(name) + ");" +
        "document.documentElement.setAttribute('data-cc-containers', " + JSON.stringify(list) + ");" +
        "document.documentElement.setAttribute('data-cc-cookies-here', " + JSON.stringify(here) + ");" +
        "document.documentElement.setAttribute('data-cc-cookies-default', " + JSON.stringify(def) + ");",
    });
  } catch (_e) {
    // about:, view-source:, moz-extension: pages cannot be injected — ignore.
  }
}

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

// Driver commands, relayed from the injected content script above.
//   newTab  — `browser.tabs.create({})`, i.e. exactly what Ctrl/Cmd+T does: a tab
//             at the new-tab page in the default container. WebDriver's
//             `switchTo().newWindow("tab")` cannot do this (it makes about:blank).
//   tabs    — dump every tab's id/url/cookieStoreId/container name.
//   nav     — navigate a tab BY ID; WebDriver can only drive the tab it is switched
//             to, and gives no way to map a window handle to a tabs.Tab id. Refuses
//             to navigate the tab it was RELAYED THROUGH — see below.
//   open    — open an arbitrary URL in a new tab, including another extension's
//             moz-extension:// page. WebDriver cannot navigate to that scheme at
//             all, and Firefox lets one extension open another's pages without
//             web_accessible_resources (that gate is for web content).
//   viewSource — open `view-source:<url>` in a new tab of the given container, which
//             is what Ctrl+U does (the source tab inherits the container of the page
//             it was invoked on). WebDriver cannot navigate to that scheme, and the
//             keystroke itself is chrome-level, so this is the only reachable route.
//   containers — every container's name, live. The data-cc-containers attribute is a
//             snapshot taken when a document loaded, so watching a container get
//             REMOVED through it means re-navigating something on every poll; this
//             asks the browser instead, from a tab that never moves.
//   notifications — every notification CC's test build echoed to us so far.
browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg && msg.cmd === "viewSource") {
    const t = await browser.tabs.create({
      url: "view-source:" + msg.url,
      cookieStoreId: msg.cookieStoreId,
    });
    return { id: t.id, url: t.url, cookieStoreId: t.cookieStoreId };
  }
  if (msg && msg.cmd === "open") {
    const t = await browser.tabs.create({ url: msg.url });
    return { id: t.id, url: t.url };
  }
  if (msg && msg.cmd === "nav") {
    // Every reply is written into the DOM of the tab that RELAYED the command, so
    // navigating that same tab throws the answer away with the document it was going
    // to land in: the driver then polls a fresh document that has no data-cc-result
    // and reads it as `probe command "nav" timed out`. Whether the reply beats the
    // commit is a race the driver's 100ms poll loses now and then — this was a real
    // flake in test/e2e/pause.test.ts, on CI and locally. Refuse, so the mistake names
    // itself instead of surfacing as an intermittent timeout; the test's job is to
    // relay from a tab it is not about to move.
    if (sender && sender.tab && sender.tab.id === msg.id) {
      return { ok: false, error: "nav would navigate the tab it was relayed through" };
    }
    await browser.tabs.update(msg.id, { url: msg.url });
    return { ok: true };
  }
  if (msg && msg.cmd === "newTab") {
    const t = await browser.tabs.create({});
    return { id: t.id, url: t.url, cookieStoreId: t.cookieStoreId };
  }
  if (msg && msg.cmd === "tabs") {
    const tabs = await browser.tabs.query({});
    const names = {};
    for (const ci of await browser.contextualIdentities.query({})) names[ci.cookieStoreId] = ci.name;
    return tabs.map((t) => ({
      id: t.id, url: t.url, cookieStoreId: t.cookieStoreId, index: t.index,
      windowId: t.windowId,
      container: names[t.cookieStoreId] || "",
    }));
  }
  if (msg && msg.cmd === "containers") {
    return (await browser.contextualIdentities.query({})).map((c) => c.name);
  }
  if (msg && msg.cmd === "notifications") {
    return notifications;
  }
  return null;
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && /^https?:/.test(tab.url || "")) {
    reportTab(tabId, tab.cookieStoreId, tab.url);
  }
});

// Self-provision one container so a non-default cookieStoreId exists to observe.
// Opens about:blank; the harness navigates this tab to the local server, which
// triggers the onUpdated report above with the container's cookieStoreId.
(async () => {
  const identity = await browser.contextualIdentities.create({
    name: "probe",
    color: "blue",
    icon: "circle",
  });
  await browser.tabs.create({
    cookieStoreId: identity.cookieStoreId,
    url: "about:blank",
  });
})();
