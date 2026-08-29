import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitTabs, listTabs, navigateToContainerTab, openTab, type Session,
} from "../../harness/firefox";
import type { Page } from "../../harness/browser/index";

// Nothing here waits a fixed time, and nothing here goes looking for a tab to decide it is
// absent. Both were how this file used to work, and both were wrong in the same direction:
//
//   - `waitForTabGone` polled the window handles and called "no tab shows this url" a pass.
//     A navigation that never happened satisfies that instantly, so the case went green with
//     the goto removed altogether — measured, not theorised. `tabs.create` RESOLVING with an
//     id is what proves the tab existed, and `awaitTabs` is what watches it go.
//   - `driver.sleep(1000)` stood in for "the delay has passed". It fails the wrong way: a
//     closer that is merely late leaves the tab there at 1s and the case passes. The closer
//     arms per tab, on that tab reaching `complete`, so a tab that loaded LATER and closed is
//     proof the delay elapsed for one that loaded earlier — an event, not a guess.
describe("redirector auto-close (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;
  // A matched host, so CC parks it in Work on the first visit and never touches it again:
  // every tab below is opened THROUGH it, and its document is where the probe's replies land.
  let relay: Page;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"], ccRedirectorDelayMs: 200 });
    serverPort = new URL(firefox.serverUrl).port;
    relay = (
      await navigateToContainerTab(firefox.browser, `http://work.example:${serverPort}/?cb=relay`)
    ).page;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("closes a redirector tab after the delay when it stays on the shim domain", async () => {
    // redirect.example resolves to `stay`, so the tab loads where it was opened and keeps
    // its id — and this reply is itself the observation that it was ever there.
    const opened = await openTab(relay, `http://redirect.example:${serverPort}/`);
    // The id is what the wait watches leave. Without one its predicate holds of any tab
    // list at all, so the case would pass green on a tab that never opened — which is the
    // failure the file comment above says this reply exists to rule out.
    expect(opened.id).toBeGreaterThan(0);

    await awaitTabs(relay, (tabs) => !tabs.some((tab) => tab.id === opened.id));
  });

  it("does NOT close a non-redirector tab after the same delay", async () => {
    // Loaded FIRST, so any timer it could have been given is armed before the redirector's.
    const survivorUrl = `http://work.example:${serverPort}/?survivor`;
    const survivor = await navigateToContainerTab(firefox.browser, survivorUrl);
    expect(survivor.name).toBe("Work");
    const survivorTab = (await listTabs(relay)).find((tab) => tab.url.startsWith(survivorUrl));
    expect(survivorTab, "the Work tab must be open before anything is asserted about it").toBeDefined();

    const redirector = await openTab(relay, `http://redirect.example:${serverPort}/?after`);

    // One settled snapshot: the redirector tab is gone, which means its timer has fired, which
    // means the Work tab's would have fired first if it had one. What the sleep was for.
    const after = await awaitTabs(relay, (tabs) => !tabs.some((tab) => tab.id === redirector.id));
    expect(
      after.some((tab) => tab.id === survivorTab!.id),
      "the Work tab must outlive the redirector tab that was opened after it",
    ).toBe(true);
  });
});
