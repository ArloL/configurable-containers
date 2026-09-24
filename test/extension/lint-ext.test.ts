import { describe, it, expect } from "vitest";
import { unacceptedFindings, ACCEPTED, type Finding, type LintReport } from "../../scripts/lint-ext";

const androidFloor: Finding = {
  code: "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
  file: "manifest.json",
  message: "Manifest key not supported by the specified minimum Firefox for Android version",
  description:
    '"strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings.gecko.data_collection_permissions".',
};

function report(parts: Partial<LintReport>): LintReport {
  return { errors: [], warnings: [], notices: [], ...parts };
}

describe("unacceptedFindings", () => {
  it("passes the report this build produces today", () => {
    expect(unacceptedFindings(report({ warnings: [androidFloor] }))).toEqual([]);
  });

  it("fails a warning nobody accepted", () => {
    // addons-linter exits zero on a warning; this is the whole point of the script.
    const other: Finding = { code: "UNSAFE_VAR_ASSIGNMENT", file: "background.js", message: "Unsafe assignment to innerHTML" };
    expect(unacceptedFindings(report({ warnings: [androidFloor, other] }))).toEqual([
      "warning UNSAFE_VAR_ASSIGNMENT in background.js: Unsafe assignment to innerHTML",
    ]);
  });

  it("fails errors and notices as well", () => {
    const e: Finding = { code: "E", file: "a.js", message: "m", description: "d" };
    const n: Finding = { code: "N", message: "m" };
    expect(unacceptedFindings(report({ errors: [e], warnings: [androidFloor], notices: [n] }))).toEqual([
      "error E in a.js: d",
      "notice N in <no file>: m",
    ]);
  });

  it("does not accept the same code raised by a different manifest key", () => {
    const sameCode = { ...androidFloor, description: androidFloor.description!.replace("data_collection_permissions", "something_else") };
    expect(unacceptedFindings(report({ warnings: [sameCode] }))).toHaveLength(2); // the new one, and the stale acceptance
  });

  it("fails an acceptance that no longer matches anything", () => {
    expect(unacceptedFindings(report({}))).toEqual([
      `accepted ${ACCEPTED[0]!.code} (${ACCEPTED[0]!.mentions}) no longer occurs: remove it from scripts/lint-ext.ts`,
    ]);
  });
});
