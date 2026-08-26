import { describe, it, expect } from "vitest";
import { buildAmoMetadata, readListingCopy, SUMMARY_LIMIT } from "../../scripts/amo-metadata";

const COPY = {
  summary: "One YAML file decides which container each site opens in.",
  description: "**What it does**\n\n- routes each site\n",
  reviewerNotes: "checkout v{{version}}\nBUILD_TIMESTAMP={{timestamp}} npm run package -- {{package_args}}\n",
};

describe("buildAmoMetadata", () => {
  it("fills the reviewer notes with the version and timestamp of this very build", () => {
    // The whole point of automating this: the notes shipped a `<version>` placeholder and
    // a "look it up in the release notes" sentence, and a reviewer who does not look it up
    // rebuilds against the wrong instant and gets a checksum that does not match.
    const meta = buildAmoMetadata({ version: "2608.0.7", timestamp: "2026-08-26T10:00:00+00:00", channel: "listed", ...COPY });

    expect(meta.version.approval_notes).toBe(
      "checkout v2608.0.7\nBUILD_TIMESTAMP=2026-08-26T10:00:00+00:00 npm run package -- 2608.0.7\n",
    );
  });

  it("tells a dev reviewer to rebuild the DEV identity", () => {
    // Rebuilding an unlisted build without --dev produces the listed id, name and no
    // update_url, so the reproduce command a reviewer is handed would fail against the
    // artefact they downloaded.
    const meta = buildAmoMetadata({ version: "2608.0.7", timestamp: "T", channel: "unlisted", ...COPY });

    expect(meta.version.approval_notes).toContain("npm run package -- 2608.0.7 --dev");
  });

  it("publishes the listing copy on the listed channel, localised as AMO wants it", () => {
    const meta = buildAmoMetadata({ version: "1", timestamp: "T", channel: "listed", ...COPY });

    expect(meta.summary).toEqual({ "en-US": COPY.summary });
    expect(meta.description).toEqual({ "en-US": COPY.description });
  });

  it("sends no listing copy on the unlisted channel", () => {
    // An unlisted add-on has no listing page. Anything sent here is either ignored or
    // rejected, and a rejection fails sign:dev on every push to main.
    const meta = buildAmoMetadata({ version: "1", timestamp: "T", channel: "unlisted", ...COPY });

    expect(meta.summary).toBeUndefined();
    expect(meta.description).toBeUndefined();
  });

  it("refuses a placeholder it does not know rather than shipping the braces", () => {
    // A submit rewrites the public listing. An unsubstituted `{{…}}` would reach it as
    // literal text, and nothing downstream reads the copy again to notice.
    expect(() =>
      buildAmoMetadata({ ...COPY, version: "1", timestamp: "T", channel: "listed", reviewerNotes: "see {{buildDate}}" }),
    ).toThrow(/\{\{buildDate\}\}/);
  });

  it("refuses a summary over AMO's cap instead of having the upload rejected", () => {
    expect(() =>
      buildAmoMetadata({ ...COPY, version: "1", timestamp: "T", channel: "listed", summary: "x".repeat(SUMMARY_LIMIT + 1) }),
    ).toThrow(/251/);
  });

  it("refuses empty copy, which is what a mis-read file looks like", () => {
    // Publishing "" would blank the live listing, and AMO keeps no history of what it said.
    expect(() =>
      buildAmoMetadata({ ...COPY, version: "1", timestamp: "T", channel: "listed", description: "  " }),
    ).toThrow(/description/);
  });
});

describe("the copy this repo actually ships", () => {
  it("builds for both channels with nothing left to fill in", () => {
    // The guard that matters: whoever edits amo/*.md next is held to the placeholder set
    // here rather than at upload time, where the only reader is AMO.
    const copy = readListingCopy();

    for (const channel of ["listed", "unlisted"] as const) {
      const meta = buildAmoMetadata({ ...copy, version: "2608.0.7", timestamp: "2026-08-26T10:00:00+00:00", channel });
      expect(JSON.stringify(meta)).not.toContain("{{");
    }
  });

  it("keeps the summary inside the cap", () => {
    expect(readListingCopy().summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  });
});
