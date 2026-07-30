// The shape the config takes inside browser.storage.sync, and the decision of what to
// do when the local and the remote copy disagree. Pure, so the whole policy is testable
// without a browser — src/extension/config-sync.ts only moves bytes. See the 2026-07-30
// design spec §3.

export const SYNC_VERSION = 1;
export const META_KEY = "ccConfigMeta";
export const PART_KEY_PREFIX = "ccConfigPart";

// Firefox enforces QUOTA_BYTES_PER_ITEM = 8192 on storage.sync, counted over the JSON
// encoding of the value. A config is newline-dense YAML and every newline doubles in
// width under JSON escaping, so 3000 characters cannot exceed the limit even if EVERY
// character escaped (~6KB). The author's config is already 5.7KB, so a one-item
// implementation does not fail today — it fails a few rules from now, on whichever
// machine happens to save last.
export const CHUNK_CHARS = 3000;

// Firefox also enforces QUOTA_BYTES = 102400 across the whole area, so the part count
// has to be bounded by the WORST case too: 16 parts of fully-escaped text is ~96KB,
// which still clears. (32 would not — 192KB worst case — even though 32 parts of
// ordinary YAML would have measured fine, which is exactly the kind of limit that holds
// until someone's config is newline-dense.) 48000 characters is eight times the
// author's config; past it, a config fails loudly rather than being truncated to fit.
export const MAX_PARTS = 16;

export interface SyncMeta {
  v: number;
  parts: number;
  len: number;
  hash: string;
  updatedAt: number;
}

export type RemoteConfig =
  // No meta key: nobody has ever published. The ONLY state that means "push".
  | { state: "absent" }
  // Meta present but the parts do not back it up — a record still arriving.
  | { state: "incomplete" }
  // Written by a newer SYNC_VERSION than this build can read.
  | { state: "unreadable" }
  | { state: "ok"; text: string; updatedAt: number; parts: number };

export type Reconciliation =
  | { action: "none" }
  | { action: "push" }
  | { action: "adopt"; text: string; updatedAt: number };

export class ConfigTooLargeError extends Error {
  constructor(readonly parts: number) {
    super(`config needs ${parts} sync parts, limit is ${MAX_PARTS}`);
    this.name = "ConfigTooLargeError";
  }
}

// FNV-1a, 32 bits. Its job is to reject a record assembled from a mix of an old part and
// a new one; it is not resisting an adversary. Pure and dependency-free so both machines
// compute the same digest from the same text.
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function partKey(index: number): string {
  return `${PART_KEY_PREFIX}${index}`;
}

export function splitParts(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));
  // An empty config is a legal config: parseConfig("") succeeds and means "nothing
  // matches". Emitting zero parts would decode as `absent`, making "the user published
  // an empty config" indistinguishable from "nobody has published anything".
  if (parts.length === 0) parts.push("");
  return parts;
}

export function encodeRecord(text: string, updatedAt: number): Record<string, unknown> {
  const parts = splitParts(text);
  if (parts.length > MAX_PARTS) throw new ConfigTooLargeError(parts.length);
  const meta: SyncMeta = {
    v: SYNC_VERSION,
    parts: parts.length,
    len: text.length,
    hash: hashText(text),
    updatedAt,
  };
  const items: Record<string, unknown> = { [META_KEY]: meta };
  parts.forEach((part, i) => {
    items[partKey(i)] = part;
  });
  return items;
}

function readMeta(value: unknown): SyncMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as Partial<SyncMeta>;
  if (typeof m.v !== "number") return undefined;
  if (typeof m.parts !== "number" || typeof m.len !== "number") return undefined;
  if (typeof m.hash !== "string" || typeof m.updatedAt !== "number") return undefined;
  return { v: m.v, parts: m.parts, len: m.len, hash: m.hash, updatedAt: m.updatedAt };
}

// Distinguishing `incomplete` from `absent` is the most consequential branch here. The
// parts and the meta key reach a receiving machine as ordinary storage changes and
// nothing makes them land together, so a mid-arrival read sees a meta claiming three
// parts with two present. Collapsing that into `absent` would mean *push* — this machine
// would publish its own older config over the update that was still landing, and the
// sender would then adopt the rollback. `incomplete` waits; the rest of the keys fire
// another change event.
export function decodeRecord(items: Record<string, unknown>): RemoteConfig {
  const meta = readMeta(items[META_KEY]);
  if (meta === undefined) {
    // A meta key that is present but unreadable is a record we must not overwrite either.
    return items[META_KEY] === undefined ? { state: "absent" } : { state: "unreadable" };
  }
  if (meta.v > SYNC_VERSION) return { state: "unreadable" };
  if (meta.v < SYNC_VERSION) return { state: "absent" }; // an older record: ours supersedes it
  if (!Number.isInteger(meta.parts) || meta.parts < 1 || meta.parts > MAX_PARTS) {
    return { state: "incomplete" };
  }

  const parts: string[] = [];
  for (let i = 0; i < meta.parts; i++) {
    const part = items[partKey(i)];
    if (typeof part !== "string") return { state: "incomplete" };
    parts.push(part);
  }
  const text = parts.join("");
  // Length alone would not do: an edit swapping one host for another of the same width
  // is an ordinary edit, and the check exists to reject a MIXTURE of old and new parts.
  if (text.length !== meta.len || hashText(text) !== meta.hash) return { state: "incomplete" };

  return { state: "ok", text, updatedAt: meta.updatedAt, parts: meta.parts };
}

// Part keys left behind by a longer previous config. Removed after the new record is
// written, never before — see the design spec §4.
export function staleKeys(items: Record<string, unknown>, parts: number): string[] {
  return Object.keys(items).filter((key) => {
    if (!key.startsWith(PART_KEY_PREFIX)) return false;
    const index = Number(key.slice(PART_KEY_PREFIX.length));
    return Number.isInteger(index) && index >= parts;
  });
}

export function reconcile(
  local: { text: string; updatedAt: number },
  remote: RemoteConfig,
): Reconciliation {
  switch (remote.state) {
    case "incomplete":
    case "unreadable":
      return { action: "none" };
    case "absent":
      return { action: "push" };
    case "ok": {
      // Load-bearing: adoption ends in runtime.reload(). If equal text could adopt, two
      // machines would reload each other forever — an extension restarting every few
      // seconds on both machines at once.
      if (remote.text === local.text) return { action: "none" };
      if (remote.updatedAt > local.updatedAt) {
        return { action: "adopt", text: remote.text, updatedAt: remote.updatedAt };
      }
      if (remote.updatedAt < local.updatedAt) return { action: "push" };
      // Equal stamps, different text. Not hypothetical: the stamp backfill gives every
      // config edited before this slice the same value, so the first startup after an
      // update has exactly this shape. The tie-break must compute the SAME answer on both
      // machines — "local wins" would have both of them push, each overwriting the other,
      // forever. Comparing the text itself rather than its hash means no collision can
      // reintroduce that: two different strings always compare unequal.
      return remote.text > local.text
        ? { action: "adopt", text: remote.text, updatedAt: remote.updatedAt }
        : { action: "push" };
    }
  }
}
