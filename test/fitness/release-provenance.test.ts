// Fitness function: every path that publishes a release also attests what it published,
// and the verifier checks it.
//
// `verify-release.yaml` proves an xpi matches the source archive published beside it, and
// GitHub's immutable releases stop either being swapped afterwards. Neither says the
// archive is this repo at the tagged commit: a release built by hand, from a tree that
// never existed in git, reproduces against itself perfectly and passes every other gate
// here. `actions/attest-build-provenance` is what ties an artefact to a commit, and the
// release notes now tell readers to run `gh attestation verify` — which makes it a promise
// rather than a nicety.
//
// A promise nothing checks is what this repo keeps finding: a second publishing path, or a
// rename of the artefacts, would leave the attestation behind and nothing would say so.
// The releases would go on advertising a verification that fails.
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readRepoFile } from "./sources";

interface Step {
  uses?: string;
  run?: string;
  with?: { "subject-path"?: string };
}
interface Job {
  steps?: Step[];
  permissions?: Record<string, string>;
}

const workflows = [".github/workflows/ci.yaml", ".github/workflows/release.yaml"] as const;

function jobsOf(path: string): [string, Job][] {
  const doc = parse(readRepoFile(path)) as { jobs: Record<string, Job> };
  return Object.entries(doc.jobs);
}

/** The version placeholder differs between the two spellings; the artefact name does not. */
function withoutVersion(text: string): string {
  return text.replace(/\$\{\{[^}]*\}\}/g, "<version>").replace(/\$\{VERSION\}/g, "<version>");
}

const publishers = workflows.flatMap((path) =>
  jobsOf(path)
    .filter(([, job]) => (job.steps ?? []).some((s) => s.run?.includes("gh release create")))
    .map(([name, job]) => ({ id: `${path.split("/").pop()}:${name}`, job }))
);

function attestedBy(job: Job): string[] {
  return (job.steps ?? [])
    .filter((s) => s.uses?.startsWith("actions/attest-build-provenance@"))
    .flatMap((s) => (s.with?.["subject-path"] ?? "").split("\n"))
    .map((line) => withoutVersion(line.trim()))
    .filter((line) => line !== "");
}

function publishedBy(job: Job): string {
  return withoutVersion((job.steps ?? []).map((s) => s.run ?? "").find((r) => r.includes("gh release create")) ?? "");
}

describe("fitness — a published artefact says which commit it came from", () => {
  it("has exactly these two publishing paths", () => {
    // An inventory rather than "at least one", because the failure is a THIRD path that
    // publishes without attesting — the whole reason the other assertions here are not
    // enough on their own.
    expect(publishers.map((p) => p.id).sort()).toEqual(["ci.yaml:prerelease", "release.yaml:release"]);
  });

  it("attests the reproducible xpi and the source archive from both of them", () => {
    for (const { id, job } of publishers) {
      const attested = attestedBy(job);
      expect(attested.filter((p) => p.endsWith(".xpi")), id).toHaveLength(1);
      expect(attested.filter((p) => p.endsWith("-src-<version>.zip")), id).toHaveLength(1);
    }
  });

  it("attests nothing it does not publish", () => {
    // The other direction, and not hypothetical: `dist/dev/` holds the AMO-signed build as
    // well, and attesting a file AMO repacked would claim provenance for bytes this
    // workflow never produced.
    for (const { id, job } of publishers) {
      const published = publishedBy(job);
      for (const path of attestedBy(job)) expect(published, `${id}: ${path}`).toContain(path);
    }
  });

  it("grants each publishing job the two scopes the attestation needs", () => {
    // Both are job-level, which is what keeps zizmor quiet about the workflow-level
    // `permissions: {}` these files open with. Without them the attest step fails at the
    // Sigstore exchange, which is a red release rather than a silent one — but it fails
    // AFTER the build, so it is worth not discovering there.
    for (const { id, job } of publishers) {
      expect(job.permissions?.["id-token"], id).toBe("write");
      expect(job.permissions?.attestations, id).toBe("write");
    }
  });

  it("verifies the provenance where it verifies the hashes", () => {
    // Attesting without verifying is the shape this repo has been caught in before: the
    // nightly reproducibility job searched for its subject, found nothing, and passed in
    // zero seconds for four weeks.
    const verify = readRepoFile(".github/workflows/verify-release.yaml");
    expect(verify).toContain("gh attestation verify");
    // The digest comparison is the part that makes it a check rather than a signature: gh
    // alone answers "built by a workflow in this repo", not "built from this commit".
    expect(verify).toContain("sourceRepositoryDigest");
  });

  it("publishes the command a reader verifies with, on both channels", () => {
    for (const path of workflows) {
      expect(readRepoFile(path), path).toContain("gh attestation verify configurable-containers-");
    }
  });
});
