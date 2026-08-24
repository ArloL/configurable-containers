// Build a distributable XPI. Stages extensions/cc/ into dist/cc/ and stamps the version
// THERE, so the tracked manifest.json stays a placeholder and a local run never dirties git.
// Run: npx tsx scripts/package.ts [version]
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { zipSync } from "fflate";
import { buildExtension } from "../harness/build-extension";
import { parseConfig } from "../src/config/parse";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../extensions/cc");
const DEFAULT_SEED = path.resolve(HERE, "../src/config/default.yaml");
const DEFAULT_OUT = path.resolve(HERE, "../dist");

// A zip entry records an mtime, so two builds of identical content otherwise differ.
// 1980-01-01 is the earliest instant the format's DOS timestamp can express.
//
// fflate rather than the system `zip` buys three things: a deflate implementation pinned by
// package-lock.json instead of whatever zlib the builder has, explicit entry order and
// mtimes instead of the filesystem's, and no dependency on a `zip` binary.
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

// Reproducibility needs the entry timestamp FIXED, not any particular value, so the default
// is the floor above and a bare `npm run package` needs no environment. BUILD_TIMESTAMP
// overrides it for builds wanting a real date — unix seconds (the SOURCE_DATE_EPOCH
// convention) or anything Date parses. Reproducing such a build means passing it back.
export function zipTimestamp(env: NodeJS.ProcessEnv = process.env): Date {
  const raw = env.BUILD_TIMESTAMP?.trim();
  if (!raw) return ZIP_EPOCH;

  const when = /^\d+$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(raw);
  if (Number.isNaN(when.getTime())) {
    throw new Error(`BUILD_TIMESTAMP is not a unix epoch or a parsable date: ${raw}`);
  }
  // The DOS timestamp counts years from 1980; an earlier value would wrap rather than
  // round-trip, so reject it.
  if (when < ZIP_EPOCH) {
    throw new Error(`BUILD_TIMESTAMP is before 1980-01-01 and a zip cannot store it: ${raw}`);
  }
  return when;
}

// A zip's DOS timestamp has no timezone, and fflate fills it with LOCAL getters. Passing a
// UTC instant straight through bakes the builder's timezone into the archive — measured,
// Berlin, Tokyo and UTC each produced a different file. This returns the instant whose LOCAL
// components spell `utc`'s UTC components, so every machine writes the same bytes.
export function asDosLocal(utc: Date): Date {
  const once = new Date(utc.getTime() + utc.getTimezoneOffset() * 60_000);
  // The shift can cross a DST boundary and change the offset; re-derive from the shifted
  // instant so the components still land where intended.
  return new Date(utc.getTime() + once.getTimezoneOffset() * 60_000);
}

// Staged paths relative to `dir`, files only, sorted: directory order is the filesystem's
// business and not stable across machines.
function stagedFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? stagedFiles(path.join(dir, e.name), `${prefix}${e.name}/`)
        : [`${prefix}${e.name}`],
    )
    .sort();
}

export interface PackageOptions {
  version: string;
  seedPath?: string;
  outDir?: string;
  // A dev build overrides both, becoming a SEPARATE add-on with its own AMO record (so it
  // cannot perturb a listed version under review) and its own storage.local (so installing it
  // beside the real one cannot touch that config). A release build passes neither.
  id?: string;
  name?: string;
  // Self-distribution: where Firefox polls for a newer build. Stamped BEFORE signing,
  // because it lives inside the signed manifest — a build shipped without it can never learn
  // about its successors. Dev builds only: AMO REJECTS a listed submission carrying one.
  updateUrl?: string;
}

export async function packageExtension(
  opts: PackageOptions,
): Promise<{ xpiPath: string; stageDir: string }> {
  const seedPath = opts.seedPath ?? DEFAULT_SEED;
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const configYaml = readFileSync(seedPath, "utf8");

  // Fail before building: a seed that does not parse makes every fresh install
  // temporary-only, reported by nothing but a swallowed console.error. Here and not in
  // buildExtension, because the options e2e builds a broken seed on purpose.
  parseConfig(configYaml);

  await buildExtension({ configYaml });

  const stageDir = path.join(outDir, "cc");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(SRC_DIR, stageDir, { recursive: true });

  const manifestPath = path.join(stageDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = opts.version;
  if (opts.name) manifest.name = opts.name;
  if (opts.id || opts.updateUrl) {
    const settings = manifest.browser_specific_settings as { gecko: Record<string, unknown> };
    if (opts.id) settings.gecko.id = opts.id;
    if (opts.updateUrl) settings.gecko.update_url = opts.updateUrl;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const xpiPath = path.join(outDir, `configurable-containers-${opts.version}.xpi`);
  rmSync(xpiPath, { force: true });

  // Reproducible archive: sorted entries, one explicit mtime. Same inputs give byte-identical
  // output, so a reviewer can checksum the .xpi instead of unpacking it.
  const mtime = asDosLocal(zipTimestamp());
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const rel of stagedFiles(stageDir)) {
    entries[rel] = [readFileSync(path.join(stageDir, rel)), { mtime }];
  }
  writeFileSync(xpiPath, zipSync(entries, { level: 9 }));

  return { xpiPath, stageDir };
}

// CLI: `npx tsx scripts/package.ts 2607.0.101`. Defaults to 0.0.0 for local builds, which are
// never submitted — real versions come from the CalVer tag in CI. Guarded against accidental
// execution.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const version = process.argv[2] ?? process.env.CC_VERSION ?? "0.0.0";
  packageExtension({ version })
    .then(({ xpiPath }) => console.log(xpiPath))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
