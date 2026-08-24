import { describe, it, expect } from "vitest";
import { updatesManifest } from "../../scripts/dev-updates.js";

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
