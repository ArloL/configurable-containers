// Build a distributable XPI. Stages extensions/cc/ into dist/cc/ and stamps the
// version THERE, so manifest.json stays a placeholder in the tracked tree and a
// local run never dirties git. Run: npx tsx scripts/package.ts [version]
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
// The archive is built with fflate rather than the system `zip`, which buys three
// things: the deflate implementation is pinned by package-lock.json instead of being
// whatever zlib the builder happens to have, entry order and mtimes are set explicitly
// rather than inherited from the filesystem, and there is no dependency on a `zip`
// binary being installed at all.
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

// Reproducibility needs the entry timestamp to be FIXED, not to be any particular
// value, so the default is the floor above and a bare `npm run package` needs no
// environment at all. BUILD_TIMESTAMP overrides it for builds that want a meaningful
// date — a unix epoch in seconds (the SOURCE_DATE_EPOCH convention) or anything
// Date can parse. Anyone reproducing such a build must pass the same value back.
export function zipTimestamp(env: NodeJS.ProcessEnv = process.env): Date {
  const raw = env.BUILD_TIMESTAMP?.trim();
  if (!raw) return ZIP_EPOCH;

  const when = /^\d+$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(raw);
  if (Number.isNaN(when.getTime())) {
    throw new Error(`BUILD_TIMESTAMP is not a unix epoch or a parsable date: ${raw}`);
  }
  // The DOS timestamp counts years from 1980 and cannot represent anything earlier;
  // an earlier value would wrap rather than round-trip, so reject it outright.
  if (when < ZIP_EPOCH) {
    throw new Error(`BUILD_TIMESTAMP is before 1980-01-01 and a zip cannot store it: ${raw}`);
  }
  return when;
}

// A zip's DOS timestamp has no timezone, and fflate fills it with LOCAL getters
// (getFullYear/getHours/… — see fflate's zip writer). Passing a UTC instant straight
// through would therefore bake the builder's timezone into the archive: measured,
// Berlin, Tokyo and UTC each produced a different file. This returns the instant whose
// LOCAL components spell `utc`'s UTC components, so every machine writes the same bytes.
export function asDosLocal(utc: Date): Date {
  const once = new Date(utc.getTime() + utc.getTimezoneOffset() * 60_000);
  // The shift can itself cross a DST boundary and change the offset; re-derive from the
  // shifted instant so the components still land where intended.
  return new Date(utc.getTime() + once.getTimezoneOffset() * 60_000);
}

// Staged paths relative to `dir`, files only, sorted. Directory order is the
// filesystem's business and not stable across machines; sorting fixes entry order.
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
}

export async function packageExtension(
  opts: PackageOptions,
): Promise<{ xpiPath: string; stageDir: string }> {
  const seedPath = opts.seedPath ?? DEFAULT_SEED;
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const configYaml = readFileSync(seedPath, "utf8");

  // Fail before building: a seed that does not parse would make every fresh install
  // temporary-only, and the user would only see a swallowed console.error. This check
  // belongs HERE, not in buildExtension — the options e2e needs to build a broken seed
  // on purpose.
  parseConfig(configYaml);

  await buildExtension({ configYaml });

  const stageDir = path.join(outDir, "cc");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(SRC_DIR, stageDir, { recursive: true });

  const manifestPath = path.join(stageDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = opts.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const xpiPath = path.join(outDir, `configurable-containers-${opts.version}.xpi`);
  rmSync(xpiPath, { force: true });

  // Reproducible archive: entries added in sorted order, every one carrying the same
  // explicit mtime. Same inputs give byte-identical output, so a reviewer can checksum
  // the .xpi instead of unpacking it to compare.
  const mtime = asDosLocal(zipTimestamp());
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const rel of stagedFiles(stageDir)) {
    entries[rel] = [readFileSync(path.join(stageDir, rel)), { mtime }];
  }
  writeFileSync(xpiPath, zipSync(entries, { level: 9 }));

  return { xpiPath, stageDir };
}

// CLI: `npx tsx scripts/package.ts 2607.0.101`. Defaults to 0.0.0 for local builds,
// which are never submitted — real versions come from the CalVer tag in CI.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const version = process.argv[2] ?? process.env.CC_VERSION ?? "0.0.0";
  packageExtension({ version })
    .then(({ xpiPath }) => console.log(xpiPath))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
