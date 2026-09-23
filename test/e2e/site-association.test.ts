import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  associateSite,
  awaitContainerTab,
  awaitProbeReport,
  awaitTab,
  listContainers,
  listTabs,
  navigateTab,
  navigateToContainerTab,
  openTab,
  readCookieNamesDefault,
  readCookieNamesHere,
  readDecisions,
  readSeenCookie,
  type Session,
} from "../../harness/firefox";
import type { Page } from "../../harness/browser";

// F16: with `privacy.containers.switchDuringNavigation.enabled`, Firefox 155+ moves a load to
// a host it associates with a container into that container, and moves CC's reopen too. CC
// must stand aside rather than fight it. Skipped where the API is missing (the ESR leg).
describe("Firefox site associations (real Firefox, CC + probe, switching on)", () => {
  let firefox: Session;
  let port: string;
  let relay: Page;
  const url = (host: string, path = "/") => `http://${host}:${port}${path}`;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"], switchDuringNavigation: true });
    port = new URL(firefox.serverUrl).port;
    relay = (await navigateToContainerTab(firefox.browser, url("hop.example"))).page;
  }, 120_000);

  afterAll(async () => {
    await firefox?.close();
  });

  it("leaves an associated unmatched host to Firefox, minting no throwaway", async (ctx) => {
    if (!(await associateSite(relay, "nomatch.example", "Native"))) return ctx.skip();
    const throwawaysBefore = (await listContainers(relay)).filter((c) => c.startsWith("tmp"));

    await openTab(relay, url("nomatch.example"));
    await awaitTab(relay, (t) => t.url === url("nomatch.example") && t.container === "Native");

    expect((await listContainers(relay)).filter((c) => c.startsWith("tmp"))).toEqual(throwawaysBefore);
    expect((await readDecisions(relay)).map((d) => d.outcome)).toContain(
      "deferred: Firefox is moving this load into the container it associates with the site (F16)",
    );
  }, 60_000);

  // Measured before the fix: CC reopened into Work and kept the source tab, which had a page,
  // and Firefox moved the reopen straight back. One extra tab per click.
  it("keeps a click inside an associated tab in that one tab", async (ctx) => {
    if (!(await associateSite(relay, "work.example", "Native"))) return ctx.skip();

    await openTab(relay, url("work.example"));
    const tab = await awaitTab(relay, (t) => t.url === url("work.example") && t.container === "Native");
    await navigateTab(relay, tab.id, url("work.example", "/next"));
    await awaitTab(relay, (t) => t.url === url("work.example", "/next") && t.container === "Native");

    const onSite = (await listTabs(relay)).filter((t) => t.url.startsWith(url("work.example")));
    expect(onSite.map((t) => ({ id: t.id, container: t.container }))).toEqual([{ id: tab.id, container: "Native" }]);
  }, 60_000);

  // Firefox builds the channel in the associated container before it hands the load to a new
  // tab, so the tab the seeder is asked about still reads the default store.
  it("seeds the rule's cookies into the container Firefox moved the load to", async (ctx) => {
    if (!(await associateSite(relay, "work.example", "Native"))) return ctx.skip();

    await openTab(relay, url("work.example", "/seeded"));
    const { page, name } = await awaitContainerTab(firefox.browser, url("work.example", "/seeded"));
    await awaitProbeReport(page);

    expect(name).toBe("Native");
    expect(await readSeenCookie(page)).toContain("seed=1");
    expect(await readCookieNamesHere(page)).toContain("seed");
    expect(await readCookieNamesDefault(page)).not.toContain("seed");
  }, 60_000);
});
