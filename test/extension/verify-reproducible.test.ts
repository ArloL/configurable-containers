// The release-picking and notes-parsing behind `npm run verify:reproducible`.
//
// The download-and-rebuild half needs a published release and ten minutes, so it lives in
// the nightly job. What is testable here is every way the job can pick the wrong thing to
// reproduce — and picking wrong is the failure that matters, because reproducing the wrong
// release either passes vacuously or reports a mismatch that is not one.
import { describe, it, expect } from "vitest";
import {
  buildTimestampFrom,
  latestListedRelease,
  planFor,
  versionFromTag,
  type Release,
} from "../../scripts/verify-reproducible";

const NOTES = (version: string, stamp: string) =>
  `Reproduce this build:\n\`\`\`\nnpm ci\nBUILD_TIMESTAMP=${stamp} npm run package -- ${version}\n\`\`\`\n\n## What's Changed\n* a thing`;

const release = (tag: string, opts: Partial<Release> = {}): Release => {
  const version = tag.replace(/^v/, "");
  return {
    tag_name: tag,
    prerelease: false,
    body: NOTES(version, "2026-08-24T13:14:15+00:00"),
    assets: [
      { name: `configurable-containers-${version}.xpi`, browser_download_url: `https://example/${version}.xpi` },
      { name: `configurable-containers-src-${version}.zip`, browser_download_url: `https://example/${version}.zip` },
    ],
    ...opts,
  };
};

describe("choosing the release to reproduce", () => {
  it("takes the newest listed release", () => {
    const releases = [release("v2608.0.103"), release("v2608.0.101")];
    expect(latestListedRelease(releases)?.tag_name).toBe("v2608.0.103");
  });

  // Both channels share ONE tag sequence and are told apart by this flag, never by the
  // tag. A dev xpi is signed by AMO on the way out, so it carries a META-INF/ no local
  // rebuild can ever produce — reproducing one would report a mismatch that is not one.
  it("skips dev builds, which are the prereleases on the same tag sequence", () => {
    const releases = [release("v2608.0.104", { prerelease: true }), release("v2608.0.103")];
    expect(latestListedRelease(releases)?.tag_name).toBe("v2608.0.103");
  });

  it("skips a draft, which has no published assets to compare against", () => {
    const releases = [release("v2608.0.104", { draft: true }), release("v2608.0.103")];
    expect(latestListedRelease(releases)?.tag_name).toBe("v2608.0.103");
  });

  it("answers with nothing when only dev builds exist", () => {
    expect(latestListedRelease([release("v2608.0.104", { prerelease: true })])).toBeUndefined();
  });
});

describe("reading what the release says about itself", () => {
  it("strips the tag's v to get the version the assets and the packager use", () => {
    expect(versionFromTag("v2608.0.101")).toBe("2608.0.101");
    expect(versionFromTag("2608.0.101")).toBe("2608.0.101");
  });

  it("finds the build timestamp inside the notes", () => {
    // Nobody can derive it: a zip records mtimes, and the source archive has no .git to
    // read one from. Published in the body is the only place it exists.
    expect(buildTimestampFrom(NOTES("2608.0.101", "2026-08-24T13:14:15+00:00"))).toBe("2026-08-24T13:14:15+00:00");
  });

  it("finds no timestamp in notes that do not carry one", () => {
    expect(buildTimestampFrom("## What's Changed\n* a thing")).toBeUndefined();
    expect(buildTimestampFrom(undefined)).toBeUndefined();
  });
});

describe("what the job refuses to attempt", () => {
  it("plans a rebuild from a complete release", () => {
    expect(planFor(release("v2608.0.101"))).toEqual({
      version: "2608.0.101",
      buildTimestamp: "2026-08-24T13:14:15+00:00",
      xpi: expect.objectContaining({ name: "configurable-containers-2608.0.101.xpi" }),
      source: expect.objectContaining({ name: "configurable-containers-src-2608.0.101.zip" }),
    });
  });

  // Each of these is reported rather than skipped. A release that cannot be reproduced is
  // a release whose notes make a promise it cannot keep, which is the thing being checked.
  it("refuses a release whose notes publish no timestamp", () => {
    expect(planFor(release("v2608.0.101", { body: "## What's Changed" }))).toEqual({
      problem: "release v2608.0.101 publishes no BUILD_TIMESTAMP in its notes",
    });
  });

  it("refuses a release with no xpi attached", () => {
    const r = release("v2608.0.101");
    r.assets = r.assets.filter((a) => !a.name.endsWith(".xpi"));
    expect(planFor(r)).toEqual({ problem: "release v2608.0.101 has no configurable-containers-2608.0.101.xpi" });
  });

  it("refuses a release with no source archive, which AMO requires anyway", () => {
    const r = release("v2608.0.101");
    r.assets = r.assets.filter((a) => !a.name.endsWith(".zip"));
    expect(planFor(r)).toEqual({ problem: "release v2608.0.101 has no source archive to rebuild from" });
  });

  it("does not mistake the source archive for the xpi, or either for the other version's", () => {
    const r = release("v2608.0.101");
    r.assets.push({ name: "configurable-containers-2608.0.999.xpi", browser_download_url: "https://example/other" });
    const plan = planFor(r);
    expect("problem" in plan).toBe(false);
    expect((plan as { xpi: { name: string } }).xpi.name).toBe("configurable-containers-2608.0.101.xpi");
  });
});
