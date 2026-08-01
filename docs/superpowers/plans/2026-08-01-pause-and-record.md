# Pause & Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user arm a container so CC stops routing inside it and records every top-level host it saw with the routing action it declined to take, for manual review afterwards.

**Architecture:** A new `src/engine/pause.ts` sibling owns the armed set, the recordings, their persistence and the badge. The engine consults it through a narrow **synchronous** interface at one point in `onBeforeRequest` — after `resolve()`, before the F9 non-GET check — and returns without acting. Two arming paths (toolbar button, options-page list) call one `arm()`.

**Tech Stack:** TypeScript, Firefox MV2 WebExtension, esbuild, Vitest (L1–L3) + Selenium/geckodriver (L4).

## Global Constraints

Copied from the design spec (`docs/superpowers/specs/2026-08-01-pause-and-record-design.md`) and `CLAUDE.md`. Every task's requirements implicitly include these.

- **`isPaused` must be synchronous and must not touch storage.** It runs inside a blocking `webRequest` listener that every top-level navigation waits on.
- **`record()` returns `void` and is never awaited by the engine.** A navigation must not wait on bookkeeping; a failed write must not break routing.
- **Every `browser.*` listener registers synchronously** as `background.ts` evaluates. Nothing in `wireBackground` may `await`.
- **The record never reaches `storage.sync`.** That namespace is the config mirror and the background is its only writer.
- **Hosts only in the record — no path, no query.**
- **`firefox-default` is never armable.**
- **The background is the single writer of pause state.** The options page reads and sends messages; it never writes the key.
- **Prefer CLI long options** (`--silent`, not `-s`).
- **Do not write "load-bearing"** in prose, comments or commit messages. Say what requires the thing and what breaks without it.
- **Comments carry the non-obvious *why*.** Do not restate the code.
- **Revert-verify every regression test**: back the fix out with an editor undo (never `git checkout`), watch it go red, restore it.
- Commit messages end with: `Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo`

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/pause.ts` *(new)* | Armed set, recordings, persistence, hydration, badge, toolbar-button handler, message handling. The whole feature except the DOM. |
| `src/extension/pause-protocol.ts` *(new)* | Message and row types shared by `pause.ts` and `options.ts`. Pure, no browser, no DOM — mirrors `picker-protocol.ts`. |
| `src/engine/port.ts` | +`setBadge`, +`onActionClicked`. |
| `src/engine/browser-port.ts` | Real adapters for both. |
| `src/engine/engine.ts` | +1 step (3a); export `targetLabel`/`Declinable`; `EngineOptions.pause`. |
| `src/engine/picker.ts` | Stops registering `onMessage`; exposes `handleMessage`. |
| `src/extension/wiring.ts` | Owns the single `onMessage` registration and dispatches; constructs `createPause`; gate awaits hydration. |
| `src/extension/options.ts` + `extensions/cc/options.html` | Arming list and recordings section. |
| `extensions/cc/manifest.json` | +`browser_action` (no `default_popup`). |
| `test/engine/pause.test.ts` *(new)* | L2/L3 for the module. |
| `test/engine/engine.test.ts` | The 3a step's cases. |
| `test/engine/restart.test.ts` | Survival across a restart. |
| `test/engine/mock-port.ts` | +`clicksAction`, +`badgeText`, +second message handler slot is **not** added (see Task 1). |
| `test/e2e/pause.test.ts` *(new)* | The L4 loop. |

---

### Task 1: One `onMessage` registration, owned by the wiring

`createPicker` registers `port.onMessage` itself. `mock-port` holds exactly one handler slot per event, so a second sibling registering would silently clobber the picker's L3 coverage; and in Firefox the picker's `async` handler returns a Promise for *every* message, which can swallow a reply meant for another listener. The router must exist before anything else can receive a message.

**Files:**
- Modify: `src/engine/picker.ts` (replace the `port.onMessage(...)` block, ~line 51)
- Modify: `src/extension/wiring.ts`
- Test: `test/engine/picker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Picker.handleMessage(msg: unknown, sender: MessageSender): Promise<unknown> | undefined` — returns `undefined` **synchronously** for a message that is not `cc-pick`. The wiring's dispatcher is internal; later tasks add a branch to it.

- [ ] **Step 1: Write the failing test**

Add to `test/engine/picker.test.ts`:

```ts
it("leaves a message that is not cc-pick unanswered, synchronously", async () => {
  const browser = aFakeBrowser();
  const tab = browser.existingTab({ url: "https://figma.example/", cookieStoreId: "firefox-default" });
  await startTheBackground(browser, aFakeClock(), figmaConfig());

  // A synchronous undefined is the only reply shape that leaves the channel free for
  // another listener; a Promise tells Firefox "I will answer this".
  expect(browser.port).toBeDefined();
  await expect(browser.receivesMessage({ type: "cc-not-ours" }, tab)).resolves.toBeUndefined();
});
```

Use whatever `aFakeClock()` / config helper `picker.test.ts` already has; if it constructs `createPicker` directly rather than via `startTheBackground`, keep that style and assert on the wiring test file instead (`test/engine/restart.test.ts` imports `startTheBackground`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --silent -- test/engine/picker.test.ts`
Expected: FAIL — the picker's own handler answers every message with a Promise.

- [ ] **Step 3: Make the picker expose a handler instead of registering one**

In `src/engine/picker.ts`, change the `Picker` interface and replace the registration:

```ts
export interface Picker {
  showChoice(tabId: number, url: string, options: string[]): Promise<void>;
  // The wiring owns the single runtime.onMessage registration and dispatches to this.
  // Registering here as well would clobber the other siblings' handler in mock-port
  // (one slot per event) and, in Firefox, answer messages that are not ours: an async
  // handler returns a Promise for every message, which claims the reply channel.
  handleMessage(msg: unknown, sender: MessageSender): Promise<PickResponse> | undefined;
}
```

```ts
  function handleMessage(msg: unknown, sender: MessageSender): Promise<PickResponse> | undefined {
    const m = msg as PickMessage;
    if (m?.type !== "cc-pick") return undefined;
    return (async () => {
      // The tab to consume is the one that spoke, not one the message names: the hash
      // payload a choice page renders from is attacker-reachable (a crafted
      // moz-extension://<id>/choice.html#… link), and so is anything derived from it.
      if (sender.tabId == null) return { ok: false } satisfies PickResponse;
      // Same reason the choice page only ever navigated to http(s): the url travels on
      // to port.createTab, and a javascript:/data: url there would run in a privileged
      // origin.
      if (!/^https?:/.test(m.url)) return { ok: false } satisfies PickResponse;
      const tab = await port.getTab(sender.tabId);
      if (!tab) return { ok: false } satisfies PickResponse;
      try {
        await reopen(tab, m.url, containerToTarget(m.container));
        return { ok: true } satisfies PickResponse;
      } catch {
        return { ok: false } satisfies PickResponse;
      }
    })();
  }
```

Delete the old `port.onMessage(async (msg, sender) => { … })` block, add `import type { MessageSender } from "./port";`, and return `{ showChoice, handleMessage }`.

- [ ] **Step 4: Register the dispatcher in the wiring**

In `src/extension/wiring.ts`, after `picker = createPicker({...})`:

```ts
  // The ONE runtime.onMessage registration. Siblings expose a handler and are dispatched
  // by `type` from here, because a second addListener would clobber the first in
  // mock-port (one handler slot per event) and, in Firefox, an async handler claims the
  // reply channel for every message including ones it does not own. Returning undefined
  // SYNCHRONOUSLY for an unknown type is what leaves that channel free.
  port.onMessage((msg, sender) => {
    const type = (msg as { type?: unknown } | null | undefined)?.type;
    if (type === "cc-pick") return picker.handleMessage(msg, sender);
    return undefined;
  });
```

- [ ] **Step 5: Run the full suite**

Run: `npm test --silent`
Expected: PASS, including every pre-existing picker and choice case.

- [ ] **Step 6: Revert-verify**

Temporarily re-add `port.onMessage(...)` inside `createPicker` (a duplicate registration). Run `npm test --silent -- test/engine/picker.test.ts` and confirm the new case goes red. Undo with the editor, never `git checkout`.

- [ ] **Step 7: Commit**

```bash
git add src/engine/picker.ts src/extension/wiring.ts test/engine/picker.test.ts
git commit -m "$(cat <<'EOF'
refactor: give the wiring the one runtime.onMessage registration

mock-port holds a single handler slot per event, so a second sibling
registering onMessage would replace the picker's without failing; in Firefox
the picker's async handler returns a Promise for every message, claiming the
reply channel for ones it does not own. The picker now exposes handleMessage
and the wiring dispatches on type.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 2: `pause.ts` — armed set, arm/disarm, persistence, badge

**Files:**
- Create: `src/engine/pause.ts`
- Modify: `src/engine/port.ts` (add `setBadge`), `src/engine/browser-port.ts`
- Modify: `test/engine/mock-port.ts` (add `badgeText`)
- Test: `test/engine/pause.test.ts` *(new)*

**Interfaces:**
- Consumes: `BrowserPort`, `Clock` from `src/engine/port.ts`.
- Produces:
  ```ts
  export const PAUSE_STORAGE_KEY = "pauseState";
  export const MAX_RECORDINGS = 10;
  export interface RecordedHost { host: string; hits: number; wouldHave: string }
  export interface Recording {
    id: string; cookieStoreId: string; container: string;
    startedAt: number; endedAt: number | null; hosts: RecordedHost[];
  }
  export interface PauseState { armed: string[]; recordings: Recording[] }
  export type ArmResult = { ok: true; container: string } | { ok: false; reason: string };
  export interface Pause {
    isPaused(cookieStoreId: string): boolean;                       // sync, no I/O
    record(cookieStoreId: string, url: string, decision: Decision): void;  // Task 3
    arm(cookieStoreId: string): Promise<ArmResult>;
    disarm(cookieStoreId: string): Promise<ArmResult>;
    hydrate(): Promise<void>;
    snapshot(): PauseState;
  }
  export function createPause(opts: { port: BrowserPort; clock: Clock }): Pause;
  ```
  `BrowserPort.setBadge(text: string): Promise<void>`; `MockPort.badgeText: string`.

- [ ] **Step 1: Write the failing tests**

Create `test/engine/pause.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createPause, PAUSE_STORAGE_KEY, type PauseState } from "../../src/engine/pause";

function aFakeClock(startAt = 1_000) {
  let now = startAt;
  return { setTimeout: (fn: () => void) => void fn, now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("pause — arming", () => {
  it("arms a real container, names it, and shows the count on the badge", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    const result = await pause.arm(shop.cookieStoreId);

    expect(result).toEqual({ ok: true, container: "tmp3" });
    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
    expect(browser.badgeText).toBe("1");
  });

  it("refuses the default container, with a reason rather than a silent no-op", async () => {
    const browser = aFakeBrowser();
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    const result = await pause.arm("firefox-default");

    expect(result.ok).toBe(false);
    expect(pause.isPaused("firefox-default")).toBe(false);
    expect(browser.badgeText).toBe("");
  });

  it("refuses a container that no longer exists", async () => {
    const browser = aFakeBrowser();
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    expect((await pause.arm("firefox-container-99")).ok).toBe(false);
  });

  it("stores the container's name at arm time, so a disposed throwaway is still readable", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock(5_000) });

    await pause.arm(shop.cookieStoreId);
    await browser.port.removeIdentity(shop.cookieStoreId);

    const [recording] = pause.snapshot().recordings;
    expect(recording).toMatchObject({ container: "tmp3", startedAt: 5_000, endedAt: null, hosts: [] });
  });

  it("disarming stamps the recording's end and clears the badge", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const clock = aFakeClock(1_000);
    const pause = createPause({ port: browser.port, clock });

    await pause.arm(shop.cookieStoreId);
    clock.advance(60_000);
    await pause.disarm(shop.cookieStoreId);

    expect(pause.isPaused(shop.cookieStoreId)).toBe(false);
    expect(pause.snapshot().recordings[0].endedAt).toBe(61_000);
    expect(browser.badgeText).toBe("");
  });

  it("hydrates the armed set from storage, because the check cannot read storage later", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    await browser.port.writeStored(PAUSE_STORAGE_KEY, {
      armed: [shop.cookieStoreId],
      recordings: [{ id: "1", cookieStoreId: shop.cookieStoreId, container: "tmp3", startedAt: 1, endedAt: null, hosts: [] }],
    } satisfies PauseState);
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    await pause.hydrate();

    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
    expect(browser.badgeText).toBe("1");
  });

  it("treats a stored value of the wrong shape as absent rather than trusting it", async () => {
    const browser = aFakeBrowser();
    await browser.port.writeStored(PAUSE_STORAGE_KEY, "not a pause state");
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    await pause.hydrate();

    expect(pause.snapshot()).toEqual({ armed: [], recordings: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/pause'`.

- [ ] **Step 3: Add `setBadge` to the port and the mock**

`src/engine/port.ts`, in `BrowserPort` after `notify`:

```ts
  // The armed-pause indicator. Text only — the real adapter sets the background colour
  // once at startup. Empty string clears it. A pause with no visible sign is an
  // isolation hole the user cannot notice, which is why this is on the seam at all.
  setBadge(text: string): Promise<void>;
```

`src/engine/browser-port.ts`, alongside the other methods:

```ts
    async setBadge(text: string): Promise<void> {
      await browser.browserAction.setBadgeText({ text });
    },
```

and once, where the port is constructed (next to the other one-time setup), set the colour:

```ts
  // Once, not per update: the colour never changes, and setBadgeText is on the hot path
  // of every arm/disarm.
  void browser.browserAction.setBadgeBackgroundColor({ color: "#c1361a" });
```

`test/engine/mock-port.ts`: add `badgeText: string;` to the `MockPort` interface, a `let badgeText = "";` binding, `async setBadge(text) { badgeText = text; },` in the port object, and expose it on the returned object with a getter:

```ts
    get badgeText() { return badgeText; },
```

- [ ] **Step 4: Write `src/engine/pause.ts`**

```ts
import type { BrowserPort, Clock } from "./port";
import type { Decision } from "../resolver/types";

// storage.local key holding the armed set and the recordings. The background is its ONLY
// writer: the options page reads through a message so a row landing mid-render cannot
// race a toggle and lose one of the two writes.
export const PAUSE_STORAGE_KEY = "pauseState";

// Hosts only, so the cost is bytes; the cap exists to keep the list readable.
export const MAX_RECORDINGS = 10;

export interface RecordedHost {
  host: string;
  hits: number; // main_frame hops that resolved to this host
  wouldHave: string; // the routing action CC declined to take, in F9's own words
}

export interface Recording {
  id: string;
  cookieStoreId: string;
  // The container's display name AT ARM TIME. The dominant case is a throwaway, which
  // the disposer deletes minutes after the flow ends — by review time getIdentity()
  // returns null, and a recording that cannot say where it came from is unreadable.
  container: string;
  startedAt: number;
  endedAt: number | null; // null while running
  hosts: RecordedHost[]; // first-seen order
}

export interface PauseState {
  armed: string[];
  recordings: Recording[]; // newest first
}

export type ArmResult = { ok: true; container: string } | { ok: false; reason: string };

export interface Pause {
  // Called inside the blocking onBeforeRequest handler, so it is synchronous and reads
  // no storage: an await here would be in the latency of every navigation in the
  // browser, armed or not.
  isPaused(cookieStoreId: string): boolean;
  record(cookieStoreId: string, url: string, decision: Decision): void;
  arm(cookieStoreId: string): Promise<ArmResult>;
  disarm(cookieStoreId: string): Promise<ArmResult>;
  hydrate(): Promise<void>;
  snapshot(): PauseState;
}

const DEFAULT_STORE_ID = "firefox-default";

function isRecording(v: unknown): v is Recording {
  const r = v as Recording;
  return (
    typeof r === "object" && r !== null &&
    typeof r.id === "string" && typeof r.cookieStoreId === "string" &&
    typeof r.container === "string" && typeof r.startedAt === "number" &&
    (r.endedAt === null || typeof r.endedAt === "number") && Array.isArray(r.hosts)
  );
}

export function createPause(opts: { port: BrowserPort; clock: Clock }): Pause {
  const { port, clock } = opts;

  const armed = new Set<string>();
  let recordings: Recording[] = [];

  function snapshot(): PauseState {
    return { armed: [...armed], recordings };
  }

  async function persist(): Promise<void> {
    await port.writeStored(PAUSE_STORAGE_KEY, snapshot());
    await port.setBadge(armed.size === 0 ? "" : String(armed.size));
  }

  function running(cookieStoreId: string): Recording | undefined {
    return recordings.find((r) => r.cookieStoreId === cookieStoreId && r.endedAt === null);
  }

  return {
    isPaused: (cookieStoreId) => armed.has(cookieStoreId),

    record() {
      /* Task 3 */
    },

    async arm(cookieStoreId) {
      // Refused as a SCOPE decision, not a technical limit: pausing the default
      // container is close enough to pausing globally that it should be its own,
      // deliberate feature if it is ever wanted.
      if (cookieStoreId === DEFAULT_STORE_ID) {
        return { ok: false, reason: "The default container cannot be paused." };
      }
      const identity = await port.getIdentity(cookieStoreId);
      if (!identity) return { ok: false, reason: "That container no longer exists." };
      if (armed.has(cookieStoreId)) return { ok: true, container: identity.name };

      const now = clock.now();
      armed.add(cookieStoreId);
      recordings = [
        { id: String(now), cookieStoreId, container: identity.name, startedAt: now, endedAt: null, hosts: [] },
        ...recordings,
      ].slice(0, MAX_RECORDINGS);
      await persist();
      return { ok: true, container: identity.name };
    },

    async disarm(cookieStoreId) {
      const open = running(cookieStoreId);
      // The name comes off the recording, not getIdentity: disarming a throwaway that
      // has just been disposed must still be able to say which container it was.
      const container = open?.container ?? "that container";
      if (!armed.delete(cookieStoreId)) return { ok: false, reason: "It was not paused." };
      if (open) open.endedAt = clock.now();
      await persist();
      return { ok: true, container };
    },

    async hydrate() {
      const raw = await port.readStored(PAUSE_STORAGE_KEY);
      // Anything that is not the shape we wrote is treated as absent rather than
      // trusted: a corrupt value must not be able to leave a container unrouted.
      const state = raw as Partial<PauseState> | null;
      if (typeof state !== "object" || state === null) return;
      if (Array.isArray(state.armed)) {
        for (const id of state.armed) if (typeof id === "string") armed.add(id);
      }
      if (Array.isArray(state.recordings)) recordings = state.recordings.filter(isRecording);
      await port.setBadge(armed.size === 0 ? "" : String(armed.size));
    },

    snapshot,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: PASS (all seven).

- [ ] **Step 6: Commit**

```bash
git add src/engine/pause.ts src/engine/port.ts src/engine/browser-port.ts test/engine/mock-port.ts test/engine/pause.test.ts
git commit -m "$(cat <<'EOF'
feat: add the pause module — armed containers, stored and badged

Arming records the container's name at arm time because the dominant case is
a throwaway the disposer deletes before the user reads the recording. The
armed set is hydrated at startup rather than read on demand: isPaused runs
inside the blocking webRequest handler, where an await is every navigation's
latency.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 3: Recording — hosts, hits, and the counterfactual label

**Files:**
- Modify: `src/engine/engine.ts` (export `targetLabel` and `Declinable`)
- Modify: `src/engine/pause.ts` (implement `record`)
- Test: `test/engine/pause.test.ts`

**Interfaces:**
- Consumes: `Pause` from Task 2.
- Produces: `export type Declinable` and `export function targetLabel(decision: Declinable): string` from `src/engine/engine.ts`; a working `Pause.record`.

- [ ] **Step 1: Write the failing tests**

Append to `test/engine/pause.test.ts`:

```ts
import type { Decision } from "../../src/resolver/types";

const intoTemporary: Decision = { kind: "reopen", into: { kind: "temporary" } };
const intoWork: Decision = { kind: "reopen", into: { kind: "permanent", name: "Work" } };
const noAction: Decision = { kind: "stay" };

describe("pause — recording", () => {
  async function anArmedPause() {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });
    await pause.arm(shop.cookieStoreId);
    return { browser, pause, csid: shop.cookieStoreId };
  }

  it("records the host and the action it would have taken", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, "https://payment.acme.test/3ds?token=secret", intoTemporary);

    expect(pause.snapshot().recordings[0].hosts).toEqual([
      { host: "payment.acme.test", hits: 1, wouldHave: "a new temporary container" },
    ]);
  });

  it("collapses a bounce into one row and counts the hops", async () => {
    const { pause, csid } = await anArmedPause();

    for (let i = 0; i < 7; i++) pause.record(csid, `https://login.ms.test/step${i}`, intoTemporary);

    expect(pause.snapshot().recordings[0].hosts).toEqual([
      { host: "login.ms.test", hits: 7, wouldHave: "a new temporary container" },
    ]);
  });

  it("keeps first-seen order and records hops it would NOT have moved", async () => {
    const { pause, csid } = await anArmedPause();

    pause.record(csid, "https://shop.test/cart", noAction);
    pause.record(csid, "https://payment.acme.test/", intoWork);

    // "was it even needed?" is only answerable if the untouched hops are visible too.
    expect(pause.snapshot().recordings[0].hosts).toEqual([
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

    expect(pause.snapshot().recordings[0].hosts).toEqual([]);
  });

  it("writes through when a new host appears, so a config save cannot destroy the record", async () => {
    const { browser, pause, csid } = await anArmedPause();

    pause.record(csid, "https://payment.acme.test/", intoTemporary);
    await browser.settle();

    const stored = (await browser.port.readStored(PAUSE_STORAGE_KEY)) as PauseState;
    expect(stored.recordings[0].hosts[0].host).toBe("payment.acme.test");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: FAIL — `record` is a no-op, so every `hosts` assertion sees `[]`.

- [ ] **Step 3: Export the label from the engine**

In `src/engine/engine.ts`, change the two declarations to exports and widen the comment:

```ts
// The two decisions the engine executes by opening a tab — and therefore the two it
// cannot execute for a request that carries a body. Exported because the pause record
// describes a declined action in the SAME words as the F9 notification: one function,
// so the two cannot drift.
export type Declinable = Extract<Decision, { kind: "reopen" } | { kind: "choice" }>;
```

```ts
export function targetLabel(decision: Declinable): string {
```

- [ ] **Step 4: Implement `record`**

In `src/engine/pause.ts`, add the import and replace the stub:

```ts
import { targetLabel, type Declinable } from "./engine";
```

```ts
// The F9 toast's own words for a declined action, extended with the one case F9 never
// sees: a decision that would not have moved the tab at all.
function wouldHaveLabel(decision: Decision): string {
  return decision.kind === "reopen" || decision.kind === "choice"
    ? targetLabel(decision as Declinable)
    : "no action";
}
```

```ts
    record(cookieStoreId, url, decision) {
      const open = running(cookieStoreId);
      if (!open) return;
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        return; // not a URL we can name; the engine already filtered to http(s)
      }
      const seen = open.hosts.find((h) => h.host === host);
      if (seen) {
        seen.hits++;
        // Deliberately no write: a 7-hop bounce would otherwise be 7 storage writes
        // inside the blocking path. `disarm` flushes, so a finished recording's counts
        // are accurate; a background killed mid-flow loses the hops since the last new
        // host, which is the same class of loss as an unflushed row.
        return;
      }
      open.hosts.push({ host, hits: 1, wouldHave: wouldHaveLabel(decision) });
      // Floated: a navigation must not wait on bookkeeping, and a failed write must not
      // break routing.
      void persist().catch((e) => console.warn("[pause] write failed", e));
    },
```

- [ ] **Step 5: Run the tests**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts src/engine/pause.ts test/engine/pause.test.ts
git commit -m "$(cat <<'EOF'
feat: record hosts and the routing action a paused container declined

Deduping by host is what turns a twelve-hop Microsoft bounce into the three
lines a config is actually written from. The label is the engine's own
targetLabel, so the F9 notification and the record describe a declined action
in identical words. Hosts only: a checkout URL's query string carries session
tokens and this is written to disk mid-payment.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 4: The engine hook, wired, and surviving a restart

**Files:**
- Modify: `src/engine/engine.ts` (`EngineOptions.pause`, step 3a)
- Modify: `src/extension/wiring.ts` (construct `createPause`, gate awaits hydration, expose it)
- Modify: `src/extension/background.ts` (nothing — hydration is inside the gate)
- Test: `test/engine/engine.test.ts`, `test/engine/restart.test.ts`

**Interfaces:**
- Consumes: `createPause`, `Pause` (Tasks 2–3).
- Produces: `EngineOptions.pause: PauseRecorder` (required); `Background.pause: Pause` on the object `wireBackground` returns.

- [ ] **Step 1: Write the failing tests**

Add to `test/engine/engine.test.ts`. First a stub shared by every existing call site:

```ts
import type { PauseRecorder } from "../../src/engine/engine";

// Every engine case that is not about pausing passes this. Required, not optional: an
// optional field is one the mock forgets to set, and coverage quietly stops.
const noPause: PauseRecorder = { isPaused: () => false, record: () => {} };
```

Then the cases:

```ts
describe("engine — a paused container", () => {
  function armedFor(csid: string): PauseRecorder & { recorded: [string, string, Decision][] } {
    const recorded: [string, string, Decision][] = [];
    return { isPaused: (id) => id === csid, record: (id, url, d) => void recorded.push([id, url, d]), recorded };
  }

  it("does not reopen, does not cancel, and records what it would have done", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-container-1" });
    const pause = armedFor("firefox-container-1");
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, tmpSuffix: sequentialTmpSuffixes(), pause });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
    expect(pause.recorded).toEqual([
      ["firefox-container-1", "https://example.com/", { kind: "reopen", into: { kind: "permanent", name: "Work" } }],
    ]);
  });

  it("still routes an UNARMED container — the anchor for the case above", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-container-2" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, tmpSuffix: sequentialTmpSuffixes(), pause: armedFor("firefox-container-1") });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("raises no declination notification for a POST — staying put was asked for", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-container-1" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, tmpSuffix: sequentialTmpSuffixes(), pause: armedFor("firefox-container-1") });

    await browser.navigates(aNavigationTo({ tabId: tab.id, method: "POST" }));
    await browser.settle();

    // F9's toast announces a routing rule that went unapplied. Under a pause nothing
    // went unapplied: the user turned routing off. This pins step 3a AHEAD of 3b.
    expect(browser.notifications).toEqual([]);
  });
});
```

And one wiring-level case, in `test/engine/restart.test.ts` (or wherever `startTheBackground` is already imported), because it needs the cookie-seeder wired alongside the engine:

```ts
it("still seeds cookies in a paused container — an overlay never decides a container", async () => {
  const browser = aFakeBrowser();
  const shop = browser.addContainerNamed({ name: "tmp3" });
  const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
  const config: Config = {
    rules: [{
      match: [hostMatcher("payment.acme.test")],
      action: { kind: "open", containers: ["Work"] },
      cookies: [{ name: "consent", url: "https://payment.acme.test/", value: "1" }],
    }],
    groups: [],
  };
  const session = await startTheBackground(browser, aFakeClock(), config);
  await session.pause.arm(shop.cookieStoreId);

  await browser.sendsHeaders({
    requestId: "1", tabId: tab.id, url: "https://payment.acme.test/",
    type: "main_frame", requestHeaders: [],
  });
  await browser.settle();

  // The pause suspends ROUTING, not the within-container conveniences: overlays act
  // inside whatever container the tab is already in and never move identity across one,
  // so a paused checkout should still get its consent banner pre-dismissed.
  expect(browser.seededCookies.map((c) => c.name)).toContain("consent");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --silent -- test/engine/engine.test.ts test/engine/restart.test.ts`
Expected: FAIL — TypeScript rejects the unknown `pause` option, and the paused case reopens.

- [ ] **Step 3: Add the option and the step to the engine**

In `src/engine/engine.ts`:

```ts
// The pause seam. Narrow and SYNCHRONOUS by contract: `isPaused` is consulted inside the
// blocking webRequest handler, where an await would be every navigation's latency, and
// `record` returns void so a navigation never waits on bookkeeping.
export interface PauseRecorder {
  isPaused(cookieStoreId: string): boolean;
  record(cookieStoreId: string, url: string, decision: Decision): void;
}
```

Add `pause: PauseRecorder;` to `EngineOptions`, destructure it, and insert after the `resolve` call:

```ts
    // (3a) The user armed this container: record what routing would have done and do
    // nothing. Placed AFTER resolve() because the counterfactual is the point — "would
    // have been reopened into a new temporary container" is what says the rule was
    // needed, and "no action" is what says it was not. Placed BEFORE (3b) so a paused
    // POST raises no declination toast: nothing went unapplied, routing was turned off.
    // Placed after (1b) so the reopenedNav guard still runs — arming one hop after a
    // reopen must not orphan its state. Adds nothing to `handled` and never cancels, so
    // like (3b) it is fail-open by construction.
    if (pause.isPaused(tab.cookieStoreId)) {
      pause.record(tab.cookieStoreId, d.url, decision);
      return;
    }
```

- [ ] **Step 4: Pass `noPause` at every existing call site**

Add `pause: noPause,` to every `createEngine({...})` in `test/engine/engine.test.ts` and any other test that constructs the engine directly (`rg --files-with-matches "createEngine\(" test/`).

- [ ] **Step 5: Wire it**

In `src/extension/wiring.ts`: import `createPause`, add `pause: Pause` to the `Background` interface, and construct it **before** `createEngine`:

```ts
  const pause = createPause({ port, clock });
```

Pass `pause` into `createEngine({ … })`. Then extend the gate so the blocking handler waits for hydration as well as the config:

```ts
  // The blocking handler waits for BOTH: routing against an empty config is wrong, and
  // routing an armed container is wrong. Hydration is a storage read, which cannot
  // happen inside the handler (that is every navigation's latency), so it happens once
  // here and the first navigation is delayed instead. Registration itself stays
  // synchronous — only the handler's body awaits.
  const ready = Promise.all([configReady, pause.hydrate()]);
```

and have `gatedPort.onBeforeRequest` await `ready` instead of `configReady`. Return `pause` from `wireBackground`.

- [ ] **Step 6: Add the restart case**

In `test/engine/restart.test.ts`:

```ts
it("keeps a container paused, and its recording, across a background restart", async () => {
  const browser = aFakeBrowser();
  const clock = aFakeClock();
  const shop = browser.addContainerNamed({ name: "tmp3" });
  const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
  let session = await startTheBackground(browser, clock, aConfig());
  await session.pause.arm(shop.cookieStoreId);
  session.pause.record(shop.cookieStoreId, "https://payment.acme.test/", { kind: "reopen", into: { kind: "temporary" } });
  await browser.settle();

  // A config save calls runtime.reload(), so this is the ordinary case, not a crash.
  session = await restartTheBackground(session, browser, clock, aConfig());

  expect(session.pause.isPaused(shop.cookieStoreId)).toBe(true);
  expect(session.pause.snapshot().recordings[0].hosts.map((h) => h.host)).toEqual(["payment.acme.test"]);

  // The rebuilt dedupe set must not re-add a host the previous session already recorded.
  session.pause.record(shop.cookieStoreId, "https://payment.acme.test/again", { kind: "reopen", into: { kind: "temporary" } });
  expect(session.pause.snapshot().recordings[0].hosts).toHaveLength(1);
  expect(tab.id).toBeDefined();
});
```

Match the file's existing `aFakeClock()` / `aConfig()` helpers; if `startTheBackground` does not yet await hydration, add `await session.pause.hydrate()` inside `startTheBackground` in `test/engine/restart.ts` so the harness runs the same startup `background.ts` does.

- [ ] **Step 7: Run the full suite**

Run: `npm test --silent`
Expected: PASS.

- [ ] **Step 8: Revert-verify**

Comment out the step-3a block in `engine.ts`. Run `npm test --silent -- test/engine/engine.test.ts`: the paused case must go red while "still routes an UNARMED container" stays green. Restore with the editor.

- [ ] **Step 9: Commit**

```bash
git add src/engine/engine.ts src/extension/wiring.ts test/engine/ test/engine/restart.ts
git commit -m "$(cat <<'EOF'
feat: leave an armed container's navigations alone

The step sits after resolve() so the record can state the counterfactual, and
before the non-GET declination so a paused POST raises no toast — under a
pause nothing went unapplied, routing was turned off. The startup gate now
also awaits hydration: isPaused cannot read storage, so the armed set has to
be in memory before the first navigation is answered.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 5: Disarm when the container's last tab closes

**Files:**
- Modify: `src/engine/pause.ts`
- Test: `test/engine/pause.test.ts`

**Interfaces:**
- Consumes: `Pause` (Tasks 2–4), `BrowserPort.onTabRemoved`, `BrowserPort.queryTabs`.
- Produces: no new exports. `createPause` now registers one `tabs.onRemoved` listener.

- [ ] **Step 1: Write the failing tests**

```ts
describe("pause — lifetime", () => {
  it("disarms when the armed container's last tab closes", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });
    await pause.arm(shop.cookieStoreId);

    await browser.closesTab(tab);
    await browser.settle();

    // There is no timer: an expiry firing mid-checkout reproduces the failure this
    // exists to prevent. For a throwaway, last-tab-close is the container's whole life.
    expect(pause.isPaused(shop.cookieStoreId)).toBe(false);
    expect(pause.snapshot().recordings[0].endedAt).not.toBeNull();
    expect(browser.badgeText).toBe("");
  });

  it("stays armed while another tab in that container is still open", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const first = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    browser.existingTab({ url: "https://shop.test/cart", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });
    await pause.arm(shop.cookieStoreId);

    await browser.closesTab(first);
    await browser.settle();

    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: FAIL — the container stays armed after the tab closes.

- [ ] **Step 3: Implement**

In `createPause`, before the `return`:

```ts
  // A tab closing is the only way a container becomes empty, so it is the only trigger.
  // WHICH tab closed does not matter — the browser is asked. That is what makes this
  // survive a restart, and mock-port fires onTabRemoved for a tab CC itself closed, so
  // a reopen that consumed the last tab is seen here too.
  port.onTabRemoved(() => {
    void (async () => {
      if (armed.size === 0) return;
      const occupied = new Set((await port.queryTabs({})).map((t) => t.cookieStoreId));
      for (const csid of [...armed]) {
        if (!occupied.has(csid)) await disarmInternal(csid);
      }
    })().catch((e) => console.warn("[pause] disarm-on-empty failed", e));
  });
```

Extract the body of `disarm` into a local `async function disarmInternal(cookieStoreId: string): Promise<ArmResult>` above the `return`, and have the exported `disarm` call it, so both paths stamp `endedAt` and flush identically.

- [ ] **Step 4: Run the tests**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/pause.ts test/engine/pause.test.ts
git commit -m "$(cat <<'EOF'
feat: end a pause when the container's last tab closes

There is no expiry: a timer firing mid-checkout reproduces exactly the
failure the pause exists to prevent, and unpredictably. Last-tab-close is the
right lifetime for free — for a throwaway it is the container's whole life —
and the badge covers a permanent container left open.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 6: The toolbar button

**Files:**
- Modify: `src/engine/port.ts`, `src/engine/browser-port.ts`, `test/engine/mock-port.ts`
- Modify: `src/engine/pause.ts`
- Modify: `extensions/cc/manifest.json`
- Test: `test/engine/pause.test.ts`, `test/extension/package.test.ts` (if it asserts the manifest shape)

**Interfaces:**
- Consumes: `Pause.arm` / `Pause.disarm` (Tasks 2, 5).
- Produces: `BrowserPort.onActionClicked(handler: (tab: Tab) => void): void`; `MockPort.clicksAction(tab: Tab): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("pause — the toolbar button", () => {
  it("arms the container of the tab Firefox hands the click, and says which", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    await browser.clicksAction(tab);

    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
    // The badge only reaches "1"; the toast is the only thing that names tmp3, and the
    // user has no other way to confirm they hit the right container.
    expect(browser.notifications[0].message).toContain("tmp3");
  });

  it("a second click resumes routing", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    await browser.clicksAction(tab);
    await browser.clicksAction(tab);

    expect(pause.isPaused(shop.cookieStoreId)).toBe(false);
    expect(browser.notifications).toHaveLength(2);
  });

  it("refuses the default container out loud", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: "firefox-default" });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    await browser.clicksAction(tab);

    expect(pause.isPaused("firefox-default")).toBe(false);
    // A silent no-op is the worst outcome for a control reached for under time pressure.
    expect(browser.notifications[0].message).toContain("default container");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: FAIL — `browser.clicksAction is not a function`.

- [ ] **Step 3: Add the port method and the mock arranger**

`src/engine/port.ts`:

```ts
  // browser_action clicks. Firefox hands the handler the ACTIVE TAB, which is why the
  // button can arm the container the user is in without a popup, a message, or a payload
  // to validate — no page is involved, so nothing craftable reaches it.
  onActionClicked(handler: (tab: Tab) => void): void;
```

`src/engine/browser-port.ts`:

```ts
    onActionClicked(handler) {
      browser.browserAction.onClicked.addListener((tab) => handler(mapTab(tab)));
    },
```

`test/engine/mock-port.ts`: a `let actionClickedH: ((tab: Tab) => void) | null = null;`, `onActionClicked(h) { actionClickedH = h; },` on the port, `clicksAction(tab: Tab): Promise<void>;` on the `MockPort` interface, and:

```ts
    async clicksAction(tab) {
      actionClickedH?.(tab);
      await flushMicrotasks();
    },
```

- [ ] **Step 4: Handle the click in `pause.ts`**

Inside `createPause`, beside the `onTabRemoved` registration:

```ts
  const NOTIFY_TITLE = "Configurable Containers";

  // Both arming paths call arm()/disarm(); this handler holds NO logic of its own. It
  // cannot: WebDriver cannot click a browser_action, so anything that lived only here
  // would have no end-to-end coverage at all. The options-page path (pause-protocol) is
  // the one an e2e drives.
  port.onActionClicked((tab) => {
    void (async () => {
      const result = armed.has(tab.cookieStoreId)
        ? await disarmInternal(tab.cookieStoreId)
        : await arm(tab.cookieStoreId);
      const paused = armed.has(tab.cookieStoreId);
      await port.notify({
        title: NOTIFY_TITLE,
        message: result.ok
          ? paused
            ? `Routing paused in ${result.container} — CC will record hosts and move nothing.`
            : `Routing resumed in ${result.container}.`
          : result.reason,
      });
    })().catch((e) => console.warn("[pause] toolbar click failed", e));
  });
```

Hoist `arm` out of the returned object literal into a local `async function arm(...)` so both the handler and the interface use one implementation.

- [ ] **Step 5: Add `browser_action` to the manifest**

In `extensions/cc/manifest.json`, after `"options_ui"`:

```json
  "browser_action": {
    "default_title": "Configurable Containers — pause routing in this container"
  },
```

No `default_popup`: without one the button fires `browserAction.onClicked`, and `setBadgeText` needs the manifest key regardless.

- [ ] **Step 6: Run the full suite**

Run: `npm test --silent`
Expected: PASS. If `test/extension/package.test.ts` asserts the manifest's key set, update that expectation.

- [ ] **Step 7: Commit**

```bash
git add src/engine/pause.ts src/engine/port.ts src/engine/browser-port.ts test/engine/mock-port.ts test/engine/pause.test.ts extensions/cc/manifest.json test/extension/package.test.ts
git commit -m "$(cat <<'EOF'
feat: toggle the pause from the toolbar button

browserAction.onClicked is handed the active tab by Firefox, so the button
arms the container the user is in with no popup, no message and no payload to
validate. The handler holds no logic of its own — WebDriver cannot click a
browser_action, so anything living only here would have no e2e coverage.
Notifications carry the container name; the badge only ever reaches "1".

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 7: The options page's half of the conversation

**Files:**
- Create: `src/extension/pause-protocol.ts`
- Modify: `src/engine/pause.ts` (add `handleMessage`), `src/extension/wiring.ts` (dispatch branch)
- Test: `test/engine/pause.test.ts`

**Interfaces:**
- Consumes: `Pause` (Tasks 2–6), the wiring dispatcher (Task 1).
- Produces:
  ```ts
  // src/extension/pause-protocol.ts
  export interface PauseStatusMessage { type: "cc-pause-status" }
  export interface PauseToggleMessage { type: "cc-pause-toggle"; cookieStoreId: string }
  export interface PauseClearMessage { type: "cc-pause-clear" }
  export interface ContainerRow {
    cookieStoreId: string; name: string; tabCount: number; hosts: string[];
    armed: boolean; armable: boolean; reason?: string;
  }
  export interface PauseStatusResponse { containers: ContainerRow[]; recordings: Recording[] }
  export interface PauseToggleResponse { ok: boolean; message: string }
  ```
  `Pause.handleMessage(msg: unknown): Promise<unknown> | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("pause — the options page conversation", () => {
  it("lists only containers that have tabs, annotated so a tmp name is identifiable", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    browser.addContainerNamed({ name: "tmp8" }); // no tabs — you cannot arm a flow you are not in
    browser.existingTab({ url: "https://shop.test/cart", cookieStoreId: shop.cookieStoreId });
    createPause({ port: browser.port, clock: aFakeClock() });

    const status = (await browser.receivesMessage({ type: "cc-pause-status" })) as PauseStatusResponse;

    expect(status.containers.map((c) => c.name)).toEqual(["tmp3"]);
    // "tmp3" alone says nothing about which flow it holds; the host is what identifies it.
    expect(status.containers[0]).toMatchObject({ tabCount: 1, hosts: ["shop.test"], armed: false, armable: true });
  });

  it("marks the default container unarmable with the reason shown inline", async () => {
    const browser = aFakeBrowser();
    browser.existingTab({ url: "https://shop.test/", cookieStoreId: "firefox-default" });
    createPause({ port: browser.port, clock: aFakeClock() });

    const status = (await browser.receivesMessage({ type: "cc-pause-status" })) as PauseStatusResponse;
    const row = status.containers.find((c) => c.cookieStoreId === "firefox-default")!;

    expect(row).toMatchObject({ armable: false });
    expect(row.reason).toBeTruthy();
  });

  it("toggles a container named in the message, after validating it", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });

    await browser.receivesMessage({ type: "cc-pause-toggle", cookieStoreId: shop.cookieStoreId });

    expect(pause.isPaused(shop.cookieStoreId)).toBe(true);
  });

  it("refuses a cookieStoreId that is not a real container", async () => {
    const browser = aFakeBrowser();
    createPause({ port: browser.port, clock: aFakeClock() });

    // This is the ONE message in CC that names a container instead of deriving it from
    // the sender, so the background validates the payload rather than trusting it.
    const reply = (await browser.receivesMessage({ type: "cc-pause-toggle", cookieStoreId: "firefox-container-99" })) as PauseToggleResponse;

    expect(reply.ok).toBe(false);
  });

  it("clears the recordings", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const pause = createPause({ port: browser.port, clock: aFakeClock() });
    await pause.arm(shop.cookieStoreId);

    await browser.receivesMessage({ type: "cc-pause-clear" });

    expect(pause.snapshot().recordings).toEqual([]);
    expect(pause.isPaused(shop.cookieStoreId)).toBe(false);
  });
});
```

These fire messages at the **wiring's** dispatcher, so each test needs the background wired. Use `startTheBackground(browser, clock, aConfig())` from `test/engine/restart.ts` and read `session.pause` instead of constructing `createPause` directly, keeping `createPause` calls only in the tests above that do not send messages.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --silent -- test/engine/pause.test.ts`
Expected: FAIL — the dispatcher returns `undefined` for every `cc-pause-*` type.

- [ ] **Step 3: Create the protocol module**

`src/extension/pause-protocol.ts`:

```ts
// The shared protocol between the background `pause` module and the options page. Pure,
// no browser, no DOM — so the shapes are unit-testable at L1, exactly like
// picker-protocol.ts.
//
// Unlike the choice page, this protocol DOES name a container: the sender is the options
// tab and that is not the tab under discussion, so there is nothing to derive it from.
// The background therefore validates the cookieStoreId instead of trusting it.

import type { Recording } from "../engine/pause";

export interface PauseStatusMessage { type: "cc-pause-status" }
export interface PauseToggleMessage { type: "cc-pause-toggle"; cookieStoreId: string }
export interface PauseClearMessage { type: "cc-pause-clear" }

export interface ContainerRow {
  cookieStoreId: string;
  name: string;
  tabCount: number;
  // The hosts of that container's open tabs. Not decoration: "tmp3 / tmp8 / tmp12" says
  // nothing about which one holds the checkout, and the list is unusable without it.
  hosts: string[];
  armed: boolean;
  armable: boolean;
  reason?: string; // why not, when armable is false
}

export interface PauseStatusResponse { containers: ContainerRow[]; recordings: Recording[] }
export interface PauseToggleResponse { ok: boolean; message: string }
```

- [ ] **Step 4: Handle the messages in `pause.ts`**

Add to the returned object:

```ts
    handleMessage(msg) {
      const type = (msg as { type?: unknown } | null | undefined)?.type;
      if (type === "cc-pause-status") return status();
      if (type === "cc-pause-toggle") return toggle((msg as PauseToggleMessage).cookieStoreId);
      if (type === "cc-pause-clear") return clearAll();
      return undefined;
    },
```

and the three locals above the `return`:

```ts
  async function status(): Promise<PauseStatusResponse> {
    const identities = await port.queryIdentities();
    const tabs = await port.queryTabs({});
    const byStore = new Map<string, string[]>();
    for (const t of tabs) {
      let host = "";
      try {
        host = new URL(t.url).host;
      } catch {
        /* about:blank and friends have no host — the row still counts the tab */
      }
      const hosts = byStore.get(t.cookieStoreId) ?? [];
      if (host && !hosts.includes(host)) hosts.push(host);
      byStore.set(t.cookieStoreId, hosts);
    }
    const named = new Map(identities.map((c) => [c.cookieStoreId, c.name]));
    const containers: ContainerRow[] = [...byStore.keys()]
      .filter((csid) => csid === DEFAULT_STORE_ID || named.has(csid))
      .map((csid) => ({
        cookieStoreId: csid,
        name: named.get(csid) ?? "Default",
        tabCount: tabs.filter((t) => t.cookieStoreId === csid).length,
        hosts: byStore.get(csid) ?? [],
        armed: armed.has(csid),
        armable: csid !== DEFAULT_STORE_ID,
        reason: csid === DEFAULT_STORE_ID ? "The default container cannot be paused." : undefined,
      }));
    return { containers, recordings };
  }

  async function toggle(cookieStoreId: unknown): Promise<PauseToggleResponse> {
    if (typeof cookieStoreId !== "string") return { ok: false, message: "No container named." };
    const result = armed.has(cookieStoreId) ? await disarmInternal(cookieStoreId) : await arm(cookieStoreId);
    return result.ok
      ? { ok: true, message: armed.has(cookieStoreId) ? `Paused in ${result.container}.` : `Resumed in ${result.container}.` }
      : { ok: false, message: result.reason };
  }

  async function clearAll(): Promise<PauseToggleResponse> {
    for (const csid of [...armed]) await disarmInternal(csid);
    recordings = [];
    await persist();
    return { ok: true, message: "Cleared." };
  }
```

- [ ] **Step 5: Add the dispatcher branch**

In `src/extension/wiring.ts`:

```ts
    if (typeof type === "string" && type.startsWith("cc-pause-")) return pause.handleMessage(msg);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test --silent`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/extension/pause-protocol.ts src/engine/pause.ts src/extension/wiring.ts test/engine/pause.test.ts
git commit -m "$(cat <<'EOF'
feat: answer the options page's pause queries from the background

The background stays the single writer of the pause state — the page reads
through a message and never writes the key, so a host row landing mid-render
cannot race a toggle and lose one of the two writes. This is the one message
in CC that names a container rather than deriving it from the sender, because
the sender is the options tab; the payload is validated instead of trusted.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 8: The options page UI, and the end-to-end loop

**Files:**
- Modify: `extensions/cc/options.html`, `src/extension/options.ts`
- Test: `test/e2e/pause.test.ts` *(new)*

**Interfaces:**
- Consumes: `pause-protocol.ts` types (Task 7).
- Produces: DOM ids `cc-pause-containers`, `cc-pause-recordings`, `cc-pause-clear`; per-row `button[data-cc-arm="<container name>"]` and per-host `button[data-cc-host="<host>"]`.

- [ ] **Step 1: Write the failing e2e**

Create `test/e2e/pause.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { By } from "selenium-webdriver";
import {
  launch, awaitContainerTab, awaitProbeReport, openExtensionPage, switchToUrl,
  ccExtensionUrl, listTabs, navigateTab, readContainerName, type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

describe("pause & record (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("holds an armed container across a cross-site navigation and records what it declined", async () => {
    // 1. An unmatched host: CC routes it into a throwaway.
    const first = `http://nomatch.example:${serverPort}/?cb=pause-${Date.now()}`;
    try {
      await firefox.driver.get(first);
    } catch {
      // The tab is reopened into the throwaway, tearing this one down — expected.
    }
    const { name: container } = await awaitContainerTab(firefox.driver, first);
    const beforeCsid = await readContainerName(firefox.driver);

    // 2. Arm it from the options page — the one arming route WebDriver can drive.
    await openExtensionPage(firefox.driver, OPTIONS_URL);
    await switchToUrl(firefox.driver, OPTIONS_URL);
    await firefox.driver.findElement(By.css(`button[data-cc-arm="${container}"]`)).click();
    await firefox.driver.wait(async () => {
      const el = await firefox.driver.findElement(By.css(`button[data-cc-arm="${container}"]`));
      return (await el.getAttribute("data-cc-armed")) === "true";
    }, 5000);

    // 3. Navigate that tab CROSS-SITE to a second unmatched host — normally a fresh throwaway.
    const tabs = await listTabs(firefox.driver);
    const target = tabs.find((t) => t.url.startsWith(first.split("?")[0]))!;
    const second = `http://hop.example:${serverPort}/?cb=pause2-${Date.now()}`;
    await navigateTab(firefox.driver, target.id, second);

    // 4. The pause held: same container, no reopen. There is no reopen to wait for here,
    //    so the probe's own report is the only signal that the navigation finished.
    await switchToUrl(firefox.driver, second);
    await awaitProbeReport(firefox.driver);
    expect(await readContainerName(firefox.driver)).toBe(beforeCsid);

    // 5. The record names the host and the action CC declined, live via storage.onChanged.
    await switchToUrl(firefox.driver, OPTIONS_URL);
    await firefox.driver.wait(async () => {
      const text = await firefox.driver.findElement(By.id("cc-pause-recordings")).getText();
      return text.includes("hop.example") && text.includes("temporary");
    }, 10_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --silent -- test/e2e/pause.test.ts`
Expected: FAIL — `NoSuchElementError: button[data-cc-arm=…]`.

- [ ] **Step 3: Add the markup**

In `extensions/cc/options.html`, before `<script src="options.js">`:

```html
  <hr>
  <h2>Pause &amp; record</h2>
  <p>
    Pausing a container stops CC routing inside it and records every site it sees,
    so you can add the ones you need to the config above. Toolbar button does the same
    for the container you are in.
  </p>
  <div id="cc-pause-containers"></div>
  <h3>Recordings</h3>
  <div id="cc-pause-recordings"></div>
  <p><button id="cc-pause-clear">Clear recordings</button></p>
```

and add to the `<style>` block:

```css
    #cc-pause-containers button[data-cc-armed="true"] { font-weight: bold; }
    .cc-pause-row { padding: 2px 0; }
    .cc-pause-host { font-family: monospace; }
```

- [ ] **Step 4: Render it**

Append to `src/extension/options.ts`:

```ts
import type {
  ContainerRow, PauseStatusResponse, PauseToggleResponse,
} from "./pause-protocol";

const pauseContainersEl = document.getElementById("cc-pause-containers")!;
const pauseRecordingsEl = document.getElementById("cc-pause-recordings")!;
const pauseClearButton = document.getElementById("cc-pause-clear") as HTMLButtonElement;

function renderContainerRow(row: ContainerRow): HTMLElement {
  const line = document.createElement("div");
  line.className = "cc-pause-row";
  const button = document.createElement("button");
  button.dataset.ccArm = row.name;
  button.dataset.ccArmed = String(row.armed);
  button.disabled = !row.armable;
  button.textContent = row.armed ? "Resume routing" : "Pause routing";
  button.addEventListener("click", () => {
    void (async () => {
      const reply = (await browser.runtime.sendMessage({
        type: "cc-pause-toggle",
        cookieStoreId: row.cookieStoreId,
      })) as PauseToggleResponse;
      if (!reply.ok) line.append(` ${reply.message}`);
      await renderPause();
    })();
  });
  const label = document.createElement("span");
  const tabs = `${row.tabCount} tab${row.tabCount === 1 ? "" : "s"}`;
  // The hosts are what make a throwaway row identifiable: "tmp12" alone says nothing
  // about which flow it is holding.
  label.textContent = ` ${row.name} · ${tabs}${row.hosts.length ? ` · ${row.hosts.join(", ")}` : ""}` +
    (row.armable ? "" : ` — ${row.reason ?? ""}`);
  line.append(button, label);
  return line;
}

async function renderPause(): Promise<void> {
  const status = (await browser.runtime.sendMessage({ type: "cc-pause-status" })) as PauseStatusResponse;

  pauseContainersEl.replaceChildren(...status.containers.map(renderContainerRow));

  pauseRecordingsEl.replaceChildren(
    ...status.recordings.map((recording) => {
      const box = document.createElement("div");
      const when = new Date(recording.startedAt).toLocaleString();
      const head = document.createElement("p");
      head.textContent =
        `${recording.container} · ${when}${recording.endedAt === null ? " · recording" : ""}`;
      box.append(head);
      for (const row of recording.hosts) {
        const line = document.createElement("div");
        line.className = "cc-pause-row";
        const copy = document.createElement("button");
        copy.dataset.ccHost = row.host;
        copy.textContent = "Copy";
        // The host, and nothing else. Choosing between inherit / ignore / open is a
        // judgement about what a domain IS to the user; a generated snippet would be CC
        // guessing. This removes the typo, not the decision.
        copy.addEventListener("click", () => void navigator.clipboard.writeText(row.host));
        const label = document.createElement("span");
        label.className = "cc-pause-host";
        label.textContent = ` ${row.host} ×${row.hits} — ${row.wouldHave}`;
        line.append(copy, label);
        box.append(line);
      }
      return box;
    }),
  );
}

pauseClearButton.addEventListener("click", () => {
  void (async () => {
    await browser.runtime.sendMessage({ type: "cc-pause-clear" });
    await renderPause();
  })();
});
```

and inside the existing bottom IIFE, after `onSyncStorageChanged(...)`:

```ts
  await renderPause();
  // Live, so a recording grows while you watch it: the mid-flow glance is what the
  // toolbar popup would have been for. Only a SIGNAL — the data still comes back through
  // the message, keeping the background the single reader of its own storage shape. The
  // repaint touches only the pause subtree, so unsaved editor text is never clobbered.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "pauseState" in changes) void renderPause();
  });
```

- [ ] **Step 5: Run the e2e**

Run: `npm test --silent -- test/e2e/pause.test.ts`
Expected: PASS.

- [ ] **Step 6: Revert-verify the e2e**

Comment out the step-3a block in `src/engine/engine.ts`. Re-run the e2e: it must fail at the step-4 container assertion (the cross-site hop buys a fresh throwaway). Restore with the editor.

- [ ] **Step 7: Run the whole suite**

Run: `npm test --silent`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add extensions/cc/options.html src/extension/options.ts test/e2e/pause.test.ts
git commit -m "$(cat <<'EOF'
feat: arm containers and review recordings on the options page

Reviewing a recording is writing config, so the list lives beside the editor.
Rows are annotated with their open tabs' hosts because "tmp3 / tmp8 / tmp12"
says nothing about which one holds the checkout. This is also the arming route
an e2e can drive — WebDriver cannot click a toolbar button — so the whole
arm/record/review loop is covered end to end.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

### Task 9: Record the facts that make a reasonable change wrong

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (one paragraph under the feature list, if it has one)
- Modify: `docs/superpowers/specs/2026-08-01-pause-and-record-design.md` (status line)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Add to `CLAUDE.md` under "Where new logic goes"**

```markdown
- **`src/engine/pause.ts` owns arming, recording and the badge; the engine consults it at
  exactly one point.** The seam is synchronous by contract — `isPaused` runs inside the
  blocking `onBeforeRequest`, where an `await` is every navigation's latency, and
  `record` returns `void` so a navigation never waits on bookkeeping. The step sits
  **after `resolve()`** (the record's value is the counterfactual) and **before the
  non-GET declination** (a paused POST must raise no toast: nothing went unapplied).
- **Two arming paths, one `arm()`.** The toolbar button gets its container from the `Tab`
  Firefox passes to `browserAction.onClicked`; the options page names one and the
  background validates it. WebDriver cannot click a `browser_action`, so **any logic that
  lives only in the `onClicked` handler has no end-to-end coverage** — keep it a caller.
```

- [ ] **Step 2: Add to `CLAUDE.md` under the config/storage section**

```markdown
- **The background is the pause state's only writer, and the options page only reads.**
  Arming by storage write from the page would race the background's own row-appends —
  a new host landing while the user toggles loses one of the two writes. The page
  subscribes to `storage.onChanged` as a *signal* and refetches through a message.
- **`wireBackground`'s gate awaits hydration as well as the config.** The armed set
  cannot be read inside the blocking handler, so it has to be in memory before the first
  navigation is answered; registration still happens synchronously, only the handler's
  body waits.
```

- [ ] **Step 3: Add to `CLAUDE.md` under "What a green test run can still hide"**

```markdown
- **The pause's toolbar button and badge have no L4 coverage and cannot.** WebDriver
  cannot click a `browser_action` or read chrome UI. `test/e2e/pause.test.ts` drives the
  **options-page** arming route instead. **Do not add a build-time seed to arm a
  container** to close the gap: `__CC_NOTIFY_ECHO_TO__` already shows the cost (no test
  build is byte-equivalent to a packaged one), and a path that arms by name would make
  the shipped extension capable of starting up with routing disabled.
```

- [ ] **Step 4: Flip the spec's status line**

In `docs/superpowers/specs/2026-08-01-pause-and-record-design.md`, change `**Status:** Approved, pending implementation plan` to `**Status:** Implemented`.

- [ ] **Step 5: Verify the docs claim nothing untrue**

Run: `npm test --silent && npx tsc --noEmit`
Expected: PASS. Re-read each added CLAUDE.md bullet against the code it describes.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/superpowers/specs/2026-08-01-pause-and-record-design.md
git commit -m "$(cat <<'EOF'
docs: record the pause facts that make a reasonable change wrong

The synchronous seam, the step's placement between resolve() and the non-GET
declination, the single writer, and the reason the toolbar button must stay a
caller: WebDriver cannot click a browser_action, so logic living only there
would ship untested.

Claude-Session: https://claude.ai/code/session_01SdBdpx8MjAiSkrCwiH1Fdo
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 narrow synchronous interface | 4 (`PauseRecorder`) |
| §3.1 step placement | 4 |
| §3.2 overlays/auto-temp/disposer untouched | 4 (no change to those modules is the evidence; the engine step returns before effects only) |
| §3.3 no timer, last-tab-close | 5 |
| §4.1 storage shape, name at arm time | 2 |
| §4.2 hosts only, hits, `wouldHave` via `targetLabel` | 3 |
| §4.3 write-through, hydration, gate | 2, 3, 4 |
| §5.1 options-page arming, annotation, validation | 7, 8 |
| §5.2 recordings, copy-host, `storage.onChanged` | 8 |
| §5.3 button, notifications | 6 |
| §5.4 badge | 2, 6 |
| §6 message router | 1 |
| §7 MAC / armed-container consequences | 9 (documented; no code) |
| §8.1–8.2 L1–L3 | 2, 3, 4, 5, 6, 7 |
| §8.3 L4 | 8 |

**Gap found and closed:** §3.2 claims overlays still fire in an armed container and §8.2 lists it as an L3 case, but the first draft asserted it nowhere. The cookie-seeder case is now in Task 4, Step 1, driven through `startTheBackground` because it needs the seeder wired alongside the engine.

**Placeholder scan:** clean — every code step carries its code.

**Type consistency:** `Pause` (module) vs `PauseRecorder` (the engine's two-method view) are deliberately different names for different surfaces — `Pause` extends what `PauseRecorder` requires. `arm`/`disarm` both return `ArmResult`. `disarmInternal` is introduced in Task 5 and used by Tasks 6 and 7; Task 5's step 3 is where it must be extracted, so Tasks 6 and 7 depend on Task 5 being done first. Task order is therefore strict: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9.
