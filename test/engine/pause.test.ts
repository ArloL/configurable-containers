import { describe, it, expect } from "vitest";
import { aFakeBrowser, aFakeClock } from "./mock-port";
import { createPause, MAX_RECORDED_HOSTS, PAUSE_STORAGE_KEY, type PauseState } from "../../src/engine/pause";
import type { Decision } from "../../src/resolver/types";

const intoTemporary: Decision = { kind: "reopen", into: { kind: "temporary" } };
const intoWork: Decision = { kind: "reopen", into: { kind: "permanent", name: "Work" } };
const noAction: Decision = { kind: "stay" };

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
    expect(pause.snapshot().recordings[0]!.endedAt).toBe(60_000);
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

describe("pause — recording", () => {
  async function anArmedPause() {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);
    return { browser, pause, csid: shop.cookieStoreId };
  }

  it("records the host and the action it would have taken", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, "https://payment.acme.test/3ds?token=secret", intoTemporary);

    expect(pause.snapshot().recordings[0]!.hosts).toEqual([
      { host: "payment.acme.test", hits: 1, wouldHave: "a new temporary container" },
    ]);
  });

  it("collapses a bounce into one row and counts the hops", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < 7; i++) pause.record(csid, `https://login.ms.test/step${i}`, intoTemporary);

    // The deduplication is what turns a twelve-hop Microsoft bounce into the handful of
    // lines a config is actually written from; the redirection-limit=0 workaround
    // produces the raw chain and leaves that collapse to the reader.
    expect(pause.snapshot().recordings[0]!.hosts).toEqual([
      { host: "login.ms.test", hits: 7, wouldHave: "a new temporary container" },
    ]);
  });

  it("keeps first-seen order and records hops it would NOT have moved", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, "https://shop.test/cart", noAction);
    pause.record(csid, "https://payment.acme.test/", intoWork);

    // "Was it even needed?" is only answerable if the untouched hops are visible too —
    // the ones carrying a real target are then the ones that stand out.
    expect(pause.snapshot().recordings[0]!.hosts).toEqual([
      { host: "shop.test", hits: 1, wouldHave: "no action" },
      { host: "payment.acme.test", hits: 1, wouldHave: "Work" },
    ]);
  });

  it("stores no path and no query — a checkout URL carries session tokens", async () => {
    const { browser, pause, csid } = await anArmedPause();

    pause.record(csid, "https://payment.acme.test/confirm?session=SECRET123", intoTemporary);
    await browser.settle();

    expect(JSON.stringify(await browser.port.readStored(PAUSE_STORAGE_KEY))).not.toContain("SECRET123");
  });

  it("ignores a navigation in a container that is not armed", async () => {
    const { pause } = await anArmedPause();

    pause.record("firefox-container-77", "https://elsewhere.test/", intoTemporary);

    expect(pause.snapshot().recordings[0]!.hosts).toEqual([]);
  });

  it("writes through when a new host appears, so a config save cannot destroy the record", async () => {
    const { browser, pause, csid } = await anArmedPause();

    pause.record(csid, "https://payment.acme.test/", intoTemporary);
    await browser.settle();

    // A record held only in memory is lost with the background context, and the flow worth
    // recording is exactly the one the user is still in the middle of. A save no longer ends
    // that context (it applies in place), but a browser restart does.
    const stored = (await browser.port.readStored(PAUSE_STORAGE_KEY)) as PauseState;
    expect(stored.recordings[0]!.hosts[0]!.host).toBe("payment.acme.test");
  });
});

describe("pause — the host cap", () => {
  async function anArmedPause() {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);
    return { browser, pause, csid: shop.cookieStoreId };
  }

  // The recordings LIST is capped by arm() and the armed set by the user; `hosts` was
  // capped by nothing, and it is the only structure CC keeps that a browser restart does
  // not empty — persist() writes the whole pause state into storage.local on each new host.
  // A container armed and forgotten grew it for as long as browsing continued.
  it("stops the host list at the cap instead of growing it for as long as browsing continues", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_HOSTS + 3; i++) {
      pause.record(csid, `https://host${i}.test/`, intoTemporary);
    }

    const recording = pause.snapshot().recordings[0]!;
    expect(recording.hosts).toHaveLength(MAX_RECORDED_HOSTS);
    // First-seen order, so what survives is the head of the flow the user armed for.
    expect(recording.hosts[0]!.host).toBe("host0.test");
  });

  it("counts the hosts it did not record, rather than truncating in silence", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_HOSTS + 3; i++) {
      pause.record(csid, `https://host${i}.test/`, intoTemporary);
    }

    // Rules get written FROM this list. A reader who takes a capped list for the whole of
    // what CC saw writes rules that miss the host that actually broke, which is the silent
    // wrong answer the count exists to prevent.
    expect(pause.snapshot().recordings[0]!.dropped).toBe(3);
  });

  it("leaves `dropped` unset while the recording is under the cap", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, "https://payment.acme.test/", intoTemporary);

    expect(pause.snapshot().recordings[0]!.dropped).toBeUndefined();
  });

  it("still counts hops on a host it already holds after the cap is reached", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_HOSTS + 1; i++) pause.record(csid, `https://host${i}.test/`, intoTemporary);
    pause.record(csid, "https://host0.test/again", intoTemporary);

    // The cap is on distinct hosts, not on the recording: a bounce through a host already
    // named is still the evidence the user armed for.
    expect(pause.snapshot().recordings[0]!.hosts[0]).toEqual({
      host: "host0.test",
      hits: 2,
      wouldHave: "a new temporary container",
    });
  });

  it("writes nothing more once the cap is reached", async () => {
    const { browser, pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_HOSTS; i++) pause.record(csid, `https://host${i}.test/`, intoTemporary);
    await browser.settle();
    const before = JSON.stringify(await browser.port.readStored(PAUSE_STORAGE_KEY));

    for (let i = 0; i < 50; i++) pause.record(csid, `https://overflow${i}.test/`, intoTemporary);
    await browser.settle();

    // The other half of what an abandoned recording cost: every new host was a write of the
    // whole pause state from the blocking path. Past the cap there is nothing new to write.
    expect(JSON.stringify(await browser.port.readStored(PAUSE_STORAGE_KEY))).toBe(before);
  });

  it("keeps a recording stored by a build that had no cap", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: [shop.cookieStoreId],
      // No `dropped` key at all — the shape every recording written before the cap has.
      recordings: [
        { id: "1", cookieStoreId: shop.cookieStoreId, container: "tmp3", startedAt: 1, endedAt: 2, hosts: [{ host: "old.test", hits: 4, wouldHave: "no action" }] },
      ],
    });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // Validating `dropped` as required would read every pre-cap recording as corrupt and
    // drop the user's history over a key they never had.
    expect(pause.snapshot().recordings[0]!.hosts[0]!.host).toBe("old.test");
  });

  it("refuses a stored recording whose dropped count is not a number", async () => {
    const browser = aFakeBrowser();
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: [],
      recordings: [
        { id: "1", cookieStoreId: "firefox-container-9", container: "tmp3", startedAt: 1, endedAt: 2, hosts: [], dropped: "lots" },
      ],
    });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // Lenient about absent, strict about present: the options page renders this number.
    expect(pause.snapshot().recordings).toEqual([]);
  });
});

describe("pause — flushing the hit counts", () => {
  it("disarming writes the hops accumulated since the last new host", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);

    for (let i = 0; i < 3; i++) pause.record(shop.cookieStoreId, `https://login.ms.test/${i}`, intoTemporary);
    await browser.settle();
    // Repeat hops deliberately do not write — seven storage writes from the blocking
    // path is the cost that buys. So the flush has to happen somewhere, and disarm is
    // where: a finished recording's counts must be right.
    expect(((await browser.port.readStored(PAUSE_STORAGE_KEY)) as PauseState).recordings[0]!.hosts[0]!.hits).toBe(1);

    await pause.disarm(shop.cookieStoreId);

    expect(((await browser.port.readStored(PAUSE_STORAGE_KEY)) as PauseState).recordings[0]!.hosts[0]!.hits).toBe(3);
  });
});

describe("pause — lifetime", () => {
  it("disarms when the armed container's last tab closes", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);

    await browser.closesTab(tab);
    await browser.settle();

    // There is no timer: an expiry firing mid-checkout reproduces exactly the failure
    // the pause exists to prevent, and unpredictably. For a throwaway, last-tab-close is
    // the container's whole life.
    expect(pause.isPaused(shop.cookieStoreId)).toBe(false);
    expect(pause.snapshot().recordings[0]!.endedAt).not.toBeNull();
    expect(browser.badgeText).toBe("");
  });

  it("stays armed while another tab in that container is still open", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const first = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    browser.existingTab({ url: "https://shop.test/cart", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);

    await browser.closesTab(first);
    await browser.settle();

    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
  });

  it("leaves an unarmed container's tabs alone", async () => {
    const browser = aFakeBrowser();
    const armedContainer = browser.addContainerNamed({ name: "tmp3" });
    browser.existingTab({ url: "https://shop.test/", cookieStoreId: armedContainer.cookieStoreId });
    const other = browser.addContainerNamed({ name: "tmp4" });
    const otherTab = browser.existingTab({ url: "https://elsewhere.test/", cookieStoreId: other.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(armedContainer.cookieStoreId);

    await browser.closesTab(otherTab);
    await browser.settle();

    // The sweep asks the browser which containers still have tabs, so an unrelated tab
    // closing must not end somebody else's recording.
    expect(pause.isPaused(armedContainer.cookieStoreId)).toBe(true);
  });
});

describe("pause — the toolbar button", () => {
  it("arms the container of the tab Firefox hands the click, and says which", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await browser.clicksAction(tab);

    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
    // The badge only ever reaches "1", so the toast is the one thing that names tmp3 —
    // and the user has no other way to confirm they hit the container they meant.
    expect(browser.notifications[0]!.message).toContain("tmp3");
  });

  it("a second click resumes routing", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await browser.clicksAction(tab);
    await browser.clicksAction(tab);

    expect(pause.isPaused(shop.cookieStoreId)).toBe(false);
    expect(browser.notifications).toHaveLength(2);
    expect(browser.notifications[1]!.message).toContain("tmp3");
  });

  it("refuses the default container out loud", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: "firefox-default" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await browser.clicksAction(tab);

    // A silent no-op is the worst outcome for a control reached for under time pressure.
    expect(pause.isPaused("firefox-default")).toBe(false);
    expect(browser.notifications[0]!.message).toContain("default container");
  });
});
