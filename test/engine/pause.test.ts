import { describe, it, expect } from "vitest";
import { aFakeBrowser, aFakeClock } from "./mock-port";
import { createPause, PAUSE_STORAGE_KEY, type PauseState } from "../../src/engine/pause";

describe("pause — arming", () => {
  it("arms a real container, names it, and shows the count on the badge", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    const result = await pause.arm(shop.cookieStoreId);

    expect(result).toEqual({ ok: true, container: "tmp3" });
    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
    expect(browser.badgeText).toBe("1");
  });

  it("refuses the default container, with a reason rather than a silent no-op", async () => {
    const browser = aFakeBrowser();
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    const result = await pause.arm("firefox-default");

    // A scope decision, not a technical limit: pausing the default container is close
    // enough to pausing globally that it should be its own deliberate feature.
    expect(result.ok).toBe(false);
    expect(pause.isPaused("firefox-default")).toBe(false);
    expect(browser.badgeText).toBe("");
  });

  it("refuses a container that no longer exists", async () => {
    const browser = aFakeBrowser();
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    expect((await pause.arm("firefox-container-99")).ok).toBe(false);
  });

  it("stores the container's name at arm time, so a disposed throwaway is still readable", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const clock = aFakeClock();
    await clock.advance(5_000);
    const pause = createPause({ port: browser.port, clock: clock.clock });

    await pause.arm(shop.cookieStoreId);
    await browser.port.removeIdentity(shop.cookieStoreId);

    // The disposer deletes a throwaway minutes after the flow ends, so by review time
    // getIdentity() returns null — a recording that cannot say where it came from is
    // unreadable.
    const [recording] = pause.snapshot().recordings;
    expect(recording).toMatchObject({ container: "tmp3", startedAt: 5_000, endedAt: null, hosts: [] });
  });

  it("disarming stamps the recording's end and clears the badge", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const clock = aFakeClock();
    const pause = createPause({ port: browser.port, clock: clock.clock });

    await pause.arm(shop.cookieStoreId);
    await clock.advance(60_000);
    await pause.disarm(shop.cookieStoreId);

    expect(pause.isPaused(shop.cookieStoreId)).toBe(false);
    expect(pause.snapshot().recordings[0].endedAt).toBe(60_000);
    expect(browser.badgeText).toBe("");
  });

  it("hydrates the armed set from storage, because the check cannot read storage later", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: [shop.cookieStoreId],
      recordings: [
        { id: "1", cookieStoreId: shop.cookieStoreId, container: "tmp3", startedAt: 1, endedAt: null, hosts: [] },
      ],
    } satisfies PauseState);
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // Every config save calls runtime.reload(), so this is the ordinary path, not a
    // crash-recovery one.
    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
    expect(browser.badgeText).toBe("1");
  });

  it("treats a stored value of the wrong shape as absent rather than trusting it", async () => {
    const browser = aFakeBrowser();
    await browser.port.writeStored(PAUSE_STORAGE_KEY, "not a pause state");
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // A corrupt value must not be able to leave a container unrouted.
    expect(pause.snapshot()).toEqual({ armed: [], recordings: [] });
  });
});
