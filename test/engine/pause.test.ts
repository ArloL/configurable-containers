import { describe, it, expect } from "vitest";
import { aFakeBrowser, aFakeClock } from "./mock-port";
import {
  createPause,
  MAX_RECORDED_HOSTS,
  MAX_RECORDED_URLS_PER_HOST,
  PAUSE_STORAGE_KEY,
  VARIED,
  type PauseState,
  type StoredPauseState,
} from "../../src/engine/pause";
import type { Decision } from "../../src/resolver/types";
import type { PauseStatusResponse } from "../../src/extension/pause-protocol";

const intoTemporary: Decision = { kind: "reopen", into: { kind: "temporary" } };
const intoWork: Decision = { kind: "reopen", into: { kind: "permanent", name: "Work" } };
const noAction: Decision = { kind: "stay" };
const intoDefault: Decision = { kind: "reopen", into: { kind: "default" } };

// A top-level navigation as the engine hands it over. Almost every hop is a GET; a POST is
// the one no rule can move, which is why the record keeps the method at all.
const get = (url: string) => ({ url, method: "GET" });
const post = (url: string) => ({ url, method: "POST" });

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
      // The DISK shape, not the in-memory one: this row has no `dropped`, exactly as a
      // recording written before the cap existed does not, and hydrate() fills it in.
    } satisfies StoredPauseState);
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // The armed set cannot be read inside the blocking handler, so this is the ordinary
    // path — a browser restart, not crash recovery.
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

  it("takes the two halves of the stored state separately, and each entry on its own", async () => {
    const browser = aFakeBrowser();
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: ["firefox-container-1", 7],
      recordings: "gone",
    });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // A half-written state is what a browser killed mid-persist leaves, and the half that
    // survived is the one that keeps a container unrouted. Dropping it with the other half
    // would resume routing in a container the user paused.
    expect(pause.snapshot()).toEqual({ armed: ["firefox-container-1"], recordings: [] });
    expect(browser.badgeText).toBe("1");
  });

  it("keeps the recordings when the armed half is the one that is wrong", async () => {
    const browser = aFakeBrowser();
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: "none",
      recordings: [
        { id: "1", cookieStoreId: "firefox-container-1", container: "tmp3", startedAt: 1, endedAt: 2, hosts: [] },
      ],
    });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // The other direction of the same split. A recording is the only thing CC keeps that
    // outlives the browser, and it is what a rule gets written from — dropping the whole
    // history because the flag beside it was unreadable throws away the work.
    expect(pause.snapshot().recordings).toHaveLength(1);
    expect(browser.badgeText).toBe("");
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

  it("records the host, the URL as a pasteable pattern, and the action it would have taken", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, get("https://payment.acme.test/3ds?token=secret"), intoTemporary);

    expect(pause.snapshot().recordings[0]!.hosts).toEqual([
      {
        host: "payment.acme.test",
        hits: 1,
        wouldHave: "a new temporary container",
        urls: [
          {
            pattern: "*://payment.acme.test/3ds*",
            hits: 1,
            methods: ["GET"],
            wouldHave: "a new temporary container",
          },
        ],
        dropped: 0,
      },
    ]);
  });

  it("collapses repeats of ONE url, so a redirect loop is a hit count rather than a list", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < 4; i++) pause.record(csid, get("https://login.ms.test/authorize?try=" + i), intoTemporary);

    // The query is not part of the pattern, so four hops that differ only there are one
    // row — the same collapse the host row does, one level down.
    expect(pause.snapshot().recordings[0]!.hosts[0]!.urls).toEqual([
      { pattern: "*://login.ms.test/authorize*", hits: 4, methods: ["GET"], wouldHave: "a new temporary container" },
    ]);
  });

  it("records the method, because a POST is the hop no rule can move", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, get("https://github.com/login/oauth/authorize"), noAction);
    pause.record(csid, post("https://github.com/login/oauth/authorize"), noAction);

    // `tabs.create` issues a GET, so a `reopen` for a request with a body is declined (F9)
    // however right the rule is. Reading POST off the row is what says the rule written
    // there has to be `inherit`/`ignore`.
    expect(pause.snapshot().recordings[0]!.hosts[0]!.urls[0]).toEqual({
      pattern: "*://github.com/login/oauth/authorize*",
      hits: 2,
      methods: ["GET", "POST"],
      wouldHave: "no action",
    });
  });

  it("stops claiming one answer for a host whose URLs resolved differently", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, get("https://github.com/some/repo"), intoWork);
    pause.record(csid, get("https://github.com/login/oauth/authorize"), noAction);

    // What a path-scoped rule looks like from the outside, and the whole reason the URL rows
    // exist. A host row still saying "Work" would send the reader to write the one rule that
    // breaks the sign-in.
    const [row] = pause.snapshot().recordings[0]!.hosts;
    expect(row!.wouldHave).toBe(VARIED);
    expect(row!.urls.map((u) => [u.pattern, u.wouldHave])).toEqual([
      ["*://github.com/some/repo*", "Work"],
      ["*://github.com/login/oauth/authorize*", "no action"],
    ]);
  });

  it("keeps a host's single answer when every URL under it agrees", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, get("https://github.com/a"), intoWork);
    pause.record(csid, get("https://github.com/b"), intoWork);

    expect(pause.snapshot().recordings[0]!.hosts[0]!.wouldHave).toBe("Work");
  });

  it("keeps the host row for a URL no pattern can name", async () => {
    const { pause, csid } = await anArmedPause();

    // An IPv6 literal cannot be a pattern's host. Storing the URL raw would put text next to
    // a Copy button that the config editor then refuses.
    pause.record(csid, get("http://[::1]/admin"), intoTemporary);

    expect(pause.snapshot().recordings[0]!.hosts[0]).toMatchObject({ host: "[::1]", hits: 1, urls: [] });
  });

  it("collapses a bounce into one row and counts the hops", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < 7; i++) pause.record(csid, get(`https://login.ms.test/step${i}`), intoTemporary);

    // The deduplication is what turns a twelve-hop Microsoft bounce into the handful of
    // lines a config is actually written from; the redirection-limit=0 workaround
    // produces the raw chain and leaves that collapse to the reader.
    const [row] = pause.snapshot().recordings[0]!.hosts;
    expect(row).toMatchObject({ host: "login.ms.test", hits: 7 });
    // The collapse holds at the host. The URLs below it stay separate rows, because seven
    // paths at one host is precisely what a path-scoped rule is written from.
    expect(row!.urls).toHaveLength(7);
  });

  it("names the default container in words, since it has no name of its own", async () => {
    const { pause, csid } = await anArmedPause();

    // An `inherit` rule on a tab with nothing to inherit from resolves here. The record is
    // read to decide whether a rule was needed, and a blank where the target belongs reads
    // as a row that failed to record rather than as one whose target is the default.
    pause.record(csid, get("https://docs.example/a"), intoDefault);

    expect(pause.snapshot().recordings[0]!.hosts[0]!.wouldHave).toBe("the default container");
  });

  it("keeps first-seen order and records hops it would NOT have moved", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, get("https://shop.test/cart"), noAction);
    pause.record(csid, get("https://payment.acme.test/"), intoWork);

    // "Was it even needed?" is only answerable if the untouched hops are visible too —
    // the ones carrying a real target are then the ones that stand out.
    expect(pause.snapshot().recordings[0]!.hosts.map((h) => [h.host, h.wouldHave])).toEqual([
      ["shop.test", "no action"],
      ["payment.acme.test", "Work"],
    ]);
  });

  it("stores no query — a checkout URL's is where the session token is", async () => {
    const { browser, pause, csid } = await anArmedPause();

    pause.record(csid, get("https://payment.acme.test/confirm?session=SECRET123"), intoTemporary);
    await browser.settle();

    // The path IS stored now, because a rule is written at one. The query is not, and the
    // pattern's trailing `*` is what lets a path-only rule still match the URL that carried
    // it.
    const stored = JSON.stringify(await browser.port.readStored(PAUSE_STORAGE_KEY));
    expect(stored).not.toContain("SECRET123");
    expect(stored).toContain("*://payment.acme.test/confirm*");
  });

  it("ignores a navigation in a container that is not armed", async () => {
    const { pause } = await anArmedPause();

    pause.record("firefox-container-77", get("https://elsewhere.test/"), intoTemporary);

    expect(pause.snapshot().recordings[0]!.hosts).toEqual([]);
  });

  it("writes through when a new host appears, so a config save cannot destroy the record", async () => {
    const { browser, pause, csid } = await anArmedPause();

    pause.record(csid, get("https://payment.acme.test/"), intoTemporary);
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
      pause.record(csid, get(`https://host${i}.test/`), intoTemporary);
    }

    const recording = pause.snapshot().recordings[0]!;
    expect(recording.hosts).toHaveLength(MAX_RECORDED_HOSTS);
    // First-seen order, so what survives is the head of the flow the user armed for.
    expect(recording.hosts[0]!.host).toBe("host0.test");
  });

  it("counts the hosts it did not record, rather than truncating in silence", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_HOSTS + 3; i++) {
      pause.record(csid, get(`https://host${i}.test/`), intoTemporary);
    }

    // Rules get written FROM this list. A reader who takes a capped list for the whole of
    // what CC saw writes rules that miss the host that actually broke, which is the silent
    // wrong answer the count exists to prevent.
    expect(pause.snapshot().recordings[0]!.dropped).toBe(3);
  });

  // In memory the count is always present — that is the difference between `Recording` and
  // the `StoredRecording` a previous build may have left on disk, and it is what keeps the
  // blocking handler from asking "did this key exist yet?" about a row it is incrementing.
  // A recording that has dropped nothing says zero.
  it("counts nothing dropped while the recording is under the cap", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, get("https://payment.acme.test/"), intoTemporary);

    expect(pause.snapshot().recordings[0]!.dropped).toBe(0);
  });

  it("still counts hops on a host it already holds after the cap is reached", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_HOSTS + 1; i++) pause.record(csid, get(`https://host${i}.test/`), intoTemporary);
    pause.record(csid, get("https://host0.test/again"), intoTemporary);

    // The cap is on distinct hosts, not on the recording: a bounce through a host already
    // named is still the evidence the user armed for.
    expect(pause.snapshot().recordings[0]!.hosts[0]).toMatchObject({
      host: "host0.test",
      hits: 2,
      wouldHave: "a new temporary container",
    });
  });

  it("writes nothing more once the cap is reached", async () => {
    const { browser, pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_HOSTS; i++) pause.record(csid, get(`https://host${i}.test/`), intoTemporary);
    await browser.settle();
    const before = JSON.stringify(await browser.port.readStored(PAUSE_STORAGE_KEY));

    for (let i = 0; i < 50; i++) pause.record(csid, get(`https://overflow${i}.test/`), intoTemporary);
    await browser.settle();

    // The other half of what an abandoned recording cost: every new host was a write of the
    // whole pause state from the blocking path. Past the cap there is nothing new to write.
    expect(JSON.stringify(await browser.port.readStored(PAUSE_STORAGE_KEY))).toBe(before);
  });

  it("stops the URL list at its own cap, and counts what it did not record", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < MAX_RECORDED_URLS_PER_HOST + 5; i++) {
      pause.record(csid, get(`https://shop.test/product/${i}`), intoTemporary);
    }

    // A URL row grows with BROWSING, not with the handful of hops a flow makes, which is why
    // its cap is far below the host one — and why it is counted rather than silent for the
    // same reason `dropped` is on the recording.
    const [row] = pause.snapshot().recordings[0]!.hosts;
    expect(row!.urls).toHaveLength(MAX_RECORDED_URLS_PER_HOST);
    expect(row!.dropped).toBe(5);
    // The hops past it still count at the host, so `×N` does not lie either.
    expect(row!.hits).toBe(MAX_RECORDED_URLS_PER_HOST + 5);
  });

  it("writes the URL cap through once, not on every hop past it", async () => {
    const { browser, pause, csid } = await anArmedPause();
    for (let i = 0; i <= MAX_RECORDED_URLS_PER_HOST; i++) {
      pause.record(csid, get(`https://shop.test/product/${i}`), intoTemporary);
    }
    await browser.settle();
    const before = browser.storageWrites;

    for (let i = 0; i < 20; i++) pause.record(csid, get(`https://shop.test/past/${i}`), intoTemporary);
    await browser.settle();

    // Every write here comes off the blocking path. A capped recording that still wrote per
    // navigation would cost the most in exactly the session that overran it.
    expect(browser.storageWrites).toBe(before);
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
    // And a host row from before URL detail existed is UPGRADED rather than trusted as it
    // stands: `record()` and the options page both read `urls`, and an undefined one would
    // throw — in `record()`'s case inside the blocking handler, where a throw is a
    // navigation that never completes.
    expect(pause.snapshot().recordings[0]!.hosts[0]).toEqual({
      host: "old.test",
      hits: 4,
      wouldHave: "no action",
      urls: [],
      dropped: 0,
    });
  });

  it("drops a row of the wrong shape and keeps the rest of the recording", async () => {
    const browser = aFakeBrowser();
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: [],
      recordings: [
        {
          id: "1",
          cookieStoreId: "firefox-container-1",
          container: "tmp3",
          startedAt: 1,
          endedAt: null,
          hosts: [
            "not a host row",
            // Object-shaped but missing the fields a row is: the options page renders
            // `host` and `hits` straight, so a row without them is not a partial row.
            { host: "pay.test", hits: "many", wouldHave: "no action" },
            { host: "pay.test", hits: 1, wouldHave: "no action", urls: ["not a url row", { pattern: 7 }] },
          ],
        },
        "not a recording",
      ],
    });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    const [recording, ...rest] = pause.snapshot().recordings;
    expect(rest).toEqual([]);
    expect(recording!.hosts).toEqual([
      { host: "pay.test", hits: 1, wouldHave: "no action", urls: [], dropped: 0 },
    ]);
  });

  it("keeps a stored drop count, which is the whole point of having written it down", async () => {
    const browser = aFakeBrowser();
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: [],
      recordings: [
        { id: "1", cookieStoreId: "firefox-container-9", container: "tmp3", startedAt: 1, endedAt: 2, hosts: [], dropped: 12 },
      ],
    });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.hydrate();

    // A recording is read back long after the browser that wrote it: a count that survived
    // the write and not the read tells the reader the list is complete when it is not.
    expect(pause.snapshot().recordings[0]!.dropped).toBe(12);
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

    // One URL, hit three times — a redirect loop rather than three pages. A different path
    // each time is a new row, which IS new information and does write.
    for (let i = 0; i < 3; i++) {
      pause.record(shop.cookieStoreId, get(`https://login.ms.test/authorize?hop=${i}`), intoTemporary);
    }
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

describe("pause — arming twice, and disarming what is not there", () => {
  it("treats a second arm of the same container as the state it already is in", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    await pause.arm(shop.cookieStoreId);
    const again = await pause.arm(shop.cookieStoreId);

    // The toolbar and the options page can both be looking at one container, so the second
    // arm is a real sequence rather than a mistake. Opening a second recording for it would
    // split one flow's hosts across two rows and leave `running()` picking whichever came
    // first.
    expect(again).toEqual({ ok: true, container: "tmp3" });
    expect(pause.snapshot().recordings).toHaveLength(1);
  });

  it("says so rather than reporting success when the container was not paused", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    expect(await pause.disarm(shop.cookieStoreId)).toEqual({ ok: false, reason: "It was not paused." });
  });

  it("disarms a container whose recording is gone, naming what it can", async () => {
    const browser = aFakeBrowser();
    // The armed set outlives its recording: `clearAll` empties the list, and the cap drops
    // the oldest. Refusing to disarm here would leave the container unrouted with nothing
    // in the options page to turn it off with.
    await browser.port.writeStored(PAUSE_STORAGE_KEY, { armed: ["firefox-container-1"], recordings: [] });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.hydrate();

    expect(await pause.disarm("firefox-container-1")).toEqual({ ok: true, container: "that container" });
    expect(pause.isPaused("firefox-container-1")).toBe(false);
    expect(browser.badgeText).toBe("");
  });
});

describe("pause — the options page's questions", () => {
  const status = (pause: ReturnType<typeof createPause>) =>
    pause.handleMessage({ type: "cc-pause-status" }) as Promise<PauseStatusResponse>;

  it("lists a container's hosts once each, and counts a tab that has none", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    browser.existingTab({ url: "https://shop.test/cart", cookieStoreId: shop.cookieStoreId });
    browser.existingTab({ url: "https://shop.test/pay", cookieStoreId: shop.cookieStoreId });
    browser.existingTab({ url: "about:blank", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    const row = (await status(pause)).containers[0]!;

    // The host list identifies the container; repeating "shop.test" three times pushes the
    // one host that would tell them apart off the end of the row. The blank tab still
    // counts, because the container is occupied either way.
    expect(row.hosts).toEqual(["shop.test"]);
    expect(row.tabCount).toBe(3);
  });

  // The projection across the realm boundary, which is what the three-type split bought.
  //
  // `Recording` (in memory), `StoredRecording` (on disk) and `RecordingView` (what the page
  // renders) used to be one declaration, so every field was every consumer's business and a
  // change made for the renderer landed in a schema the blocking handler mutates. The
  // clearest proof they are separate now is a field that does NOT cross: the page names a
  // container by its display name and has no use for a store id, so `cookieStoreId` stays on
  // this side. Asserting the whole object rather than a key or two is deliberate — an
  // inventory catches a field added to the model and shipped by accident, which a spot check
  // would not.
  it("sends the page a view of a recording, not the model it keeps", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const clock = aFakeClock();
    const pause = createPause({ port: browser.port, clock: clock.clock });
    await pause.arm(shop.cookieStoreId);
    pause.record(shop.cookieStoreId, post("https://payment.acme.test/3ds"), intoWork);

    const view = (await status(pause)).recordings[0]!;

    expect(view).toEqual({
      id: expect.any(String),
      container: "tmp3",
      startedAt: expect.any(Number),
      endedAt: null,
      dropped: 0,
      hosts: [
        {
          host: "payment.acme.test",
          hits: 1,
          wouldHave: "Work",
          dropped: 0,
          urls: [{ pattern: "*://payment.acme.test/3ds*", hits: 1, methods: ["POST"], wouldHave: "Work" }],
        },
      ],
    });
    // The model still holds it; the wire does not.
    expect(pause.snapshot().recordings[0]!.cookieStoreId).toBe(shop.cookieStoreId);
    expect(view).not.toHaveProperty("cookieStoreId");
  });

  it("refuses a toggle that names no container", async () => {
    const browser = aFakeBrowser();
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    // The one message in CC that names a container instead of deriving it from the sender.
    expect(await pause.handleMessage({ type: "cc-pause-toggle" })).toEqual({
      ok: false,
      message: "No container named.",
    });
  });

  it("declines a cc-pause- message it does not know, synchronously", async () => {
    const browser = aFakeBrowser();
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });

    // The wiring dispatches the whole `cc-pause-` PREFIX here, so an unknown one under it
    // reaches this handler rather than the wiring's own fallthrough. Asserted un-awaited:
    // `await` would flatten a Promise<undefined> to undefined and pass either way.
    expect(pause.handleMessage({ type: "cc-pause-nonsense" })).toBeUndefined();
  });
});

describe("pause — what a failing browser call must not break", () => {
  it("records nothing for a url the parser refuses", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);

    pause.record(shop.cookieStoreId, { url: "not a url", method: "GET" }, noAction);

    // The engine only ever hands this http(s), so the guard is for the seam rather than for
    // a case it has: `record` is called from inside the blocking handler and returns void,
    // so a throw here is a navigation that never completes, not a missing row.
    expect(pause.snapshot().recordings[0]!.hosts).toEqual([]);
  });

  it("keeps the row in memory when the write that would have saved it fails", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);
    browser.storageWritesFail(true);

    pause.record(shop.cookieStoreId, get("https://pay.test/checkout"), intoWork);
    await browser.settle();

    // `record` is called from inside the blocking handler and floats the write, so a
    // storage failure here would otherwise be an unhandled rejection ON A NAVIGATION. What
    // is lost is the write, not the row: the next new host writes the whole state again.
    expect(pause.snapshot().recordings[0]!.hosts[0]!.host).toBe("pay.test");
  });

  it("survives a storage write that fails under the toolbar button", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    browser.storageWritesFail(true);

    await browser.clicksAction(tab);
    await browser.settle();

    // The click handler floats its promise, as everything reached from a browser event
    // here does. Without the catch this is an unhandled rejection, and in Firefox that is
    // the background context taking the failure rather than the feature.
    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
  });

  it("survives a storage write that fails while disarming an emptied container", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock().clock });
    await pause.arm(shop.cookieStoreId);
    browser.storageWritesFail(true);

    await browser.closesTab(tab);
    await browser.settle();

    expect(browser.notifications).toEqual([]);
  });
});
