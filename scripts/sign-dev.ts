// Build and sign an unlisted dev build, so the extension can be installed permanently
// on release Firefox while a listed version waits in AMO's review queue.
//
// It signs under its OWN add-on id (see DEV_ID), which buys two things: the upload
// lands on a separate AMO record and cannot perturb the listed version under review,
// and the installed add-on gets its own storage.local, so it cannot clobber the real
// add-on's config if both are installed.
//
// Run: npm run sign:dev [version]
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { DEV_ID, DEV_NAME, DEV_UPDATE_URL, packageExtension } from "./package";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_DIR = path.resolve(HERE, "../dist/dev");
const SIGNED_DIR = path.join(OUT_DIR, "signed");
const WEB_EXT = path.resolve(HERE, "../node_modules/.bin/web-ext");

// Where Firefox polls for a newer build. This URL is baked into every signed build
// and cannot be changed — a build that shipped keeps asking here forever. Defined in
// package.ts, because `npm run package -- <version> --dev` must produce the very same
// add-on: that is what makes a dev release's published reproduce command true.
export const UPDATE_URL = DEV_UPDATE_URL;

/**
 * AMO's source requirement belongs to the REVIEWER, not to the listed channel: it is
 * triggered by shipping bundled JS (background.js is an esbuild bundle), and an unlisted
 * add-on is auto-signed but "subject to be manually reviewed at any time after
 * submission". Attaching the archive to the GitHub release satisfies none of that;
 * --upload-source-code does, and it is what release.yaml already passes on the listed
 * side.
 *
 * Built here rather than in the workflow so that no path that uploads — CI or a local
 * `npm run sign:dev` — can sign without it. The path is the one ci.yml publishes as a
 * release asset.
 */
export function buildSourceArchive(version: string, outDir: string): string {
  // git archive reads HEAD, while the xpi was just built from the working tree. A
  // reviewer rebuilds the source and diffs it against the shipped bundle, so a dirty
  // tree submits a source that cannot reproduce what was signed.
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  if (status.status !== 0) throw new Error("git status failed");
  if (status.stdout.trim() !== "") {
    console.warn("WARNING: uncommitted changes — AMO gets HEAD, not the tree this build came from.");
  }

  const archive = path.join(outDir, `configurable-containers-src-${version}.zip`);
  const res = spawnSync("git", ["archive", "--format=zip", "--output", archive, "HEAD"], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error("git archive failed");
  return archive;
}

// Pure, because the omission this guards against is silent: web-ext signs an unlisted
// build just as happily with no source attached, and AMO only says so if someone reviews.
export function signArgs(stageDir: string, artifactsDir: string, sourceArchive: string): string[] {
  return [
    "sign",
    "--source-dir",
    stageDir,
    "--artifacts-dir",
    artifactsDir,
    "--channel",
    "unlisted",
    "--upload-source-code",
    sourceArchive,
  ];
}

async function main() {
  for (const name of ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET", "VERSION"]) {
    if (!process.env[name]?.trim()) {
      throw new Error(`${name} is not set`);
    }
  }

  const version = process.env["VERSION"] ?? "";

  const { stageDir } = await packageExtension({
    version,
    id: DEV_ID,
    name: DEV_NAME,
    updateUrl: UPDATE_URL,
    outDir: OUT_DIR
  });

  const sourceArchive = buildSourceArchive(version, OUT_DIR);

  rmSync(SIGNED_DIR, { recursive: true, force: true });

  const res = spawnSync(WEB_EXT, signArgs(stageDir, SIGNED_DIR, sourceArchive), {
    stdio: "inherit",
  });
  if (res.status !== 0) process.exit(res.status ?? 1);

  const signed = readdirSync(SIGNED_DIR).filter((f) => f.endsWith(".xpi"));
  if (signed.length !== 1) {
    throw new Error(`expected exactly one signed xpi in ${SIGNED_DIR}, found ${signed.length}`);
  }

  console.log(`\nSigned ${DEV_NAME} ${version} -> ${SIGNED_DIR}`);
  console.log("Install it via about:addons -> gear -> Install Add-on From File.");
}

// Guard against accidental execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
