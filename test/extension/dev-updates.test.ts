import { describe, it, expect } from "vitest";
import { outputDir, updatesManifest } from "../../scripts/dev-updates.js";

interface Release {
  tag_name: string;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/ArloL/configurable-containers/releases/download/x/${name}`,
});

const dev = (tag: string, assets = [asset(`cc_dev-${tag.replace(/^v/, "")}.xpi`)]): Release =>
  ({ tag_name: tag, prerelease: true, assets });

const updatesIn = (json: string) =>
  JSON.parse(json).addons["configurable-containers-dev@k5d.de"].updates as
    { version: string; update_link: string }[];

describe("updatesManifest", () => {
  it("offers every dev release, so deleting one rolls the channel back", () => {
    // The releases are immutable once published — GitHub enforces it on this repo — so
    // the manifest is the only lever: Firefox installs the highest version it is
    // offered, and a build is withdrawn by dropping its release and republishing this.
    const updates = updatesIn(updatesManifest([dev("v2607.0.104"), dev("v2607.0.106")]));
    expect(updates.map((u) => u.version)).toEqual(["2607.0.104", "2607.0.106"]);
  });

  it("ignores the listed channel's releases", () => {
    // Both channels are versioned by calver-tag-action out of ONE tag sequence, so the
    // tag cannot say which is which and the prerelease flag has to. Offering a full
    // release here would push the LISTED add-on's xpi to dev users under the dev id.
    const updates = updatesIn(
      updatesManifest([
        {
          tag_name: "v2607.0.103",
          prerelease: false,
          assets: [asset("configurable-containers-2607.0.103.xpi")],
        },
        dev("v2607.0.104"),
      ]),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.version).toBe("2607.0.104");
  });

  it("strips the tag's v, because Firefox compares against the manifest version", () => {
    // calver-tag-action pushes `v2607.0.104` and reports `2607.0.104`; a `v` left in
    // here is not a version Firefox can compare, so no update would ever be offered.
    expect(updatesIn(updatesManifest([dev("v2607.0.104")]))[0]!.version).toBe("2607.0.104");
  });

  it("links to the asset's own url rather than composing one", () => {
    // web-ext names the signed file, so composing a url from the tag would silently
    // produce 404s the moment that naming changed.
    const updates = updatesIn(
      updatesManifest([dev("v2607.0.104", [asset("some_other_name.xpi")])]),
    );
    expect(updates[0]!.update_link).toBe(asset("some_other_name.xpi").browser_download_url);
  });

  // The regression the symmetric-artefact change would otherwise have caused. A dev
  // release now carries the reproducible pre-signing build alongside the signed one, and
  // `.endsWith(".xpi")` took whichever GitHub listed first. Firefox refuses an unsigned
  // xpi, so half the time this would have offered an uninstallable update — silently, and
  // permanently, the release being immutable.
  it("offers the SIGNED xpi, never the reproducible build published beside it", () => {
    const updates = updatesIn(
      updatesManifest([
        dev("v2607.0.104", [
          // Deliberately first, which is what the old rule would have taken.
          asset("configurable-containers-2607.0.104.xpi"),
          asset("configurable_containers_dev-2607.0.104.xpi"),
        ]),
      ]),
    );
    expect(updates[0]!.update_link).toBe(
      asset("configurable_containers_dev-2607.0.104.xpi").browser_download_url,
    );
  });

  it("still offers the one xpi on releases published before the reproducible build existed", () => {
    const updates = updatesIn(
      updatesManifest([dev("v2607.0.104", [asset("configurable_containers_dev-2607.0.104.xpi")])]),
    );
    expect(updates[0]!.update_link).toBe(
      asset("configurable_containers_dev-2607.0.104.xpi").browser_download_url,
    );
  });

  // The source archive rides along on a dev release now too, and it is not an xpi — so it
  // must not be mistaken for one, and must not make the choice ambiguous either.
  it("ignores the source archive", () => {
    const updates = updatesIn(
      updatesManifest([
        dev("v2607.0.104", [
          asset("configurable-containers-src-2607.0.104.zip"),
          asset("configurable-containers-2607.0.104.xpi"),
          asset("configurable_containers_dev-2607.0.104.xpi"),
        ]),
      ]),
    );
    expect(updates[0]!.update_link).toBe(
      asset("configurable_containers_dev-2607.0.104.xpi").browser_download_url,
    );
  });

  // Refused rather than guessed. Two signed-looking xpis means something changed about
  // what a release carries, and picking one would be a coin flip that ships to users.
  it("skips a release carrying two candidate xpis rather than guessing", () => {
    const updates = updatesIn(
      updatesManifest([
        dev("v2607.0.104", [
          asset("configurable_containers_dev-2607.0.104.xpi"),
          asset("something_else-2607.0.104.xpi"),
        ]),
        dev("v2607.0.106"),
      ]),
    );
    expect(updates.map((u) => u.version)).toEqual(["2607.0.106"]);
  });

  it("skips a dev release with no xpi", () => {
    // The tag is pushed BEFORE signing, so a signing failure leaves a release-less tag
    // and, if the release was made, an assetless release. An entry pointing at nothing
    // would stall the update check for everyone.
    const updates = updatesIn(
      updatesManifest([dev("v2607.0.104", []), dev("v2607.0.106")]),
    );
    expect(updates.map((u) => u.version)).toEqual(["2607.0.106"]);
  });
});

describe("where the manifest is written", () => {
  const root = "/repo";

  it("resolves a relative directory against the working tree", () => {
    expect(outputDir("_site", root)).toBe("/repo/_site");
  });

  it("allows the working tree itself", () => {
    expect(outputDir(".", root)).toBe("/repo");
  });

  // updates.json is what every dogfooder's Firefox reads to find its next version, so a
  // path that leaves the checkout either publishes nothing or overwrites something.
  it.each(["../elsewhere", "/etc", "_site/../../escape"])("refuses %j", (raw) => {
    expect(() => outputDir(raw, root)).toThrow(/outside the working tree/);
  });

  it("does not mistake a sibling with the same prefix for a child", () => {
    expect(() => outputDir("../repo-other", root)).toThrow(/outside the working tree/);
  });
});
