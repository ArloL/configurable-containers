import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAmoMetadata, readListingCopy, SUMMARY_LIMIT } from "../../scripts/amo-metadata";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The `- <permissions> — <why>` bullets of the notes' PERMISSIONS section, as the set of
 * names they claim to explain.
 *
 * Parsed rather than eyeballed because these notes are uploaded to AMO on every push to
 * main, so a permission added to the manifest and not to them is drift that gets
 * PUBLISHED. It throws rather than returning nothing when the section or a bullet's
 * em dash is missing: a parser that silently found no permissions would make the
 * comparison below pass over an empty set, which is the failure it exists to prevent.
 */
function explainedPermissions(notes: string): string[] {
  const lines = notes.split("\n");
  const start = lines.indexOf("PERMISSIONS");
  if (start === -1) throw new Error("amo/reviewer-notes.txt has no PERMISSIONS heading");
  // Headings in this file are bare ALL-CAPS lines; the section runs to the next one.
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[A-Z][A-Z ]+$/.test(line));
  const section = end === -1 ? rest : rest.slice(0, end);

  const bullets = section.filter((line) => line.startsWith("- "));
  if (bullets.length === 0) throw new Error("the PERMISSIONS section explains nothing");
  return bullets.flatMap((bullet) => {
    // Everything before the em dash is what the bullet is ABOUT; after it is the prose,
    // where a permission may well be named in passing without being explained.
    const [heads] = bullet.slice(2).split("—");
    if (heads === bullet.slice(2)) throw new Error(`no em dash in permission bullet: ${bullet}`);
    return heads!.split(",").map((name) => name.trim()).filter((name) => name !== "");
  });
}

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

  it("publishes the same copy on the dev add-on, where it can be read before it is public", () => {
    // The dev add-on has no public page, so this is cosmetic there — and that is the
    // point: every push to main rehearses the copy on a surface only the developer sees,
    // which is the one chance to read it before a listed release makes it public.
    const meta = buildAmoMetadata({ version: "1", timestamp: "T", channel: "unlisted", ...COPY });

    expect(meta.summary).toEqual({ "en-US": COPY.summary });
    expect(meta.description).toEqual({ "en-US": COPY.description });
  });

  it("refuses a placeholder it does not know rather than shipping the braces", () => {
    // A submit rewrites the public listing. An unsubstituted `{{…}}` would reach it as
    // literal text, and nothing downstream reads the copy again to notice.
    expect(() =>
      buildAmoMetadata({ ...COPY, version: "1", timestamp: "T", channel: "listed", reviewerNotes: "see {{buildDate}}" }),
    ).toThrow(/\{\{buildDate\}\}/);
  });

  it("refuses a summary over AMO's cap instead of having the upload rejected", () => {
    // On either channel: the dev upload runs on every push to main, so the cap has to be
    // caught there too rather than by AMO on a release day.
    expect(() =>
      buildAmoMetadata({ ...COPY, version: "1", timestamp: "T", channel: "unlisted", summary: "x".repeat(SUMMARY_LIMIT + 1) }),
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

  // What a reviewer opens this file for. `test/fitness/manifest.test.ts` pins the manifest
  // against the APIs `src/` calls, in both directions — so a permission cannot arrive
  // without a caller. Nothing pinned it against the PROSE, and two had arrived without one:
  // webNavigation (the view-source guard) and notifications (the declined-POST toast) were
  // both added after these notes were written and went unexplained for as long as it took
  // someone to read them side by side.
  //
  // An exact set, in both directions, as everywhere else here. A permission removed from
  // the manifest but still explained is the same drift facing the other way, and it is
  // worse than stale: the notes would be telling a reviewer the add-on asks for something
  // it does not.
  it("explains every permission the manifest declares, and no others", () => {
    const manifest = JSON.parse(readFileSync(root + "extensions/cc/manifest.json", "utf8")) as {
      permissions: string[];
    };
    const explained = explainedPermissions(readListingCopy().reviewerNotes);

    expect([...explained].sort()).toEqual([...manifest.permissions].sort());
  });

  // The paragraph exists so a reviewer can reproduce the checksum, so the version floor in
  // it has to be one this project actually stands behind. It said "Needs Node 22+" while CI
  // built and verified on 24 only, `package.json` declares no `engines`, and nothing
  // anywhere established that a Node 22 rebuild produces the same bytes.
  it("names the Node version CI really builds on, rather than a floor nobody tested", () => {
    const declared = new Set(
      globSync(".github/workflows/*.y*ml", { cwd: root })
        .flatMap((file) => [...readFileSync(root + file, "utf8").matchAll(/node-version:\s*(\d+)/g)])
        .map((m) => m[1]!),
    );

    // One version across every workflow: if the release build and the reproducibility
    // verifier ever disagreed, no single sentence here could be true for both.
    expect([...declared]).toHaveLength(1);
    expect(readListingCopy().reviewerNotes).toContain(`Node ${[...declared][0]}`);
  });
});
