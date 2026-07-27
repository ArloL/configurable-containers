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
