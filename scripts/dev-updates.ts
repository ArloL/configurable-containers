// Build the Firefox update manifest ("updates.json") for the unlisted dev channel from
// this repo's prereleases
//
// Run: npx tsx scripts/dev-updates.ts
// (writes to _site/ by default)
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

export const DEV_ID = "configurable-containers-dev@k5d.de";

export interface Release {
  tag_name: string;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

// Every dev release is listed: Firefox picks the highest version it can install
// rollbacks are done by deleting the release and republishing the manifest
export function updatesManifest(releases: Release[]): string {
  const updates = releases
    // Dev builds are identified by the prerelease flag
    .filter((r) => r.prerelease)
    .flatMap((r) => {
      // find the uploaded extension xpi
      const xpi = r.assets.find((a) => a.name.endsWith(".xpi"));
      // A release whose upload step failed has no xpi. Skipping it keeps the manifest
      // servable; offering a link that 404s would stall the update check instead.
      if (!xpi) return [];
      // manifest has only version so we strip the leading v
      return [{
        version: r.tag_name.replace(/^v/, ""),
        update_link: xpi.browser_download_url,
      }];
    });

  return JSON.stringify({ addons: { [DEV_ID]: { updates } } }, null, 2) + "\n";
}

const OWNER_REPO = "ArloL/configurable-containers";

function fetchReleases(): Release[] {
  const json = execSync(
    `gh api "repos/${OWNER_REPO}/releases?per_page=100" --paginate --slurp`,
    { encoding: "utf8" },
  );
  // --paginate --slurp outputs an array of page arrays; flatten once
  return (JSON.parse(json) as Release[][]).flat();
}

function main() {
  const outDir = process.argv[2] ?? "_site";

  const releases = fetchReleases();
  const manifest = updatesManifest(releases);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "updates.json"), manifest);
  console.log(manifest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
