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
// It scanned for `new Set` / `new Map` ONLY until 2026-08-26, and an array was therefore
// invisible to it — including `Recording.hosts`, which is the one collection here that
// storage.local carries across a browser restart and which was uncapped the whole time it
// could not be seen. The scan now reads every growable collection however it is spelled: a
// binding (`new Set`, `new Map`, `= [`) or a field initialised empty in an object literal
// (`hosts: []`), which is the spelling no declaration-site scan would ever have found.
//
// The price of that reach is the per-call builders it also sees — a `const out: T[] = []`
// filled and returned, of which `src/` has a dozen. They are listed as bare keys in
// PER_CALL rather than as rows: what makes a row worth reading is its `bound` column, and
// "one call" is not an answer anyone needs to weigh. Listing them at all is still the
// point — a new collection lands in neither list until someone decides which it belongs in.
//
// House rules as everywhere in this directory — an exact list, never a bound; identity by
// file and name, never by line; comments stripped before matching.
import { describe, it, expect } from "vitest";
import { sourceFiles } from "./sources";

interface Retained {
  where: string;
  name: string;
  /** What removes entries, or what caps the number there can ever be. */
  bound: string;
}

// Built and dropped inside one call. Nothing to bound, so nothing to say about each beyond
// naming it here rather than in RETAINED. Deduplicated by file and name, so two builders
// that share a name in one file (`sync-record.ts` encodes and decodes with a `parts`) are
// one entry: they are the same shape answered the same way.
const PER_CALL: string[] = [
  "src/config/load.ts groups", //         the empty config a failed load returns
  "src/config/load.ts rules",
  "src/config/parse.ts groups", //        one parse
  "src/config/parse.ts rules",
  "src/config/parse.ts warnings",
  "src/config/sync-record.ts parts", //   one encode, one decode
  "src/engine/disposer.ts occupied", //   one sweep
  "src/engine/pause.ts containers", //    one status snapshot
  "src/engine/pause.ts hostsByStore",
  "src/engine/pause.ts named",
  "src/engine/pause.ts occupied", //      one disarm-on-empty pass
  "src/extension/picker-protocol.ts all", // one choice screen
  "src/extension/picker-protocol.ts map",
  "src/extension/picker-protocol.ts taken",
  "src/overlays/scripts.ts out", //       one config's registrations
];

// Lives as long as the background context, which in MV2 means until the browser restarts:
// Firefox suspends an event page when it is idle, and CC's page is not one. A config save
// no longer ends it either — saving applies the config in place. One row each, and the
// `bound` column is the whole point of the file.
const RETAINED: Retained[] = [
  // --- constants: fixed at module load, one entry per value the grammar allows --------
  // The parser's key allow-lists are no longer here: they are the FEATURE_VERSIONS tables,
  // plain object literals, which this file's scan does not see and which
  // test/config/parse.version.test.ts pins by value instead.
  { where: "src/config/parse.ts", name: "ACTION_KEYS", bound: "literal" },
  { where: "src/config/parse.ts", name: "SAME_SITE", bound: "literal" },
  { where: "src/config/parse.ts", name: "RUN_AT", bound: "literal" },
  { where: "src/extension/picker-protocol.ts", name: "DIGITS", bound: "literal" },
  // The pages `supersede` replaces rather than keeps. A constant, but an ALLOW-LIST: the
  // cost of it being short is a fresh-tab page missing from it, not memory.
  { where: "src/engine/supersede.ts", name: "EMPTY_PAGES", bound: "literal" },

  // --- session-lived, and emptied ------------------------------------------------------
  {
    where: "src/engine/engine.ts",
    name: "reopenedNav",
    bound: "one entry per tab mid-reopen; deleted when the awaited navigation arrives or another does",
  },
  {
    where: "src/engine/engine.ts",
    name: "routing",
    bound: "one entry per tab with a navigation in flight; deleted in the queue's finally",
  },
  {
    where: "src/engine/pause.ts",
    name: "armed",
    bound: "one entry per container the user armed; deleted by disarm, including on empty",
  },
  {
    where: "src/engine/registry.ts",
    name: "permanentByName",
    bound: "one entry per permanent container name the config names",
  },
  {
    where: "src/engine/pause.ts",
    name: "recordings",
    bound: "MAX_RECORDINGS, applied by arm()",
  },
  {
    where: "src/engine/pause.ts",
    name: "hosts",
    bound: "MAX_RECORDED_HOSTS per recording, applied by record(); hosts past it are counted in `dropped` instead",
  },
  {
    where: "src/engine/script-injector.ts",
    name: "live",
    bound: "one handle per registered snippet; replaced wholesale by each apply()",
  },
  // The ONE config object the siblings all read, filled in place by Object.assign so that
  // handing them a fresh one cannot leave them on the empty config.
  {
    where: "src/extension/wiring.ts",
    name: "rules",
    bound: "one entry per rule the stored config names; replaced wholesale by each applyStored",
  },
  {
    where: "src/extension/wiring.ts",
    name: "groups",
    bound: "one entry per group the stored config names; replaced wholesale by each applyStored",
  },

  // --- session-lived and NOT emptied. The list this file exists for. -------------------
  {
    where: "src/engine/engine.ts",
    name: "handled",
    bound: "nothing — one requestId+url string per navigation CC reopened or sent to the choice screen",
  },
  {
    where: "src/engine/engine.ts",
    name: "warnedHosts",
    bound: "nothing — one host per site that declined a non-GET",
  },
  {
    where: "src/engine/engine.ts",
    name: "viewSourceNav",
    bound: "nothing — deleted by the tab's next top-level navigation, so it leaks one tab id per tab closed while still showing source (CLAUDE.md prices that at one integer)",
  },
  {
    where: "src/engine/auto-temp.ts",
    name: "processed",
    bound: "nothing — one tab id per tab the session has seen created",
  },
];

// `const x = new Set(...)` / `new Map(...)` / `= [...]`, in code rather than comments. Weak
// variants are matched too so that adding one is still a decision someone records here,
// even though its entries are collectable.
const BINDING = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:new\s+(?:Weak)?(?:Set|Map)\b|\[)/g;

// `hosts: []` — a collection that never gets a binding of its own because it is born as a
// field of something else. Only the EMPTY literal: `armed: [...armed]` is a copy taken for
// one snapshot, not a structure anything appends to, and a type annotation (`parts: string[]
// = []`) has a word between the colon and the bracket so it cannot match here.
const FIELD = /(\w+)\s*:\s*\[\s*\]/g;

function inventory(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles("src")) {
    for (const re of [BINDING, FIELD]) {
      for (const m of file.code.matchAll(re)) found.add(`${file.path} ${m[1]}`);
    }
  }
  return [...found].sort();
}

const key = (r: Retained) => `${r.where} ${r.name}`;

describe("fitness — what the background page keeps", () => {
  it("has a declared bound for every collection in src/, and no stale rows", () => {
    // Adding a collection fails here until it is entered above. That is the check: the
    // question "what empties this?" gets asked once, in writing, at the moment the answer
    // is still obvious to whoever added it.
    expect(inventory()).toEqual([...PER_CALL, ...RETAINED.map(key)].sort());
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
    // The fifth this list was written to catch turned out to be already present and
    // unseeable: `Recording.hosts`, which outlives the session entirely because it is in
    // storage.local. Widening the scan is what surfaced it; MAX_RECORDED_HOSTS is what
    // keeps it off this list.
    const unbounded = RETAINED.filter((r) => r.bound.startsWith("nothing")).map(key).sort();
    expect(unbounded).toEqual([
      "src/engine/auto-temp.ts processed",
      "src/engine/engine.ts handled",
      "src/engine/engine.ts viewSourceNav",
      "src/engine/engine.ts warnedHosts",
    ]);
  });

  it("gives every row a reason rather than a shrug", () => {
    for (const row of RETAINED) {
      expect(row.bound, `${key(row)} needs a bound`).not.toBe("");
      // "nothing" on its own says a structure grows without saying what it grows with,
      // which is the sentence a reader needs to judge whether it matters.
      if (row.bound === "nothing") {
        expect.unreachable(`${key(row)}: say what it grows one entry per`);
      }
    }
  });

  it("keeps the two lists disjoint, so nothing is bounded in one place and shrugged off in another", () => {
    // A key in both would satisfy the inventory twice over while the reader of RETAINED and
    // the reader of PER_CALL each believe the other list does not mention it.
    const both = RETAINED.map(key).filter((k) => PER_CALL.includes(k));
    expect(both).toEqual([]);
  });
});
