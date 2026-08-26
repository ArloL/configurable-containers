// Fitness function: every collection in `src/`, and what stops it growing.
//
// The gates around this one all ask whether an answer is right. None of them asks what the
// background page is still holding after a week of browsing, and none of them can: the L3
// cases drive tens of navigations and `npm test` restarts the world between files. A
// structure that gains an entry per navigation and loses none is invisible to all of it —
// the same shape as F10, silent and only visible over time.
//
// It got sharper when a config save stopped reloading the extension (2026-08-25 spec). A
// save used to empty every one of these, so "unbounded" meant "until the user next edits
// their rules". Now nothing empties them until the browser restarts.
//
// So this is an inventory rather than a measurement. Measuring retained bytes means either
// reaching into a closure (the collections are private, and exporting them to be counted
// would change `src/` to satisfy a test) or timing a heap, which is the flake generator
// `decision-cost.test.ts` exists to avoid. What an inventory buys instead: the next
// per-navigation Map cannot be added without someone writing down what empties it.
//
// House rules as everywhere in this directory — an exact list, never a bound; identity by
// file and name, never by line; comments stripped before matching.
import { describe, it, expect } from "vitest";
import { sourceFiles } from "./sources";

type Lifetime =
  // Built and dropped inside one call. Nothing to bound.
  | "call"
  // Lives as long as the background context, which in MV2 means until the browser restarts:
  // Firefox suspends an event page when it is idle, and CC's page is not one. A config save
  // no longer ends it either — saving applies the config in place.
  | "session";

interface Retained {
  where: string;
  name: string;
  lifetime: Lifetime;
  /** What removes entries, or what caps the number there can ever be. */
  bound: string;
}

// One row per collection in `src/`. The `bound` column is the whole point of the file.
const DECLARED: Retained[] = [
  // --- constants: fixed at module load, one entry per value the grammar allows --------
  // The parser's key allow-lists are no longer here: they are the FEATURE_VERSIONS tables,
  // plain object literals, which this file's Set/Map scan does not see and which
  // test/config/parse.version.test.ts pins by value instead.
  { where: "src/config/parse.ts", name: "SAME_SITE", lifetime: "session", bound: "literal" },
  { where: "src/config/parse.ts", name: "RUN_AT", lifetime: "session", bound: "literal" },
  // The pages `supersede` replaces rather than keeps. A constant, but an ALLOW-LIST: the
  // cost of it being short is a fresh-tab page missing from it, not memory.
  { where: "src/engine/supersede.ts", name: "EMPTY_PAGES", lifetime: "session", bound: "literal" },

  // --- per-call working sets ----------------------------------------------------------
  { where: "src/engine/disposer.ts", name: "occupied", lifetime: "call", bound: "one sweep" },
  { where: "src/engine/pause.ts", name: "named", lifetime: "call", bound: "one snapshot" },
  { where: "src/engine/pause.ts", name: "hostsByStore", lifetime: "call", bound: "one snapshot" },
  { where: "src/engine/pause.ts", name: "occupied", lifetime: "call", bound: "one disarm-on-empty pass" },
  { where: "src/extension/picker-protocol.ts", name: "taken", lifetime: "call", bound: "one choice screen" },
  { where: "src/extension/picker-protocol.ts", name: "map", lifetime: "call", bound: "one choice screen" },

  // --- session-lived, and emptied ------------------------------------------------------
  {
    where: "src/engine/engine.ts",
    name: "reopenedNav",
    lifetime: "session",
    bound: "one entry per tab mid-reopen; deleted when the awaited navigation arrives or another does",
  },
  {
    where: "src/engine/engine.ts",
    name: "routing",
    lifetime: "session",
    bound: "one entry per tab with a navigation in flight; deleted in the queue's finally",
  },
  {
    where: "src/engine/pause.ts",
    name: "armed",
    lifetime: "session",
    bound: "one entry per container the user armed; deleted by disarm, including on empty",
  },
  {
    where: "src/engine/registry.ts",
    name: "permanentByName",
    lifetime: "session",
    bound: "one entry per permanent container name the config names",
  },

  // --- session-lived and NOT emptied. The list this file exists for. -------------------
  {
    where: "src/engine/engine.ts",
    name: "handled",
    lifetime: "session",
    bound: "nothing — one requestId+url string per navigation CC reopened or sent to the choice screen",
  },
  {
    where: "src/engine/engine.ts",
    name: "warnedHosts",
    lifetime: "session",
    bound: "nothing — one host per site that declined a non-GET",
  },
  {
    where: "src/engine/engine.ts",
    name: "viewSourceNav",
    lifetime: "session",
    bound: "nothing — deleted by the tab's next top-level navigation, so it leaks one tab id per tab closed while still showing source (CLAUDE.md prices that at one integer)",
  },
  {
    where: "src/engine/auto-temp.ts",
    name: "processed",
    lifetime: "session",
    bound: "nothing — one tab id per tab the session has seen created",
  },
];

// `const x = new Set(...)` / `new Map(...)`, in code rather than comments. Weak variants
// are matched too so that adding one is still a decision someone records here, even though
// its entries are collectable.
const DECLARATION = /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:Weak)?(?:Set|Map)\b/g;

function inventory(): string[] {
  return sourceFiles("src")
    .flatMap((file) => [...file.code.matchAll(DECLARATION)].map((m) => `${file.path} ${m[1]}`))
    .sort();
}

const key = (r: Retained) => `${r.where} ${r.name}`;

describe("fitness — what the background page keeps", () => {
  it("has a declared bound for every collection in src/, and no stale rows", () => {
    // Adding a collection fails here until it is entered above. That is the check: the
    // question "what empties this?" gets asked once, in writing, at the moment the answer
    // is still obvious to whoever added it.
    expect(inventory()).toEqual(DECLARED.map(key).sort());
  });

  it("keeps the list of structures nothing empties at exactly four", () => {
    // Not a bound of "at most four" — an exact list, so the fifth is a conversation rather
    // than a silent arrival.
    //
    // None of the four is a problem today, and saying so is half the point of writing them
    // down. Each holds one short string or number, and each is fed by something rarer than
    // browsing: `handled` by a navigation CC actually reopened, `warnedHosts` by a site
    // that declined a non-GET, `processed` by a tab being created, `viewSourceNav` only by
    // a tab closed while still on `view-source:`. A long session costs kilobytes — and a
    // session is now a browser run, since a config save applies in place rather than
    // reloading the extension. That priced these four again rather than changing them.
    //
    // What it changed for the better is the state a save used to destroy: `reopenedNav` and
    // the tmp<N> counter survive one, so saving mid-reopen no longer costs an extra reopen.
    //
    // What this row list is for is the fifth one — the per-navigation Map holding a
    // NavContext, added by someone who reasonably assumed the background page restarts. It
    // restarts with the browser and at no other time.
    const unbounded = DECLARED.filter((r) => r.bound.startsWith("nothing")).map(key).sort();
    expect(unbounded).toEqual([
      "src/engine/auto-temp.ts processed",
      "src/engine/engine.ts handled",
      "src/engine/engine.ts viewSourceNav",
      "src/engine/engine.ts warnedHosts",
    ]);
  });

  it("gives every row a reason rather than a shrug", () => {
    for (const row of DECLARED) {
      expect(row.bound, `${key(row)} needs a bound`).not.toBe("");
      // "nothing" on its own says a structure grows without saying what it grows with,
      // which is the sentence a reader needs to judge whether it matters.
      if (row.bound === "nothing") {
        expect.unreachable(`${key(row)}: say what it grows one entry per`);
      }
    }
  });
});
