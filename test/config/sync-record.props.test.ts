import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  CHUNK_CHARS,
  ConfigTooLargeError,
  MAX_PARTS,
  META_KEY,
  PART_KEY_PREFIX,
  SYNC_VERSION,
  decodeRecord,
  encodeRecord,
  partKey,
  reconcile,
  splitParts,
  staleKeys,
  type RemoteConfig,
} from "../../src/config/sync-record";

// storage.sync is the one subsystem here with no level above L3 and no e2e case that can
// reach it — no Firefox Account in a test profile, and adoption ends in runtime.reload().
// The deterministic levels are the whole defence, and what they are defending against is
// not a mis-routed tab but a config quietly replaced by an older one on every machine the
// user owns. The examples in sync-record.test.ts pin the cases someone thought of; these
// pin the shape of the answer over inputs nobody would hand-write.

// Text that exercises what the chunking actually does: multi-byte characters (splitParts
// slices by code UNIT, so a chunk boundary can fall inside a surrogate pair), and lengths
// either side of the boundary itself.
const arbShortText = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.string({ unit: "grapheme", maxLength: 60 }),
);
const arbBoundaryText = fc
  .tuple(
    fc.integer({ min: CHUNK_CHARS - 2, max: 3 * CHUNK_CHARS + 2 }),
    fc.string({ unit: "grapheme", minLength: 1, maxLength: 3 }),
  )
  // The final slice is by code unit and may cut a surrogate pair in half. That is the
  // point: whatever it produces has to survive the round trip unchanged.
  .map(([len, unit]) => unit.repeat(Math.ceil(len / unit.length) + 1).slice(0, len));
const arbText = fc.oneof({ weight: 3, arbitrary: arbShortText }, { weight: 1, arbitrary: arbBoundaryText });
const arbStamp = fc.integer({ min: 0, max: 4_000_000_000 });

const partKeysOf = (items: Record<string, unknown>) =>
  Object.keys(items).filter((k) => k.startsWith(PART_KEY_PREFIX));

describe("the sync record — properties", () => {
  it("decodes back to the exact text that was published, whatever the text", () => {
    fc.assert(
      fc.property(arbText, arbStamp, (text, updatedAt) => {
        expect(decodeRecord(encodeRecord(text, updatedAt))).toEqual({
          state: "ok",
          text,
          updatedAt,
          parts: splitParts(text).length,
        });
      }),
    );
  });

  it("splits into parts that rejoin exactly, none over the item limit and never none at all", () => {
    fc.assert(
      fc.property(arbText, (text) => {
        const parts = splitParts(text);
        expect(parts.join("")).toBe(text);
        expect(parts.length).toBeGreaterThan(0); // zero parts would decode as `absent`
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(CHUNK_CHARS);
      }),
    );
  });

  it("refuses a config past the area quota instead of publishing a truncated one", () => {
    const atLimit = "x".repeat(CHUNK_CHARS * MAX_PARTS);
    expect(decodeRecord(encodeRecord(atLimit, 1))).toMatchObject({ state: "ok", parts: MAX_PARTS });
    expect(() => encodeRecord(atLimit + "x", 1)).toThrow(ConfigTooLargeError);
  });

  // The branch the whole module turns on. `absent` means PUSH, so reading a record that is
  // still arriving as absent publishes this machine's older config over the update in
  // flight — and the machine that sent it adopts the rollback.
  it("reads a record missing any of its parts as incomplete, never as absent", () => {
    fc.assert(
      fc.property(arbBoundaryText, arbStamp, fc.array(fc.nat(), { minLength: 1 }), (text, stamp, drops) => {
        const items = encodeRecord(text, stamp);
        const parts = partKeysOf(items).length;
        const dropped = { ...items };
        for (const d of drops) delete dropped[partKey(d % parts)];
        expect(decodeRecord(dropped)).toEqual({ state: "incomplete" });
      }),
    );
  });

  it("reads a part still holding the previous config as incomplete, whatever its length", () => {
    fc.assert(
      fc.property(arbText, arbText, arbStamp, fc.nat(), (oldText, newText, stamp, which) => {
        fc.pre(oldText !== newText);
        const before = encodeRecord(oldText, stamp - 1);
        const after = encodeRecord(newText, stamp);
        const parts = partKeysOf(after).length;
        const index = which % parts;
        fc.pre(before[partKey(index)] !== undefined);
        // One part of the new record never landed, so the old one is still sitting there.
        // A length check alone would wave this through whenever the two happen to match —
        // swapping one host for another of the same width is an ordinary edit.
        const mixed = { ...after, [partKey(index)]: before[partKey(index)] };
        fc.pre(mixed[partKey(index)] !== after[partKey(index)]);
        expect(decodeRecord(mixed)).toEqual({ state: "incomplete" });
      }),
    );
  });

  it("ignores keys that are not part of the record", () => {
    fc.assert(
      fc.property(arbShortText, arbStamp, fc.dictionary(fc.string({ maxLength: 8 }), fc.string()), (text, stamp, junk) => {
        const items = { ...junk, ...encodeRecord(text, stamp) };
        expect(decodeRecord(items)).toMatchObject({ state: "ok", text });
      }),
    );
  });

  it("reads a record with no meta as absent, and one it cannot read as unreadable", () => {
    fc.assert(
      fc.property(arbShortText, arbStamp, (text, stamp) => {
        const items = encodeRecord(text, stamp);
        const { [META_KEY]: meta, ...withoutMeta } = items;
        // Nobody has published: the only state that means "push".
        expect(decodeRecord(withoutMeta)).toEqual({ state: "absent" });
        // Written by a build that knows more than this one — never overwrite it.
        expect(decodeRecord({ ...items, [META_KEY]: { ...(meta as object), v: SYNC_VERSION + 1 } })).toEqual({
          state: "unreadable",
        });
      }),
    );
  });

  it("names every part key the new record left behind, and none that it uses", () => {
    fc.assert(
      fc.property(arbBoundaryText, arbText, arbStamp, (longText, shortText, stamp) => {
        const before = encodeRecord(longText, stamp);
        const after = encodeRecord(shortText, stamp + 1);
        const keptKeys = partKeysOf(after);
        fc.pre(partKeysOf(before).length > keptKeys.length);
        const stale = staleKeys({ ...before, ...after }, keptKeys.length);
        // Exactly the surplus: nothing the new record needs, nothing else in the area.
        expect(stale.sort()).toEqual(
          partKeysOf(before)
            .filter((k) => !keptKeys.includes(k))
            .sort(),
        );
      }),
    );
  });
});

describe("reconciling two copies of the config — properties", () => {
  it("never adopts text it already has, however the stamps compare", () => {
    // Load-bearing: adoption ends in runtime.reload(), so a machine that adopted its own
    // config would restart, adopt again, and never stop.
    fc.assert(
      fc.property(arbShortText, arbStamp, arbStamp, (text, mine, theirs) => {
        const decision = reconcile({ text, updatedAt: mine }, { state: "ok", text, updatedAt: theirs, parts: 1 });
        expect(decision).toEqual({ action: "none" });
      }),
    );
  });

  it("takes the newer of two different configs, in whichever direction it is newer", () => {
    fc.assert(
      fc.property(arbShortText, arbShortText, arbStamp, arbStamp, (mineText, theirsText, a, b) => {
        fc.pre(mineText !== theirsText && a !== b);
        const [older, newer] = a < b ? [a, b] : [b, a];
        const remoteIsNewer = reconcile(
          { text: mineText, updatedAt: older },
          { state: "ok", text: theirsText, updatedAt: newer, parts: 1 },
        );
        expect(remoteIsNewer).toEqual({ action: "adopt", text: theirsText, updatedAt: newer });
        const localIsNewer = reconcile(
          { text: mineText, updatedAt: newer },
          { state: "ok", text: theirsText, updatedAt: older, parts: 1 },
        );
        expect(localIsNewer).toEqual({ action: "push" });
      }),
    );
  });

  // The normal first startup, not an edge case: a pre-existing config on each machine
  // backfills to the same PRE_SYNC_EDIT stamp.
  it("makes exactly one of two machines publish when their stamps are equal", () => {
    fc.assert(
      fc.property(arbShortText, arbShortText, arbStamp, (textA, textB, stamp) => {
        fc.pre(textA !== textB);
        const a = reconcile({ text: textA, updatedAt: stamp }, { state: "ok", text: textB, updatedAt: stamp, parts: 1 });
        const b = reconcile({ text: textB, updatedAt: stamp }, { state: "ok", text: textA, updatedAt: stamp, parts: 1 });
        const publishers = [a, b].filter((d) => d.action === "push").length;
        // Two publishers overwrite each other forever; none leaves them split for good.
        expect(publishers).toBe(1);
      }),
    );
  });

  it("waits rather than publishing over a record it could not fully read", () => {
    fc.assert(
      fc.property(
        arbShortText,
        arbStamp,
        fc.constantFrom<RemoteConfig["state"]>("incomplete", "unreadable"),
        (text, stamp, state) => {
          expect(reconcile({ text, updatedAt: stamp }, { state } as RemoteConfig)).toEqual({ action: "none" });
        },
      ),
    );
  });
});

// Two machines and one storage area, driven through arbitrary interleavings of editing
// and syncing. Every rule above is local to one decision; these are the two properties
// that are only visible across a whole conversation, and both of them fail as a LOOP
// rather than as a wrong answer — which is why no single-decision test finds them.
describe("two machines sharing one storage area — properties", () => {
  interface Machine {
    text: string;
    updatedAt: number;
  }

  // What createConfigSync does with each decision, minus the browser: push writes the
  // record and then removes the surplus part keys, adopt takes the remote wholesale.
  function syncOnce(machine: Machine, area: Record<string, unknown>, torn: boolean): "none" | "push" | "adopt" {
    const visible = torn ? tear(area) : area;
    const decision = reconcile(machine, decodeRecord(visible));
    switch (decision.action) {
      case "none":
        return "none";
      case "adopt":
        machine.text = decision.text;
        machine.updatedAt = decision.updatedAt;
        return "adopt";
      case "push": {
        const encoded = encodeRecord(machine.text, machine.updatedAt);
        const parts = Object.keys(encoded).length - 1;
        for (const key of staleKeys(area, parts)) delete area[key];
        Object.assign(area, encoded);
        return "push";
      }
    }
  }

  // A read that caught the record mid-arrival: the meta has landed, the last part has not.
  function tear(area: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...area };
    const parts = partKeysOf(copy);
    if (parts.length > 0) delete copy[parts[parts.length - 1]!];
    return copy;
  }

  const arbStep = fc.oneof(
    fc.record({ kind: fc.constant("edit" as const), machine: fc.nat({ max: 1 }), text: arbShortText }),
    fc.record({ kind: fc.constant("sync" as const), machine: fc.nat({ max: 1 }), torn: fc.boolean() }),
  );

  it("never lets a published config be replaced by an older one", () => {
    fc.assert(
      fc.property(fc.array(arbStep, { maxLength: 40 }), arbShortText, arbShortText, (steps, seedA, seedB) => {
        // Both machines start from a pre-sync config, so both carry the same backfilled
        // stamp — the tie the reconciler has to break the same way on each of them.
        const machines: Machine[] = [
          { text: seedA, updatedAt: 1000 },
          { text: seedB, updatedAt: 1000 },
        ];
        const area: Record<string, unknown> = {};
        let clock = 1000;

        for (const step of steps) {
          if (step.kind === "edit") {
            // An edit is always stamped later than anything seen so far.
            machines[step.machine]!.text = step.text;
            machines[step.machine]!.updatedAt = ++clock;
            continue;
          }
          const before = decodeRecord(area);
          syncOnce(machines[step.machine]!, area, step.torn);
          const after = decodeRecord(area);
          if (before.state === "ok" && after.state === "ok") {
            // The published stamp only ever moves forward. A machine that reads a torn
            // record and pushes anyway is exactly how it would move back.
            expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
          }
        }
      }),
    );
  });

  it("converges on one config and then stops, from any interleaving", () => {
    fc.assert(
      fc.property(fc.array(arbStep, { maxLength: 40 }), arbShortText, arbShortText, (steps, seedA, seedB) => {
        const machines: Machine[] = [
          { text: seedA, updatedAt: 1000 },
          { text: seedB, updatedAt: 1000 },
        ];
        const area: Record<string, unknown> = {};
        let clock = 1000;
        for (const step of steps) {
          if (step.kind === "edit") {
            machines[step.machine]!.text = step.text;
            machines[step.machine]!.updatedAt = ++clock;
          } else {
            syncOnce(machines[step.machine]!, area, step.torn);
          }
        }

        // Editing stops; both machines keep syncing whole records. Four rounds is already
        // more than the worst case (push, counter-push, adopt, settle) — needing more
        // means two machines are answering each other rather than agreeing.
        let rounds = 0;
        for (; rounds < 4; rounds++) {
          const acted = [syncOnce(machines[0]!, area, false), syncOnce(machines[1]!, area, false)];
          if (acted.every((a) => a === "none")) break;
        }
        expect(rounds).toBeLessThan(4);
        expect(machines[0]!.text).toBe(machines[1]!.text);
        expect(decodeRecord(area)).toMatchObject({ state: "ok", text: machines[0]!.text });
      }),
    );
  });
});
