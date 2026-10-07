import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  awaitContainerTab,
  awaitTab,
  listContainers,
  navigateToContainerTab,
  type Session,
} from "../../harness/firefox";
import type { Page } from "../../harness/browser/index";
import { REDIRECT_TARGET_HOST } from "../../harness/server";

// `inherit` takes a throwaway to the sign-in host; the way back is a cross-site navigation
// of its own, and only a sign-in page the tab is ON lets it stay. That makes these cases
// about one browser fact L3 hands the engine for free: the tab reads the provider's url by
// the time the return's request is decided — after a link, after a POST answered with a
// 302, and in a popup window that has no opener tab to read.
//
// The app is REDIRECT_TARGET_HOST because the server's /redirect can only send a browser
// there.
const SSO_CONFIG = `
rules:
  - match: sso.example
    inherit: true
  - match: work.example
    open: Work
`;

describe("a sign-in round trip from a throwaway (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let at: (host: string, path?: string) => string;
  // Parked in Work and never navigated, so the probe's replies have a document to land in.
  let relay: Page;

  beforeAll(async () => {
    firefox = await launch({
      extensions: ["cc"],
      configYaml: SSO_CONFIG,
      localDomains: [REDIRECT_TARGET_HOST, "sso.example", "work.example"],
    });
    const port = new URL(firefox.serverUrl).port;
    at = (host, path = "/") => `http://${host}:${port}${path}`;
    relay = (await navigateToContainerTab(firefox.browser, at("work.example", "/?cb=relay"))).page;
  }, 120_000);

  afterAll(async () => {
    await firefox?.close();
  });

  const withLink = (url: string, link: string, mode: "same" | "post" | "popup") =>
    `${url}${url.includes("?") ? "&" : "?"}${mode}=1&link=${encodeURIComponent(link)}`;

  async function startApp(linkToSso: string, mode: "same" | "popup") {
    const appUrl = withLink(at(REDIRECT_TARGET_HOST, "/app"), linkToSso, mode);
    const app = await navigateToContainerTab(firefox.browser, appUrl);
    expect(app.name).toMatch(/^tmp\d+$/);
    return { app, containersBefore: await listContainers(relay) };
  }

  it("comes home after the provider showed a page", async () => {
    const home = at(REDIRECT_TARGET_HOST, "/callback?code=c");
    const ssoUrl = withLink(at("sso.example", "/login"), home, "same");
    const { app, containersBefore } = await startApp(ssoUrl, "same");

    await app.page.locator("#go").click();
    const sso = await awaitContainerTab(firefox.browser, ssoUrl);
    expect(sso.store).toBe(app.store);
    await sso.page.locator("#go").click();

    const landed = await awaitTab(relay, (t) => t.url === home);
    expect(landed.cookieStoreId).toBe(app.store);
    expect(await listContainers(relay)).toEqual(containersBefore);
  }, 60_000);

  // GitHub's "Authorize": a POST from the provider's page, answered 302 to the app. The
  // POST is never reopened, and its redirect is a GET on the same requestId.
  it("comes home through a POST the provider answers with a redirect", async () => {
    const home = at(REDIRECT_TARGET_HOST);
    const ssoUrl = withLink(at("sso.example", "/consent"), at("sso.example", "/redirect"), "post");
    const { app, containersBefore } = await startApp(ssoUrl, "same");

    await app.page.locator("#go").click();
    const sso = await awaitContainerTab(firefox.browser, ssoUrl);
    expect(sso.store).toBe(app.store);
    await sso.page.locator("#go").click();

    const landed = await awaitTab(relay, (t) => t.url === home);
    expect(landed.cookieStoreId).toBe(app.store);
    expect(await listContainers(relay)).toEqual(containersBefore);
  }, 60_000);

  it("comes home in a sign-in popup", async () => {
    const home = at(REDIRECT_TARGET_HOST, "/popup-callback?code=c");
    const ssoUrl = withLink(at("sso.example", "/login"), home, "same");
    const { app, containersBefore } = await startApp(ssoUrl, "popup");

    await app.page.locator("#go").click();
    const sso = await awaitContainerTab(firefox.browser, ssoUrl);
    expect(sso.store).toBe(app.store);
    await sso.page.locator("#go").click();

    const landed = await awaitTab(relay, (t) => t.url === home);
    expect(landed.cookieStoreId).toBe(app.store);
    expect(await listContainers(relay)).toEqual(containersBefore);
  }, 60_000);
});
