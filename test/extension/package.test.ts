import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { packageExtension } from "../../scripts/package";

describe("packageExtension", () => {
  it("stages the extension with the given version and produces an xpi", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    try {
      const { xpiPath, stageDir } = await packageExtension({ version: "2607.0.101", outDir });
      expect(existsSync(xpiPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(stageDir, "manifest.json"), "utf8"));
      expect(manifest.version).toBe("2607.0.101");
      expect(manifest.browser_specific_settings.gecko.id).toBe("configurable-containers@k5d.de");
      expect(existsSync(path.join(stageDir, "background.js"))).toBe(true);
      expect(existsSync(path.join(stageDir, "options.js"))).toBe(true);
      expect(existsSync(path.join(stageDir, "options.html"))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("leaves the tracked manifest untouched", async () => {
    const tracked = fileURLToPath(new URL("../../extensions/cc/manifest.json", import.meta.url));
    const before = readFileSync(tracked, "utf8");
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    try {
      await packageExtension({ version: "2607.0.102", outDir });
      expect(readFileSync(tracked, "utf8")).toBe(before);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("refuses to package a seed that does not parse", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    const badSeed = path.join(outDir, "bad.yaml");
    writeFileSync(badSeed, "rules:\n  - match: 123\n    open: Nope\n");
    try {
      await expect(
        packageExtension({ version: "2607.0.103", seedPath: badSeed, outDir }),
      ).rejects.toThrow(/bare hostname/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
