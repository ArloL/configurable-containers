// Dump Multi-Account Containers state to the JSON shape used by this repo's
// `multi-account-containers.json` fixture.
//
// HOW TO RUN
//   1. Open about:debugging#/runtime/this-firefox
//   2. Find "Multi-Account Containers" and click "Inspect"
//   3. In the DevTools Console, paste this whole file and press Enter
//   4. A new tab opens with the raw JSON — Ctrl/Cmd+S to save it, or
//      select-all + copy. Paste it into multi-account-containers.json.
//
// Delivery is via a tab (not the console's copy() helper): the extension's
// background page has no clipboard focus, so copy() reports success while
// silently copying nothing.
//
// The output is stable across machines: containers keep contextualIdentities
// order, assignments are sorted by domain — so two dumps diff cleanly.

(async () => {
  // MAC stores site assignments under storage.local with this key prefix.
  const PREFIX = "siteContainerMap@@_";

  const identities = await browser.contextualIdentities.query({});
  const containers = identities.map(({ name, color, icon }) => ({
    name,
    color,
    icon,
  }));

  const store = await browser.storage.local.get();
  const assignments = Object.entries(store)
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([key, value]) => ({
      domain: key.slice(PREFIX.length),
      container: String(value.userContextId),
      neverAsk: Boolean(value.neverAsk),
    }))
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

  // Trailing newline matches the committed file, so paste-and-save diffs clean.
  const json = JSON.stringify({ containers, assignments }, null, 2) + "\n";

  console.log(
    `%cMAC dump: ${containers.length} containers, ${assignments.length} assignments`,
    "font-weight:bold",
  );

  // Open the JSON in a tab via a blob URL — reliable from a background page,
  // no clipboard focus or extra permissions needed. Save with Ctrl/Cmd+S.
  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  await browser.tabs.create({ url });
  console.log("Opened dump in a new tab:", url);

  return json;
})();
