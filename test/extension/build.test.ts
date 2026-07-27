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

  it("injects the grace constant and bundles the disposer", async () => {
    const outfile = await buildExtension({ graceMs: 1234 });
    const code = readFileSync(outfile, "utf8");
    expect(code).toContain("1234"); // __CC_GRACE_MS__ substituted
    expect(code).toContain("removeIdentity"); // disposer wired in
  });

  it("defaults the grace to 300000 when unspecified", async () => {
    const outfile = await buildExtension();
    // esbuild prints 300000 in its shortest form (3e5); accept either.
    expect(readFileSync(outfile, "utf8")).toMatch(/graceMs:\s*(300000|3e5)\b/);
  });
});
