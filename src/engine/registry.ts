import type { BrowserPort } from "./port";
import { DEFAULT_STORE_ID } from "./port";
import { TMP_NAME, TMP_PREFIX, isThrowawayName, type ContainerRef, type Target } from "../resolver/types";

// The naming rule itself is `src/resolver/types.ts`'s — `TMP_PREFIX`, `TMP_NAME` and
// `isThrowawayName` sit down there because `config/parse` refusing this shape is the other
// half of this module minting it, and a pure parser must not import an engine module to ask.
// Re-exported nowhere: both halves import it from the same place or the shape drifts.

// The largest N among existing `tmp<N>` names, or 0. The suffix counter is in-memory, so
// without this a restart reissues tmp1 beside a live tmp1. Names are the only durable
// record (see TMP_PREFIX), so the counter is recovered from them at startup.
export function highestTmpSuffix(names: string[]): number {
  let max = 0;
  for (const name of names) {
    const m = TMP_NAME.exec(name);
    if (!m) continue;
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

export interface ContainerRegistry {
  toRef(cookieStoreId: string | undefined): Promise<ContainerRef>;
  // Finds or creates, so calling it commits to the container existing.
  toStoreId(target: Target): Promise<string>;
}

export function createRegistry(port: BrowserPort, tmpSuffix: () => string): ContainerRegistry {
  const permanentByName = new Map<string, string>();

  return {
    async toRef(cookieStoreId) {
      if (!cookieStoreId || cookieStoreId === DEFAULT_STORE_ID) {
        return { kind: "default" };
      }
      const ci = await port.getIdentity(cookieStoreId);
      if (!ci) {
        console.warn(`[registry] container ${cookieStoreId} no longer exists; treating as default`);
        return { kind: "default" };
      }
      if (isThrowawayName(ci.name)) {
        return { kind: "temporary" };
      }
      return { kind: "permanent", name: ci.name };
    },

    async toStoreId(target) {
      switch (target.kind) {
        case "default":
          return DEFAULT_STORE_ID;
        case "permanent": {
          const cached = permanentByName.get(target.name);
          if (cached) return cached;
          const existing = (await port.queryIdentities()).find((c) => c.name === target.name);
          const ci = existing ?? (await port.createIdentity({ name: target.name, color: "blue", icon: "circle" }));
          permanentByName.set(target.name, ci.cookieStoreId);
          return ci.cookieStoreId;
        }
        case "temporary": {
          const ci = await port.createIdentity({ name: TMP_PREFIX + tmpSuffix(), color: "blue", icon: "circle" });
          return ci.cookieStoreId;
        }
      }
    },
  };
}
