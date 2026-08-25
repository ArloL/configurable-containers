import { describe, it, expect } from "vitest";
import { UPDATE_URL, signArgs } from "../../scripts/sign-dev";

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

describe("signArgs", () => {
  it("hands AMO the source archive alongside the unlisted upload", () => {
    // AMO wants readable source because background.js is an esbuild bundle, and it wants
    // it from the UPLOAD — the copy attached to the GitHub release is invisible to
    // reviewers. web-ext signs happily without it and an unlisted version is auto-signed
    // either way, so the omission would only surface as a manual review going against a
    // dev add-on that had already shipped.
    expect(signArgs("stage", "signed", "src.zip")).toEqual([
      "sign",
      "--source-dir",
      "stage",
      "--artifacts-dir",
      "signed",
      "--channel",
      "unlisted",
      "--upload-source-code",
      "src.zip",
    ]);
  });
});
