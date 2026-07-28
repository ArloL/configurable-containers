import type { BrowserPort } from "./port";
import type { ContainerRef, Target } from "../resolver/types";

// Reserved name prefix: any contextualIdentity whose name starts with this is one
// of our throwaways. Identity is derived from the name, so it survives a restart.
export const TMP_PREFIX = "tmp";

// The largest N among existing `tmp<N>` container names, or 0 if there are none.
// The suffix counter is in-memory, so a background restart would otherwise reissue
// tmp1 and collide by name with a live throwaway. Names are the only durable record
// (see TMP_PREFIX above), so the counter is recovered from them at startup.
export function highestTmpSuffix(names: string[]): number {
  let max = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const rest = name.slice(TMP_PREFIX.length);
    if (!/^\d+$/.test(rest)) continue;
    max = Math.max(max, Number(rest));
  }
  return max;
}

export interface ContainerRegistry {
  // cookieStoreId -> ContainerRef (for reading a tab's current/initiator container).
  toRef(cookieStoreId: string | undefined): Promise<ContainerRef>;
  // Target -> cookieStoreId (for executing a reopen; find-or-create as needed).
  toStoreId(target: Target): Promise<string>;
}

export function createRegistry(port: BrowserPort, tmpSuffix: () => string): ContainerRegistry {
  // name -> cookieStoreId cache for permanent find-or-create.
  const permanentByName = new Map<string, string>();

  return {
    async toRef(cookieStoreId) {
      if (!cookieStoreId || cookieStoreId === "firefox-default") {
        return { kind: "default" };
      }
      const ci = await port.getIdentity(cookieStoreId);
      if (!ci) {
        console.warn(`[registry] container ${cookieStoreId} no longer exists; treating as default`);
        return { kind: "default" };
      }
      if (ci.name.startsWith(TMP_PREFIX)) {
        return { kind: "temporary" };
      }
      return { kind: "permanent", name: ci.name };
    },

    async toStoreId(target) {
      switch (target.kind) {
        case "default":
          return "firefox-default";
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
