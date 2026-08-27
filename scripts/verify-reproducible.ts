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

/** GitHub's maximum page size for the releases endpoint, which pages newest-first. */
export const RELEASES_PER_PAGE = 100;
/**
 * A bound so a repo with no listed release still terminates. Running INTO it is never an
 * answer — see below. 1000 releases is over half a year of this dev channel.
 */
export const MAX_RELEASE_PAGES = 10;

/**
 * The newest listed release, found by paging until one turns up.
 *
 * A fixed window cannot do this, and the window is what made this gate inert. The two
 * channels share one tag sequence and the dev channel publishes several times a day, so a
 * listed release is buried under prereleases within days of being cut: on 2026-08-25 the
 * newest listed release, v2608.0.112, was the **32nd** newest release, and the single
 * `per_page=20` request this used to make never reached it. The job printed "No listed
 * release yet" and passed — green every night while checking nothing, for the four weeks
 * since the first listed release went out.
 *
 * So `undefined` means the release list was read to its END and holds no listed release,
 * which is the one case where "nothing to reproduce" is true. Exhausting the page cap is
 * NOT that answer and throws instead: reporting an inconclusive search as a conclusive
 * "nothing to check" is exactly the failure being replaced, and a gate that cannot find
 * its subject has to say so rather than pass.
 */
export function findLatestListedRelease(
  fetchPage: (page: number) => Release[],
  maxPages: number = MAX_RELEASE_PAGES,
): Release | undefined {
  for (let page = 1; page <= maxPages; page++) {
    const releases = fetchPage(page);
    const listed = latestListedRelease(releases);
    if (listed) return listed;
    // A short page is the end of the list, which is what makes the answer below provable.
    if (releases.length < RELEASES_PER_PAGE) return undefined;
  }
  throw new Error(
    `no listed release among the newest ${maxPages * RELEASES_PER_PAGE} releases, and the ` +
      `list did not end — the page cap is too small to answer, so this is not "nothing to reproduce".`,
  );
}

/** "v2608.0.101" -> "2608.0.101", which is what the asset names and the packager use. */
export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

/**
 * The tag reaches `gh api` as a PATH SEGMENT, so what it may hold is not a matter of
 * taste: one carrying "../" or "?" addresses an endpoint other than the release this job
 * believes it is checking, and a gate that reproduced something else reports green either
 * way. Every tag this repo has cut is CalVer, so the shape is stated exactly rather than
 * as a blocklist of the characters that would escape.
 */
export function releaseTag(raw: string): string {
  if (!/^v\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`not a release tag: ${JSON.stringify(raw)} (expected v<YYMM>.<day>.<micro>)`);
  }
  return raw;
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
  // The arguments after `npm run package --`, i.e. the exact command the release notes
  // publish. A dev release rebuilds with `--dev`, because it is a different add-on: its
  // own id so it installs beside the listed one, its own storage.local, and the
  // self-distribution update_url AMO rejects on a listed submission. That difference is
  // deliberate and cannot be removed, so it is decided HERE, once, rather than by the
  // caller — and it is the only thing about the two channels this job treats differently.
  packageArgs: string[];
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
  const packageArgs = release.prerelease ? [version, "--dev"] : [version];
  return { version, buildTimestamp, xpi, source, packageArgs };
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- the part that downloads and builds ---------------------------------------------

const OWNER_REPO = "ArloL/configurable-containers";

/**
 * One release, by tag. The release-triggered workflow passes the tag the event names, so
 * that path performs NO SEARCH — which is the whole point of it: a search that silently
 * comes back empty is how this gate spent four weeks green and inert.
 */
function fetchRelease(tag: string): Release {
  const endpoint = `repos/${OWNER_REPO}/releases/tags/${releaseTag(tag)}`;
  const json = execFileSync("gh", ["api", endpoint], { encoding: "utf8" });
  return JSON.parse(json) as Release;
}

function fetchReleasePage(page: number): Release[] {
  const query = `per_page=${RELEASES_PER_PAGE}&page=${page}`;
  const json = execFileSync("gh", ["api", `repos/${OWNER_REPO}/releases?${query}`], { encoding: "utf8" });
  return JSON.parse(json) as Release[];
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function main(): void {
  // With a tag, verify exactly that release. Without one, go looking for the newest
  // listed release, which is what the nightly does — it asks a different question:
  // whether a release that reproduced when it was cut STILL reproduces on today's
  // toolchain.
  const tag = process.argv[2];
  const release = tag ? fetchRelease(tag) : findLatestListedRelease(fetchReleasePage);
  if (!release) {
    console.log("No listed release in the whole release list — nothing to reproduce.");
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
    execFileSync("npm", ["run", "package", "--", ...plan.packageArgs], {
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
