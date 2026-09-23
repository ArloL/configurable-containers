// Fitness function: zizmor has no suppressions.
//
// Its three `self-repository` ignores outlived their reason by weeks: they said actionlint
// rejects the `$/…` form zizmor asks for, while the actionlint fork check-actions pins had
// accepted it since 2026-08-19. A written reason is what makes a suppression reviewable,
// and nothing re-reads one — so the policy is none, and this is what holds it. If one must
// come back, the reason goes in docs/static-analysis.md and this becomes an exact list.
import { describe, it, expect } from "vitest";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRepoFile } from "./sources";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("workflow suppressions", () => {
  it("has no zizmor ignore anywhere in the workflows", () => {
    const workflows = globSync(".github/workflows/*.y*ml", { cwd: root });
    expect(workflows.length).toBeGreaterThan(0);

    const ignores = workflows.filter((file) => /zizmor:\s*ignore/.test(readRepoFile(file)));

    expect(ignores).toEqual([]);
  });
});
