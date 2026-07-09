const REPORT_PREFIX = "CSID:";

// Surface a tab's cookieStoreId into its document.title so an external driver
// (Playwright) can read it via page.title(). Only http(s) pages are injectable.
async function reportTab(tabId, cookieStoreId) {
  try {
    await browser.tabs.executeScript(tabId, {
      code: "document.title = " + JSON.stringify(REPORT_PREFIX + cookieStoreId) + ";",
    });
  } catch (_e) {
    // about:, view-source:, moz-extension: pages cannot be injected — ignore.
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && /^https?:/.test(tab.url || "")) {
    reportTab(tabId, tab.cookieStoreId);
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