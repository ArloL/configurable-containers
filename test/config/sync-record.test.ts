import { describe, it, expect } from "vitest";
import {
  CHUNK_CHARS,
  ConfigTooLargeError,
  MAX_PARTS,
  META_KEY,
  PART_KEY_PREFIX,
  SYNC_VERSION,
  decodeRecord,
  encodeRecord,
  hashText,
  partKey,
  reconcile,
  splitParts,
  staleKeys,
} from "../../src/config/sync-record";

const anEdit = (text: string, updatedAt: number) => ({ text, updatedAt });

function published(text: string, updatedAt = 1000): Record<string, unknown> {
  return encodeRecord(text, updatedAt);
}

describe("encoding a config for storage.sync", () => {
  it("round-trips a config through the record", () => {
    const text = "rules:\n  - match: work.example\n    open: Work\n";
    const decoded = decodeRecord(published(text, 42));
    expect(decoded).toEqual({ state: "ok", text, updatedAt: 42, parts: 1 });
  });

  it("round-trips an empty config, which is a legal config meaning nothing matches", () => {
    // Zero parts would decode as `absent`, making "published an empty config"
    // indistinguishable from "nobody has published anything".
    expect(splitParts("")).toEqual([""]);
    expect(decodeRecord(published(""))).toMatchObject({ state: "ok", text: "", parts: 1 });
  });

  it.each([
    ["one character", 1, 1],
    ["exactly one chunk", CHUNK_CHARS, 1],
    ["one character past a chunk", CHUNK_CHARS + 1, 2],
    ["several chunks", CHUNK_CHARS * 3 + 7, 4],
  ])("splits %s into %s characters over the expected part count", (_label, length, parts) => {
    const text = "x".repeat(length);
    expect(splitParts(text)).toHaveLength(parts);
    expect(decodeRecord(published(text))).toMatchObject({ state: "ok", text, parts });
  });

  it("refuses a config that needs more parts than the area allows", () => {
    const tooBig = "x".repeat(CHUNK_CHARS * MAX_PARTS + 1);
    expect(() => encodeRecord(tooBig, 1)).toThrow(ConfigTooLargeError);
  });

  it("names the stale parts a shorter config leaves behind", () => {
    const long = published("y".repeat(CHUNK_CHARS * 3));
    const short = published("y");
    expect(staleKeys(long, Object.keys(short).length - 1)).toEqual([partKey(1), partKey(2)]);
  });

  it("leaves an unrelated key out of the stale list", () => {
    // "someOtherKey9" is the shape that matters: drop the prefix test and its twelfth
    // character onwards parses as a part index, so it would be deleted from someone
    // else's storage.sync. The area is shared with every other extension the user has.
    const foreign = { [META_KEY]: {}, somethingElse: "1", someOtherKey9: "1", [partKey(0)]: "a" };
    expect(staleKeys(foreign, 1)).toEqual([]);
  });
});

// Chunking is only OBSERVABLE against Firefox's real quota enforcement — raising
// CHUNK_CHARS to a million passes every other test in this file, because they all
// interpolate the constant and move with it. That case lives in
// test/e2e/config-sync.test.ts. These are the local stand-ins: they pin the literal and
// check the arithmetic the constants exist to satisfy.
describe("the sizes Firefox will accept", () => {
  const QUOTA_BYTES_PER_ITEM = 8192;
  const QUOTA_BYTES = 102400;

  it("keeps one part under the per-item quota even if every character escapes", () => {
    const allEscaped = JSON.stringify({ [partKey(MAX_PARTS - 1)]: "\n".repeat(CHUNK_CHARS) });
    expect(allEscaped.length).toBeLessThan(QUOTA_BYTES_PER_ITEM);
  });

  it("keeps a full-sized record under the area-wide quota even if every character escapes", () => {
    const worstCasePart = JSON.stringify({ [partKey(MAX_PARTS - 1)]: "\n".repeat(CHUNK_CHARS) }).length;
    expect(worstCasePart * MAX_PARTS).toBeLessThan(QUOTA_BYTES);
  });

  it("splits a config Firefox would reject as one item across several", () => {
    expect(CHUNK_CHARS).toBe(3000); // the literal, so raising it cannot pass silently
    expect(splitParts("x".repeat(QUOTA_BYTES_PER_ITEM))).toHaveLength(3);
  });
});

describe("decoding a record that is not fully there", () => {
  it("reads an empty area as absent, the one state that means publish over it", () => {
    expect(decodeRecord({})).toEqual({ state: "absent" });
  });

  it("reads a record whose last part has not arrived as incomplete, never as absent", () => {
    // The consequential branch: `absent` would mean push, so this machine would publish
    // its own older config over an update that was still landing, and the sender would
    // then adopt the rollback.
    const arriving = published("z".repeat(CHUNK_CHARS * 2));
    delete arriving[partKey(1)];
    expect(decodeRecord(arriving)).toEqual({ state: "incomplete" });
  });

  it("reads a record mixing an old part with a new one as incomplete", () => {
    // Same length, different content — the case a length check alone would wave through,
    // and an ordinary edit (swapping one host for another of the same width) produces it.
    const record = published("a".repeat(CHUNK_CHARS) + "bbbb");
    record[partKey(1)] = "cccc";
    expect(decodeRecord(record)).toEqual({ state: "incomplete" });
  });

  it("reads a record from a newer version as unreadable rather than overwriting it", () => {
    const future = published("rules: []");
    future[META_KEY] = { ...(future[META_KEY] as object), v: SYNC_VERSION + 1 };
    expect(decodeRecord(future)).toEqual({ state: "unreadable" });
  });

  it("reads a meta key it cannot parse as unreadable", () => {
    expect(decodeRecord({ [META_KEY]: "not a record" })).toEqual({ state: "unreadable" });
  });
});

describe("hashText", () => {
  it("gives the same digest for the same text, so both machines agree", () => {
    expect(hashText("rules: []")).toBe(hashText("rules: []"));
  });

  it("gives different digests for texts of equal length", () => {
    expect(hashText("aaaa")).not.toBe(hashText("aaab"));
  });

  // The digest is a WIRE FORMAT, not an implementation detail: it is written by one
  // machine and compared by another, which may be running an older build. Change the
  // algorithm and every record reads as `incomplete` on the machine that disagrees —
  // sync stops, silently and permanently, with nothing failing anywhere. So the answers
  // are pinned, not just the properties of the answers. FNV-1a, 32-bit, over UTF-16 code
  // units.
  it.each([
    ["", "811c9dc5"], // the FNV offset basis: an empty config still gets a real digest
    ["a", "e40c292c"],
    ["rules: []", "fb58387a"],
    ["rules:\n  - match: work.example\n    open: Work\n", "a5502a2c"],
    ["ä€𝄞", "7686953f"], // beyond ASCII, including a surrogate pair
  ])("digests %j as %s, on every build", (text, digest) => {
    expect(hashText(text)).toBe(digest);
  });

  it("is always eight hex characters, so a leading zero is never dropped", () => {
    // padStart is what keeps that true; without it a small digest is shorter, which
    // still compares fine against itself and not at all against another build.
    expect(hashText("\u0000")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashText("some other text")).toMatch(/^[0-9a-f]{8}$/);
  });
});

// Both machines have to agree on where the record lives and what its digest looks like,
// and they may be running different builds. These constants and that algorithm are a wire
// format; renaming one is a silent, permanent sync failure with nothing failing anywhere.
describe("the wire format", () => {
  it("keeps the storage keys it has always used", () => {
    expect(META_KEY).toBe("ccConfigMeta");
    expect(PART_KEY_PREFIX).toBe("ccConfigPart");
    expect(partKey(0)).toBe("ccConfigPart0");
    expect(partKey(MAX_PARTS - 1)).toBe("ccConfigPart15");
  });

  it("says how big the config was when it refuses to publish it", () => {
    const tooBig = "x".repeat(CHUNK_CHARS * MAX_PARTS + 1);
    try {
      encodeRecord(tooBig, 1);
      expect.unreachable("a config over the area quota must not encode");
    } catch (e) {
      // The message reaches the user through the options page; a bare "failed" leaves
      // them with a config that silently stops syncing and no idea why.
      expect(e).toBeInstanceOf(ConfigTooLargeError);
      expect((e as ConfigTooLargeError).name).toBe("ConfigTooLargeError");
      expect((e as ConfigTooLargeError).message).toBe(
        `config needs ${MAX_PARTS + 1} sync parts, limit is ${MAX_PARTS}`,
      );
      expect((e as ConfigTooLargeError).parts).toBe(MAX_PARTS + 1);
    }
  });
});

describe("a meta that does not describe the parts beside it", () => {
  const metaOf = (items: Record<string, unknown>) => items[META_KEY] as Record<string, unknown>;

  // Each of these assembles into text that passes the length and hash check. What rejects
  // them is the part count itself being impossible — so if that guard goes, they decode as
  // `ok` and a truncated config is adopted as though it were whole.
  it("refuses a fractional part count that stops short of the parts present", () => {
    const items = published("x", 5);
    expect(decodeRecord({ ...items, [META_KEY]: { ...metaOf(items), parts: 0.5 } })).toEqual({
      state: "incomplete",
    });
  });

  it("refuses a zero part count, even for the empty config it would assemble correctly", () => {
    // "" is a legal config meaning nothing matches, and it publishes as ONE empty part.
    // Zero parts joins to "" as well, and would be indistinguishable from it.
    const items = published("", 5);
    expect(decodeRecord({ ...items, [META_KEY]: { ...metaOf(items), parts: 0 } })).toEqual({
      state: "incomplete",
    });
  });

  it("refuses more parts than the area can hold, even with every one of them present", () => {
    const text = "x".repeat(CHUNK_CHARS * MAX_PARTS);
    const items = encodeRecord(text, 5);
    const overfull = {
      ...items,
      [partKey(MAX_PARTS)]: "y",
      [META_KEY]: { ...metaOf(items), parts: MAX_PARTS + 1, len: text.length + 1, hash: hashText(text + "y") },
    };
    // Internally consistent and complete; refused because QUOTA_BYTES says a record this
    // size cannot have been written whole.
    expect(decodeRecord(overfull)).toEqual({ state: "incomplete" });
  });

  it("refuses a part that is not text, even when it joins to the right config", () => {
    const items = published("5", 5);
    // `5` stringifies to exactly the config that was published, so length and hash both
    // agree. Only the type check tells them apart.
    expect(decodeRecord({ ...items, [partKey(0)]: 5 })).toEqual({ state: "incomplete" });
  });
});

describe("a meta key this build cannot use", () => {
  const metaOf = (items: Record<string, unknown>) => items[META_KEY] as Record<string, unknown>;

  it("supersedes a record written by an older sync version", () => {
    // Ours is newer, so publishing over it is right — unlike the newer-version case,
    // where the other machine knows something this build does not.
    const items = published("old-shape", 5);
    const stale = { ...items, [META_KEY]: { ...metaOf(items), v: SYNC_VERSION - 1 } };
    expect(decodeRecord(stale)).toEqual({ state: "absent" });
  });

  it.each([
    ["a fractional part count", 1.5],
    ["no parts at all", 0],
    ["a negative part count", -1],
    ["more parts than the area can hold", MAX_PARTS + 1],
  ])("waits on %s rather than reading what is there", (_case, parts) => {
    const items = published("x", 5);
    expect(decodeRecord({ ...items, [META_KEY]: { ...metaOf(items), parts } })).toEqual({
      state: "incomplete",
    });
  });

  it.each([
    ["v", "1"],
    ["parts", "1"],
    ["len", "1"],
    ["hash", 1],
    ["updatedAt", "1"],
  ])("refuses to overwrite a record whose %s is the wrong type", (field, value) => {
    const items = published("x", 5);
    // Unreadable, not absent: absent means push, and a record we cannot parse is still a
    // record somebody published.
    expect(decodeRecord({ ...items, [META_KEY]: { ...metaOf(items), [field]: value } })).toEqual({
      state: "unreadable",
    });
  });

  it.each([["a string"], [42], [null], [[]]])("refuses a meta that is not a mapping (%j)", (meta) => {
    const items = published("x", 5);
    expect(decodeRecord({ ...items, [META_KEY]: meta })).toEqual({ state: "unreadable" });
  });
});

describe("reconciling the local config against the published one", () => {
  const local = anEdit("local text", 100);

  it("publishes when nothing has ever been published", () => {
    expect(reconcile(local, { state: "absent" })).toEqual({ action: "push" });
  });

  it.each([["incomplete"], ["unreadable"]] as const)(
    "waits on a %s record instead of publishing over it",
    (state) => {
      expect(reconcile(local, { state })).toEqual({ action: "none" });
    },
  );

  it("does nothing when the two copies already agree", () => {
    const remote = decodeRecord(published("local text", 100));
    expect(reconcile(local, remote)).toEqual({ action: "none" });
  });

  it("does nothing when the texts agree but the stamps do not", () => {
    // Adoption ends in runtime.reload(). Adopting identical text would have two machines
    // restarting each other forever.
    const remote = decodeRecord(published("local text", 999));
    expect(reconcile(local, remote)).toEqual({ action: "none" });
  });

  it("adopts a newer published config", () => {
    const remote = decodeRecord(published("remote text", 200));
    expect(reconcile(local, remote)).toEqual({
      action: "adopt",
      text: "remote text",
      updatedAt: 200,
    });
  });

  it("publishes over an older one", () => {
    const remote = decodeRecord(published("remote text", 50));
    expect(reconcile(local, remote)).toEqual({ action: "push" });
  });
});

describe("the tie-break, when two machines hold different text at the same stamp", () => {
  // Not hypothetical: every config edited before stamps existed is backfilled to the
  // same value, so the first startup after an update has exactly this shape.
  const older = anEdit("aaa", 7);
  const newer = anEdit("bbb", 7);

  it("resolves to opposite actions on the two machines, so exactly one publishes", () => {
    const fromA = reconcile(older, decodeRecord(published(newer.text, 7)));
    const fromB = reconcile(newer, decodeRecord(published(older.text, 7)));
    expect(fromA).toEqual({ action: "adopt", text: "bbb", updatedAt: 7 });
    expect(fromB).toEqual({ action: "push" });
    // A tie-break of "local always wins" would have both of them push forever.
    expect(fromA.action).not.toBe(fromB.action);
  });

  it("never adopts identical text, so a converged pair goes quiet", () => {
    expect(reconcile(older, decodeRecord(published(older.text, 7)))).toEqual({ action: "none" });
  });
});
