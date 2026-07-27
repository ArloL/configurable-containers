import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { buildExtension } from "../../harness/build-extension";

describe("extension bundle", () => {
  it("bundles background.ts into a single self-contained background.js", async () => {
    const outfile = await buildExtension();
    expect(existsSync(outfile)).toBe(true);
    const code = readFileSync(outfile, "utf8");
    // non-trivial, references the browser.* API our real port uses, and is bundled
    // (no top-level ESM import survives — deps like tldts/yaml are inlined).
    expect(code.length).toBeGreaterThan(1000);
    expect(code).toContain("onBeforeRequest");
    expect(code).toContain("contextualIdentities");
    expect(code).not.toMatch(/^\s*import\s.+\sfrom\s/m);
  });
});
