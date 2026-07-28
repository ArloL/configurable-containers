// Build a distributable XPI. Stages extensions/cc/ into dist/cc/ and stamps the
// version THERE, so manifest.json stays a placeholder in the tracked tree and a
// local run never dirties git. Run: npx tsx scripts/package.ts [version]
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { buildExtension } from "../harness/build-extension";
import { parseConfig } from "../src/config/parse";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../extensions/cc");
const DEFAULT_SEED = path.resolve(HERE, "../src/config/default.yaml");
const DEFAULT_OUT = path.resolve(HERE, "../dist");

// A zip entry records its file's mtime, so two builds of identical content otherwise
// differ. 1980-01-01 is the earliest instant the format's DOS timestamp can express.
// zip writes that timestamp in LOCAL time, so the archive is only reproducible if the
// builder's timezone is pinned too — see TZ below. Measured: without it, a CEST machine
// and a UTC machine differ by 12 bytes, and a US machine matches UTC only because zip
// silently clamps at the 1980 floor.
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
  // zip clamps anything earlier to the DOS floor, which would silently discard the
  // value and make the build unreproducible against the timestamp actually requested.
  if (when < ZIP_EPOCH) {
    throw new Error(`BUILD_TIMESTAMP is before 1980-01-01 and zip cannot store it: ${raw}`);
  }
  return when;
}

// Staged paths relative to `dir`, files only, sorted. `zip -r .` walks in directory
// order, which is the filesystem's business and not stable across machines; passing an
// explicit sorted list fixes the entry order instead.
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

  // Reproducible archive: fixed entry order, fixed mtimes, and -X to drop the uid/gid
  // and extended-timestamp extra fields. Same inputs then give byte-identical bytes,
  // so a reviewer can checksum the .xpi instead of unpacking it to compare.
  const files = stagedFiles(stageDir);
  const mtime = zipTimestamp();
  for (const rel of files) utimesSync(path.join(stageDir, rel), mtime, mtime);
  execFileSync("zip", ["-X", "-D", "-q", xpiPath, ...files], {
    cwd: stageDir,
    env: { ...process.env, TZ: "UTC" },
  });

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
