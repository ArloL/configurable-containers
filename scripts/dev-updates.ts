// Build the Firefox update manifest ("updates.json") for the unlisted dev channel from
// this repo's dev releases, and write it to a directory GitHub Pages then publishes.
//
// The manifest has to change on every merge while each dev release stays immutable, so
// the two live in different places: the xpi on a per-version release that is never
// touched again, the manifest on Pages at the constant URL every signed build carries
// (UPDATE_URL in scripts/sign-dev.ts).
//
// Run: gh api repos/{owner}/{repo}/releases --paginate | tsx scripts/dev-updates.ts <outdir>
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

export const DEV_ID = "configurable-containers-dev@k5d.de";

export interface Release {
  tag_name: string;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

// Every dev release is listed, not just the newest: Firefox picks the highest version
// it can install, so a bad build is rolled back by DELETING its release and
// republishing this manifest — which is the only rollback available when the releases
// themselves are immutable.
export function updatesManifest(releases: Release[]): string {
  const updates = releases
    // Dev builds and listed releases share ONE tag sequence, because both are versioned
    // by calver-tag-action — there is no `dev-` prefix to filter on. The prerelease flag
    // is the discriminator: release.yaml publishes the listed build as a full release,
    // and offering that file here would push the LISTED add-on's xpi to dev users under
    // the dev add-on's id.
    .filter((r) => r.prerelease)
    .flatMap((r) => {
      // Taken from the asset's own download url rather than composed from the tag, so
      // renaming what gets uploaded cannot silently produce a manifest full of 404s.
      const xpi = r.assets.find((a) => a.name.endsWith(".xpi"));
      // A release whose upload step failed has no xpi. Skipping it keeps the manifest
      // servable; offering a link that 404s would stall the update check instead.
      if (!xpi) return [];
      // calver-tag-action pushes `v<version>` and reports `<version>`; the manifest
      // needs the latter, since it is compared against the installed add-on's version.
      return [{
        version: r.tag_name.replace(/^v/, ""),
        update_link: xpi.browser_download_url,
      }];
    });

  return JSON.stringify({ addons: { [DEV_ID]: { updates } } }, null, 2) + "\n";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("usage: dev-updates.ts <outdir>  (releases JSON on stdin)");

  const releases = JSON.parse(await readStdin()) as Release[];
  const manifest = updatesManifest(releases);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "updates.json"), manifest);
  console.log(manifest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
