import { describe, it, beforeAll, afterAll } from "vitest";
import {
  launch,
  awaitContainerTab,
  listTabs,
  listContainers,
  probeCommand,
  type Session,
} from "../../harness/firefox";

// INVESTIGATION ONLY — logs what real Firefox shows an extension while it loads
// `view-source:<url>`, so the fix can be built on an observed fact rather than a guess.
// Asserts nothing on purpose: the run exists to print.
describe("view-source investigation (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  }, 120_000);

  afterAll(async () => {
    await firefox?.close();
  });

  it("reports what the browser tells an extension about a view-source load", async () => {
    const pageUrl = `http://nomatch.example:${serverPort}/`;

    // Park on the page, in the throwaway CC routes it into. This tab is the command
    // relay, and nothing below navigates it.
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(pageUrl);
    } catch {
      // CC reopened the tab away — expected.
    }
    const parked = await awaitContainerTab(firefox.driver, pageUrl);
    console.log("[view-source] parked on", pageUrl, "in", parked.name, parked.store);

    const before = await listTabs(firefox.driver);
    const opened = await probeCommand(firefox.driver, "viewSource", { url: pageUrl }, 15_000);
    console.log("[view-source] open attempt:", JSON.stringify(opened, null, 2));

    await firefox.driver.sleep(5000);

    const observed = await probeCommand(firefox.driver, "observed", {}, 15_000);
    console.log("[view-source] observed events:", JSON.stringify(observed, null, 2));
    console.log("[view-source] tabs before:", JSON.stringify(before, null, 2));
    console.log("[view-source] tabs after:", JSON.stringify(await listTabs(firefox.driver), null, 2));
    console.log("[view-source] containers:", JSON.stringify(await listContainers(firefox.driver)));
  }, 120_000);
});
