import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { packageExtension, zipTimestamp } from "../../scripts/package";

// Decode the DOS timestamp out of the archive's first local file header (which always
// starts at offset 0): 2 bytes of time at offset 10, 2 of date at 12.
//
// Deliberately not `unzip -l`, whose date rendering is platform-specific — macOS prints
// 07-28-2026, Linux prints 2026-07-28. A test pinned to one of those passes locally and
// fails in CI, which is exactly what happened.
function firstEntryDosTimestamp(xpiPath: string): string {
  const buf = readFileSync(xpiPath);
  expect(buf.readUInt32LE(0)).toBe(0x04034b50); // PK\x03\x04, a local file header
  const time = buf.readUInt16LE(10);
  const date = buf.readUInt16LE(12);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${1980 + ((date >> 9) & 0x7f)}-${pad((date >> 5) & 0x0f)}-${pad(date & 0x1f)} ` +
    `${pad((time >> 11) & 0x1f)}:${pad((time >> 5) & 0x3f)}:${pad((time & 0x1f) * 2)}`
  );
}

describe("packageExtension", () => {
  it("stages the extension with the given version and produces an xpi", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    try {
      const { xpiPath, stageDir } = await packageExtension({ version: "2607.0.101", outDir });
      expect(existsSync(xpiPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(stageDir, "manifest.json"), "utf8"));
      expect(manifest.version).toBe("2607.0.101");
      expect(manifest.browser_specific_settings.gecko.id).toBe("configurable-containers@k5d.de");
      // addons-linter warns without this, and it will become a hard requirement.
      // "none" is the honest answer: CC transmits nothing and stores only the config.
      expect(manifest.browser_specific_settings.gecko.data_collection_permissions)
        .toEqual({ required: ["none"] });
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

  // Asserts the timestamp actually RECORDED in the archive, not that two builds match.
  // Comparing two builds is a false green: they run inside zip's two-second timestamp
  // granularity, so they agree whether or not the mtimes were normalised. Verified by
  // backing the normalisation out — the two-build version stayed green, this one fails.
  it("stamps every entry with the fixed timestamp, not the build time", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    const originalTs = process.env.BUILD_TIMESTAMP;
    try {
      process.env.BUILD_TIMESTAMP = "1785200000"; // 2026-07-28T00:53:20Z
      const { xpiPath } = await packageExtension({ version: "2607.0.104", outDir });
      expect(firstEntryDosTimestamp(xpiPath)).toBe("2026-07-28 00:53:20");
    } finally {
      if (originalTs === undefined) delete process.env.BUILD_TIMESTAMP;
      else process.env.BUILD_TIMESTAMP = originalTs;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  // zip stores entry mtimes in LOCAL time, so the builder's timezone leaks into the
  // archive. Measured before this was pinned: a CEST and a UTC build differed by 12
  // bytes, while a US build matched UTC only because zip clamps at the 1980 floor.
  it("produces the same xpi regardless of the builder's timezone", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "Europe/Berlin";
      const berlin = await packageExtension({ version: "2607.0.105", outDir });
      const a = readFileSync(berlin.xpiPath);

      process.env.TZ = "Asia/Tokyo";
      const tokyo = await packageExtension({ version: "2607.0.105", outDir });
      expect(readFileSync(tokyo.xpiPath).equals(a)).toBe(true);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("orders archive entries deterministically, not by directory order", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cc-pkg-"));
    try {
      const { xpiPath } = await packageExtension({ version: "2607.0.106", outDir });
      const names = execFileSync("unzip", ["-Z1", xpiPath], { encoding: "utf8" })
        .trim()
        .split("\n");
      expect(names).toEqual([...names].sort());
      expect(names).toContain("background.js");
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

describe("zipTimestamp", () => {
  it("defaults to the 1980 floor so a bare build needs no environment", () => {
    expect(zipTimestamp({}).toISOString()).toBe("1980-01-01T00:00:00.000Z");
    expect(zipTimestamp({ BUILD_TIMESTAMP: "  " }).toISOString()).toBe("1980-01-01T00:00:00.000Z");
  });

  it("reads BUILD_TIMESTAMP as a unix epoch in seconds", () => {
    expect(zipTimestamp({ BUILD_TIMESTAMP: "1751000000" }).getTime()).toBe(1751000000 * 1000);
  });

  it("also accepts a parsable date string", () => {
    expect(zipTimestamp({ BUILD_TIMESTAMP: "2026-07-28T12:34:56Z" }).toISOString())
      .toBe("2026-07-28T12:34:56.000Z");
  });

  it("rejects a value it cannot parse rather than silently falling back", () => {
    expect(() => zipTimestamp({ BUILD_TIMESTAMP: "yesterday" })).toThrow(/not a unix epoch/);
  });

  // zip clamps anything earlier to the DOS floor, so accepting it would mean the build
  // silently ignored the timestamp it was told to use.
  it("rejects a timestamp before 1980, which zip cannot store", () => {
    expect(() => zipTimestamp({ BUILD_TIMESTAMP: "1979-06-01T00:00:00Z" })).toThrow(/before 1980/);
    expect(() => zipTimestamp({ BUILD_TIMESTAMP: "0" })).toThrow(/before 1980/);
  });
});
