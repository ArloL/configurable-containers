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

// Where Firefox polls for a newer build. This URL is baked into every signed build
// and cannot be changed — a build that shipped keeps asking here forever
export const UPDATE_URL = "https://arlol.github.io/configurable-containers/updates.json";

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

  const signed = readdirSync(SIGNED_DIR).filter((f) => f.endsWith(".xpi"));
  if (signed.length !== 1) {
    throw new Error(`expected exactly one signed xpi in ${SIGNED_DIR}, found ${signed.length}`);
  }

  console.log(`\nSigned ${DEV_NAME} ${version} -> ${SIGNED_DIR}`);
  console.log("Install it via about:addons -> gear -> Install Add-on From File.");
}

// Guarded exactly as scripts/package.ts guards its CLI, and here it is crucial:
// this module's side effect is an UPLOAD to AMO, so an unguarded
// `main()` would sign and publish merely because a test imported devVersion.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
