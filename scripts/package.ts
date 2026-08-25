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

// Sorted, because directory order is the filesystem's business and not stable across
// machines.
function stagedFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? stagedFiles(path.join(dir, e.name), `${prefix}${e.name}/`)
        : [`${prefix}${e.name}`],
    )
    .sort();
}

// The dev channel's identity, here rather than in sign-dev.ts because BOTH the signing
// script and this file's CLI need it: a dev release publishes the pre-signing xpi so the
// channel is verifiable, and that artefact is only reproducible if a reader can rebuild
// the same add-on. `sign-dev.ts` re-exports UPDATE_URL, which is what the tests import.
export const DEV_ID = "configurable-containers-dev@k5d.de";
export const DEV_NAME = "Configurable Containers Dev";
export const DEV_UPDATE_URL = "https://arlol.github.io/configurable-containers/updates.json";

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

  // Same inputs give byte-identical output, so a reviewer can checksum the .xpi instead of
  // unpacking it to compare.
  const mtime = asDosLocal(zipTimestamp());
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const rel of stagedFiles(stageDir)) {
    entries[rel] = [readFileSync(path.join(stageDir, rel)), { mtime }];
  }
  writeFileSync(xpiPath, zipSync(entries, { level: 9 }));

  return { xpiPath, stageDir };
}

/**
 * The CLI's arguments, as options — pure, because this is the half that can be wrong.
 *
 * `--dev` builds the DEV add-on: its own id, its own name and the self-distribution
 * update_url. Without it a dev release's published "Reproduce this build" command would
 * rebuild the LISTED identity and never match the xpi attached beside it — the notes would
 * make a promise the artefact cannot keep, which is the exact failure the reproducibility
 * gate exists to catch.
 *
 * 0.0.0 by default: local builds are never submitted, and real versions come from the
 * CalVer tag in CI.
 */
export function packageOptionsFromArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PackageOptions {
  const args = argv.filter((a) => a !== "--dev");
  const version = args[0] ?? env.CC_VERSION ?? "0.0.0";
  if (argv.length === args.length) return { version };
  return { version, id: DEV_ID, name: DEV_NAME, updateUrl: DEV_UPDATE_URL };
}

// The argv guard keeps an import from packaging anything.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  packageExtension(packageOptionsFromArgv(process.argv.slice(2)))
    .then(({ xpiPath }) => console.log(xpiPath))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
