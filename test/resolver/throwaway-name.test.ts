// The throwaway naming rule, at L1.
//
// It lives here rather than beside the registry that mints these names because it is the
// one rule TWO layers depend on and neither owns: `engine/registry` mints `tmp<N>` and the
// disposer reclaims it, while `config/parse` REFUSES a container the user names in that
// shape. Both import `isThrowawayName` from `src/resolver/types.ts` so the shape is one
// declaration; these cases are what stop that declaration being widened.
//
// Being under `test/resolver/` is also what puts it inside the mutation gate
// (vitest.mutation.config.ts). `src/resolver/**` is mutated and only these five suites get
// to kill the mutants, so a regex loosened to `/^tmp/` — the exact widening that costs a
// user their `tmpwork` — fails here rather than surviving as a score.
import { describe, it, expect } from "vitest";
import { TMP_PREFIX, isThrowawayName } from "../../src/resolver/types";

describe("TMP_PREFIX", () => {
  // The literal, said out loud once. Every other case interpolates the constant, so a
  // rename moves both sides of the assertion and they stay green; the cases that do
  // hardcode "tmp1" (highestTmpSuffix, the engine's reopen expectations) fail for their
  // own reasons and say nothing about why the value matters.
  //
  // It matters because a throwaway is recognised as ours by NAME, and the name is the only
  // record that outlives the background context. Renaming the prefix orphans every tmp<N>
  // container already in a live profile — the disposer stops seeing them, so they are never
  // reclaimed, and highestTmpSuffix stops counting them, so the counter reissues from 1
  // beside containers that already hold that name. Both are silent. This is a compatibility
  // constant, not an implementation detail: change it only with a migration that renames
  // what is already out there.
  it("is 'tmp'", () => {
    expect(TMP_PREFIX).toBe("tmp");
  });
});

describe("isThrowawayName", () => {
  // The digits are not decoration. The prefix ALONE claims every container a user could
  // reasonably name — `tmpwork`, or `tmpfiles.org` from an auto-named rule for that host —
  // and claiming one is two silent losses: the disposer deletes it once its last tab closes,
  // with the logins in it, and toRef reads a tab in it as already-in-a-throwaway, so routing
  // answers the continuity question about a permanent container.
  it("recognises a throwaway by tmp + digits, and nothing else", () => {
    for (const name of ["tmp1", "tmp42", "tmp0", "tmp1000"]) {
      expect(isThrowawayName(name)).toBe(true);
    }
    for (const name of ["tmp", "tmpwork", "tmpfiles.org", "tmp 1", "tmp1x", "xtmp1", "Tmp1", "tmp-1", "tmp1.5"]) {
      expect(isThrowawayName(name)).toBe(false);
    }
  });

  // Both minting sites build the name as TMP_PREFIX + a decimal counter; if either ever
  // stopped, the container it created would be invisible to the disposer and leak.
  it("recognises the names the registry itself mints", () => {
    expect(isThrowawayName(TMP_PREFIX + "7")).toBe(true);
  });

  // The empty string is what a container with no name reads as, and `""` matching would
  // hand the disposer every unnamed identity in the profile.
  it("does not claim a nameless container", () => {
    expect(isThrowawayName("")).toBe(false);
  });
});
