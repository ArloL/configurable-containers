// The shape the config takes inside browser.storage.sync, and what to do when the local and
// remote copies disagree. Pure, so the whole policy is testable without a browser —
// src/extension/config-sync.ts only moves bytes. See the 2026-07-30 design spec §3.

export const SYNC_VERSION = 1;
export const META_KEY = "ccConfigMeta";
export const PART_KEY_PREFIX = "ccConfigPart";

// Firefox enforces QUOTA_BYTES_PER_ITEM = 8192 on storage.sync, over the JSON encoding of
// the value. Config YAML is newline-dense and every newline doubles under JSON escaping, so
// 3000 characters stay under the limit even if EVERY character escaped (~6KB). The author's
// config is already 5.7KB, so a one-item implementation does not fail today — it fails a few
// rules from now, on whichever machine saves last.
export const CHUNK_CHARS = 3000;

// Firefox also enforces QUOTA_BYTES = 102400 over the whole area, so the part count is
// bounded by the WORST case too: 16 parts of fully-escaped text is ~96KB and clears; 32
// would be 192KB and would not, even though 32 parts of ordinary YAML measure fine — the
// kind of limit that holds until someone's config is newline-dense. 48000 characters is
// eight times the author's config; past it a config fails loudly instead of truncating.
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

// FNV-1a, 32 bits. It rejects a record assembled from a mix of old and new parts; it is not
// resisting an adversary. Dependency-free so both machines get the same digest.
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
  // An empty config is legal: parseConfig("") means "nothing matches". Zero parts would
  // decode as `absent`, making "published an empty config" and "never published"
  // indistinguishable.
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

// Telling `incomplete` from `absent` is the most consequential branch here. Parts and the
// meta key arrive as ordinary storage changes with nothing making them land together, so a
// mid-arrival read sees a meta claiming three parts with two present. Reading that as
// `absent` means PUSH: this machine publishes its older config over the update still
// landing, and the sender adopts the rollback. `incomplete` waits for the next change
// event.
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
  // Length alone would not do: swapping one host for another of the same width is an
  // ordinary edit, and this exists to reject a MIXTURE of old and new parts.
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
      // Load-bearing: adoption ends in runtime.reload(), so if equal text could adopt, two
      // machines would restart each other forever.
      if (remote.text === local.text) return { action: "none" };
      if (remote.updatedAt > local.updatedAt) {
        return { action: "adopt", text: remote.text, updatedAt: remote.updatedAt };
      }
      if (remote.updatedAt < local.updatedAt) return { action: "push" };
      // Equal stamps, different text — the NORMAL first startup, since the backfill gives
      // every pre-sync config the same stamp. The tie-break must give both machines the
      // SAME answer: "local wins" has both push and overwrite each other forever. Comparing
      // the texts, not their hashes, means no collision can bring that back.
      return remote.text > local.text
        ? { action: "adopt", text: remote.text, updatedAt: remote.updatedAt }
        : { action: "push" };
    }
  }
}
