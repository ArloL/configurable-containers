import { describe, it, expect } from "vitest";
import { submitArgs } from "../../scripts/submit";

// Importing this module at all is part of what these cases pin: scripts/submit.ts uploads
// to AMO when run, so its CLI tail is guarded by the argv check.
describe("submitArgs", () => {
  it("carries the listing copy and still forwards what the workflow adds", () => {
    // release.yaml appends --upload-source-code, which AMO requires because background.js
    // is an esbuild bundle. Swallowing extra arguments here would drop it in silence.
    expect(submitArgs("meta.json", ["--upload-source-code", "src.zip"])).toEqual([
      "sign",
      "--source-dir",
      "dist/cc",
      "--artifacts-dir",
      "dist",
      "--channel",
      "listed",
      "--amo-metadata",
      "meta.json",
      "--upload-source-code",
      "src.zip",
    ]);
  });
});
