// Build and sign an UNLISTED dev build, so the extension can be installed permanently
// on release Firefox while a listed version waits in AMO's review queue.
//
// Why this exists: a listed submission is NOT signed on upload — the queued file comes
// back byte-identical to what you sent, with no META-INF — and signing happens at
// approval. Release Firefox permanently installs signed add-ons only (the
// `xpinstall.signatures.required` pref is ignored outside DevEd/Nightly/ESR), so a
// pending review means no permanent local install. The unlisted channel is signed
// automatically, in minutes, with no human in the loop.
//
// It signs under its OWN add-on id (see DEV_ID), which buys two things: the upload
// lands on a separate AMO record and cannot perturb the listed version under review,
// and the installed add-on gets its own storage.local, so it cannot clobber the real
// add-on's config if both are installed.
//
// Run: npm run sign:dev [version] [--seed=<path>]
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { packageExtension } from "./package";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "../dist/dev");
// The signed xpi web-ext downloads back lands in its OWN directory, because
// packageExtension leaves an unsigned xpi in OUT_DIR as a byproduct of staging (it is
// the staged DIRECTORY that gets signed, not that file). Sharing one directory would
// leave two similarly-named archives where only one installs.
const SIGNED_DIR = path.join(OUT_DIR, "signed");
const WEB_EXT = path.resolve(HERE, "../node_modules/.bin/web-ext");

const DEV_ID = "configurable-containers-dev@k5d.de";
const DEV_NAME = "configurable-containers (dev)";

// Where Firefox polls for a newer dev build. This URL is baked into every signed build
// and cannot be changed retroactively — a build that shipped pointing here keeps asking
// here forever — so it deliberately avoids anything mutable. GitHub Pages rather than a
// release asset, because each dev release is immutable once published and the manifest
// has to change on every merge. Firefox fetches it unauthenticated, which works only
// because this repo is public.
export const UPDATE_URL = "https://arlol.github.io/configurable-containers/updates.json";

// The version is REQUIRED rather than derived, because the dev channel's versions come
// from calver-tag-action (`YYMM.0.<micro>`, pushed as a git tag) and nothing local can
// allocate one without racing it. An earlier clock-derived default looked convenient and
// was a trap: `2607.29.2034` sorts ABOVE every `2607.0.<micro>` CI build for the rest of
// the month, so one local signing would have parked the update channel on a build that
// exists on nobody's machine but its author's.
export function resolveVersion(args: string[]): string {
  const version = args.find((a) => !a.startsWith("--"));
  if (!version) {
    throw new Error(
      "usage: npm run sign:dev -- <version> [--seed=<path>]\n" +
        "CI passes the version calver-tag-action allocated; pass one explicitly here.",
    );
  }
  return version;
}

async function main() {
  // web-ext reads WEB_EXT_API_KEY / WEB_EXT_API_SECRET from the environment itself, so
  // the credentials are never argv — which every other process on the box can read.
  for (const name of ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"]) {
    if (!process.env[name]?.trim()) {
      throw new Error(`${name} is not set; signing needs your AMO API credentials`);
    }
  }

  const args = process.argv.slice(2);
  // The seed defaults to the SHIPPED config, not the author's personal one: an unlisted
  // upload still lands on Mozilla's servers, and a personal config is a list of the
  // sites you use. Pass --seed to override it knowingly.
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const version = resolveVersion(args);

  const { stageDir } = await packageExtension({
    version,
    id: DEV_ID,
    name: DEV_NAME,
    updateUrl: UPDATE_URL,
    outDir: OUT_DIR,
    seedPath: seedArg?.slice("--seed=".length),
  });

  // Emptied first so the xpi web-ext downloads back is the ONLY one here: the update
  // manifest has to name that exact file, and picking it out of a directory that also
  // holds previous runs' builds would eventually point Firefox at a stale version.
  rmSync(SIGNED_DIR, { recursive: true, force: true });

  const res = spawnSync(
    WEB_EXT,
    [
      "sign",
      "--source-dir",
      stageDir,
      "--artifacts-dir",
      SIGNED_DIR,
      "--channel",
      "unlisted",
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) process.exit(res.status ?? 1);

  // The signed file is named by web-ext, so what it is called is its business. Recording
  // the version here means the release job can tag from a value this script decided,
  // rather than parsing it back out of a filename whose shape nothing pins.
  const signed = readdirSync(SIGNED_DIR).filter((f) => f.endsWith(".xpi"));
  if (signed.length !== 1) {
    throw new Error(`expected exactly one signed xpi in ${SIGNED_DIR}, found ${signed.length}`);
  }
  writeFileSync(
    path.join(SIGNED_DIR, "build.json"),
    JSON.stringify({ version, xpi: signed[0] }, null, 2) + "\n",
  );

  console.log(`\nSigned ${DEV_NAME} ${version} -> ${SIGNED_DIR}`);
  console.log("Install it via about:addons -> gear -> Install Add-on From File.");
}

// Guarded exactly as scripts/package.ts guards its CLI, and here it is load-bearing
// rather than tidy: this module's side effect is an UPLOAD to AMO, so an unguarded
// `main()` would sign and publish merely because a test imported devVersion.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
