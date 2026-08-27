// The release-picking and notes-parsing behind `npm run verify:reproducible`.
//
// The download-and-rebuild half needs a published release and ten minutes, so it lives in
// the nightly job. What is testable here is every way the job can pick the wrong thing to
// reproduce — and picking wrong is the failure that matters, because reproducing the wrong
// release either passes vacuously or reports a mismatch that is not one.
import { describe, it, expect } from "vitest";
import {
  RELEASES_PER_PAGE,
  buildTimestampFrom,
  findLatestListedRelease,
  latestListedRelease,
  planFor,
  releaseTag,
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

// Finding the release at all, which is where this gate spent four weeks green and inert.
// `latestListedRelease` above was always right about the list it was handed; the list was
// the newest twenty releases, and the dev channel fills twenty in under a week.
describe("paging to the newest listed release", () => {
  const devPage = (n: number) =>
    Array.from({ length: n }, (_, i) => release(`v2608.0.${900 - i}`, { prerelease: true }));

  // The measured shape on 2026-08-25: v2608.0.112 was the 32nd newest release, behind 31
  // dev builds, and a single per_page=20 request answered "no listed release yet".
  it("finds a listed release buried under a full page of dev builds", () => {
    const asked: number[] = [];
    const found = findLatestListedRelease((page) => {
      asked.push(page);
      return page === 1 ? devPage(RELEASES_PER_PAGE) : [...devPage(3), release("v2608.0.112")];
    });

    expect(found?.tag_name).toBe("v2608.0.112");
    expect(asked).toEqual([1, 2]);
  });

  it("asks for one page only when that page already holds a listed release", () => {
    const asked: number[] = [];
    const found = findLatestListedRelease((page) => {
      asked.push(page);
      return [...devPage(5), release("v2608.0.112")];
    });

    expect(found?.tag_name).toBe("v2608.0.112");
    expect(asked).toEqual([1]);
  });

  // The one case where "nothing to reproduce" is TRUE: the list ended, and it held no
  // listed release. A short page is what proves the end was reached.
  it("answers with nothing once the release list has ended", () => {
    expect(findLatestListedRelease(() => devPage(7))).toBeUndefined();
    expect(findLatestListedRelease(() => [])).toBeUndefined();
  });

  // The whole point of the rewrite. A search that ran out of pages has not answered the
  // question, and passing the job on it is how a gate goes green while checking nothing.
  it("throws rather than reporting a search that ran out of pages as nothing to reproduce", () => {
    let asked = 0;
    expect(() =>
      findLatestListedRelease(() => {
        asked += 1;
        return devPage(RELEASES_PER_PAGE);
      }, 3),
    ).toThrow(/page cap is too small/);
    expect(asked).toBe(3);
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
      packageArgs: ["2608.0.101"],
    });
  });

  // The one thing the two channels do differently, and it is not incidental: a dev build
  // is a SEPARATE add-on — its own id so it installs beside the listed one, its own
  // storage.local, and the self-distribution update_url AMO rejects on a listed
  // submission. Rebuilding a prerelease without --dev produces the listed identity and a
  // hash that cannot match, which would read as "this release does not reproduce".
  it("rebuilds a prerelease as the dev add-on", () => {
    const plan = planFor(release("v2608.0.144", { prerelease: true }));
    expect(plan).toMatchObject({ packageArgs: ["2608.0.144", "--dev"] });
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

describe("the tag the job is told to reproduce", () => {
  it("takes a release tag as it is cut", () => {
    expect(releaseTag("v2608.0.101")).toBe("v2608.0.101");
    expect(releaseTag("v2608.27.1430")).toBe("v2608.27.1430");
  });

  // The tag becomes a path segment in `gh api`, so anything that can leave that segment
  // fetches a different release — or a different endpoint — and the job then reports on
  // whatever came back as though it were the release it was asked about.
  it.each(["v2608.0.101/../../../user", "v2608.0.101?per_page=1", "../releases", "2608.0.101", ""])(
    "refuses %j, which does not address the release it names",
    (raw) => {
      expect(() => releaseTag(raw)).toThrow(/not a release tag/);
    },
  );
});
