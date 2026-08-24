import type { BrowserPort } from "./port";
import type { ContainerRef, Target } from "../resolver/types";

// Reserved name prefix: throwaways are named `tmp<N>`. Identity comes from the name so it
// survives a restart — the background context, and every map in it, dies on each config
// save, leaving the name as the only durable record.
export const TMP_PREFIX = "tmp";

// The reserved name in full: prefix AND decimal suffix, which is what `createIdentity`
// mints. The digits are load-bearing — on the prefix alone a user's `tmpwork`, or an
// action-less rule for `tmpfiles.org`, is claimed as ours, and that costs two silent
// losses: the disposer deletes it once its last tab closes, logins and all, and `toRef`
// reads a tab in it as "in a throwaway". `config/parse` refusing a container named in this
// shape is the other half of keeping the two sets apart.
const TMP_NAME = /^tmp(\d+)$/;

export function isThrowawayName(name: string): boolean {
  return TMP_NAME.test(name);
}

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
      if (isThrowawayName(ci.name)) {
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
