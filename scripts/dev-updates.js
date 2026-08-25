// Build the Firefox update manifest ("updates.json") for the unlisted dev channel from
// this repo's prereleases
//
// Run: node scripts/dev-updates.js
// (writes to _site/ by default)
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

export const DEV_ID = "configurable-containers-dev@k5d.de";

const OWNER_REPO = "ArloL/configurable-containers";

function fetchReleases() {
  const json = execSync(
    `gh api "repos/${OWNER_REPO}/releases?per_page=100" --paginate --slurp`,
    { encoding: "utf8" },
  );
  // --paginate --slurp outputs an array of page arrays; flatten once
  return JSON.parse(json).flat();
}

/**
 * The signed xpi off a dev release — the only one Firefox can install.
 *
 * A dev release also carries the REPRODUCIBLE pre-signing build, published so this
 * channel can be verified exactly like the listed one. Firefox refuses to install an
 * unsigned xpi permanently, so offering that one would stall every dogfooder's update
 * check — silently, and forever, the releases being immutable. The old rule was
 * `.find(a => a.name.endsWith(".xpi"))`, which took whichever GitHub happened to list
 * first.
 *
 * Chosen by EXCLUDING the reproducible build, whose name this repo controls
 * (`configurable-containers-<version>.xpi`, from scripts/package.ts), rather than by
 * matching the signed one — web-ext derives that name from the manifest
 * (`configurable_containers_dev-<version>.xpi`) and the case below pins that we never
 * compose it. Releases published before this carry one xpi and are unaffected.
 */
export function signedXpi(release) {
  const reproducible = `configurable-containers-${release.tag_name.replace(/^v/, "")}.xpi`;
  const signed = release.assets.filter((a) => a.name.endsWith(".xpi") && a.name !== reproducible);
  // Never a guess: none means signing failed, more than one means something new is
  // attached and which build Firefox should install is no longer knowable here.
  return signed.length === 1 ? signed[0] : undefined;
}

// Every dev release is listed: Firefox picks the highest version it can install
// rollbacks are done by deleting the release and republishing the manifest
export function updatesManifest(releases) {
  const updates = releases
    // Dev builds are identified by the prerelease flag
    .filter((r) => r.prerelease)
    .flatMap((r) => {
      const xpi = signedXpi(r);
      // A release whose signing or upload step failed has no signed xpi. Skipping it
      // keeps the manifest servable; offering a link that 404s would stall the update
      // check instead.
      if (!xpi) return [];
      // manifest has only version so we strip the leading v
      return [{
        version: r.tag_name.replace(/^v/, ""),
        update_link: xpi.browser_download_url,
      }];
    });

  return JSON.stringify({ addons: { [DEV_ID]: { updates } } }, null, 2) + "\n";
}

function main() {
  const outDir = process.argv[2] ?? "_site";

  const releases = fetchReleases();
  const manifest = updatesManifest(releases);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "updates.json"), manifest);
  console.log(manifest);
}

// Guard against accidental execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
