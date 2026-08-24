// Rebuild the last listed release from its own source archive and check the bytes match.
// (`npm run verify:reproducible`, nightly.)
//
// The release notes promise this: every release body says "Reproduce this build:" and
// gives the two commands. Until now nothing ever ran them. A promise about bytes that
// nobody re-checks is worth what any untested assertion is worth — and the thing it
// asserts is the one a reviewer or a suspicious user would lean on, since AMO REPACKS
// uploads and its copy is never byte-comparable with a local rebuild (sorted entries and
// a fixed 1980 mtime here, filesystem order and real mtimes there). The GitHub release
// asset is the only copy that can be compared at all.
//
// It runs against the LISTED channel only. Dev builds are signed by AMO on the way out, so
// their xpi carries a META-INF/ this can never reproduce.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  prerelease: boolean;
  draft?: boolean;
  body?: string;
  assets: ReleaseAsset[];
}

/**
 * The newest release of the LISTED channel. Both channels share one tag sequence and are
 * told apart by the prerelease flag, never by the tag (scripts/dev-updates.js filters the
 * same field the other way round) — so a tag-prefix test here would match everything and
 * try to reproduce a signed dev xpi.
 */
export function latestListedRelease(releases: Release[]): Release | undefined {
  return releases.filter((r) => !r.prerelease && !r.draft)[0];
}

/** "v2608.0.101" -> "2608.0.101", which is what the asset names and the packager use. */
export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

/**
 * The timestamp the release was built with, out of the notes release.yaml writes. Nobody
 * can derive it — a zip records mtimes and the source archive has no .git to read one
 * from — so it is published in the body and this is the only place it comes from.
 */
export function buildTimestampFrom(body: string | undefined): string | undefined {
  return /BUILD_TIMESTAMP=(\S+)/.exec(body ?? "")?.[1];
}

export function assetNamed(release: Release, name: string): ReleaseAsset | undefined {
  return release.assets.find((a) => a.name === name);
}

export interface Plan {
  version: string;
  buildTimestamp: string;
  xpi: ReleaseAsset;
  source: ReleaseAsset;
}

/** Everything the rebuild needs, or the reason it cannot be attempted. */
export function planFor(release: Release): Plan | { problem: string } {
  const version = versionFromTag(release.tag_name);
  const buildTimestamp = buildTimestampFrom(release.body);
  if (buildTimestamp === undefined) {
    return { problem: `release ${release.tag_name} publishes no BUILD_TIMESTAMP in its notes` };
  }
  const xpi = assetNamed(release, `configurable-containers-${version}.xpi`);
  const source = assetNamed(release, `configurable-containers-src-${version}.zip`);
  if (!xpi) return { problem: `release ${release.tag_name} has no configurable-containers-${version}.xpi` };
  // AMO requires reviewable source whenever the shipped JS is bundled, so its absence is a
  // release that should not have gone out rather than a case to skip.
  if (!source) return { problem: `release ${release.tag_name} has no source archive to rebuild from` };
  return { version, buildTimestamp, xpi, source };
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- the part that downloads and builds ---------------------------------------------

const OWNER_REPO = "ArloL/configurable-containers";

function fetchReleases(): Release[] {
  const json = execFileSync("gh", ["api", `repos/${OWNER_REPO}/releases?per_page=20`], { encoding: "utf8" });
  return JSON.parse(json) as Release[];
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function main(): void {
  const release = latestListedRelease(fetchReleases());
  if (!release) {
    console.log("No listed release yet — nothing to reproduce.");
    return;
  }
  const plan = planFor(release);
  if ("problem" in plan) throw new Error(plan.problem);

  console.log(`Reproducing ${release.tag_name} (BUILD_TIMESTAMP=${plan.buildTimestamp})`);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-repro-"));
  try {
    run("curl", ["-fsSL", "-o", path.join(dir, "released.xpi"), plan.xpi.browser_download_url], dir);
    run("curl", ["-fsSL", "-o", path.join(dir, "source.zip"), plan.source.browser_download_url], dir);
    run("unzip", ["-q", "source.zip", "-d", "source"], dir);

    const source = path.join(dir, "source");
    run("npm", ["ci"], source);
    // The exact command the release notes tell a reader to run.
    execFileSync("npm", ["run", "package", "--", plan.version], {
      cwd: source,
      stdio: "inherit",
      env: { ...process.env, BUILD_TIMESTAMP: plan.buildTimestamp },
    });

    const rebuilt = sha256(readFileSync(path.join(source, "dist", `configurable-containers-${plan.version}.xpi`)));
    const released = sha256(readFileSync(path.join(dir, "released.xpi")));
    console.log(`released: ${released}\nrebuilt:  ${rebuilt}`);
    if (rebuilt !== released) {
      throw new Error(
        `${release.tag_name} does not reproduce: the xpi rebuilt from its own source archive ` +
          `has a different sha256 from the one published beside it.`,
      );
    }
    console.log(`${release.tag_name} reproduces byte for byte.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
