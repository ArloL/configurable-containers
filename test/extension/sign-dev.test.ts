import { describe, it, expect } from "vitest";
import { UPDATE_URL } from "../../scripts/sign-dev";

// Importing this module at all is part of what these cases pin: scripts/sign-dev.ts
// uploads to AMO when run, so its CLI tail is guarded by the argv check. Without the
// guard, this import alone would sign and publish a build.
describe("UPDATE_URL", () => {
  it("is the exact url already baked into signed builds", () => {
    // Every dev build ever signed carries this string inside its signed manifest and
    // polls it forever. Changing it does not migrate anyone — it strands every
    // installed build on a url nothing publishes to. Pinned as a literal on purpose:
    // comparing against the constant would let the constant itself drift silently.
    expect(UPDATE_URL).toBe("https://arlol.github.io/configurable-containers/updates.json");
  });
});
