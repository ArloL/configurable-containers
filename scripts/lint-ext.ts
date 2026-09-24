// `web-ext lint` over the packaged add-on, failing on ANY finding not accepted below.
//
// addons-linter is the validator AMO runs on upload, and it exits zero on a warning, so a
// warning's only audience was the Developer Hub page nobody opens before the release is
// already published. `--warnings-as-errors` is not the answer either: the one warning this
// build carries is deliberate, and a gate that is red on every run gets switched off. So
// every finding is either accepted here, with the reason, or fails the build — errors,
// warnings and notices alike, since the Developer Hub shows all three.
//
// Run: npm run lint:ext (which packages dist/cc first)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_EXT = path.resolve(HERE, "../node_modules/.bin/web-ext");

export interface Finding {
  code: string;
  file?: string;
  message: string;
  description?: string;
}

export interface LintReport {
  errors: Finding[];
  warnings: Finding[];
  notices: Finding[];
}

export interface Accepted {
  code: string;
  file: string;
  /** A fragment of the description, so the same code raised by a different key is not waved through. */
  mentions: string;
  why: string;
}

// An exact inventory: an entry nothing matches fails too, because a stale acceptance is
// the one that later waves a new finding through.
export const ACCEPTED: readonly Accepted[] = [
  {
    code: "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
    file: "manifest.json",
    mentions: "browser_specific_settings.gecko.data_collection_permissions",
    why:
      "the fix it implies is a `gecko_android` floor, which would claim CC works on Android, where containers do not exist; test/fitness/firefox-floor.test.ts carries the argument and forbids that key.",
  },
];

function matches(finding: Finding, accepted: Accepted): boolean {
  return (
    finding.code === accepted.code &&
    finding.file === accepted.file &&
    (finding.description ?? "").includes(accepted.mentions)
  );
}

/** Everything that should fail the build, one line each; empty when the report is clean. */
export function unacceptedFindings(report: LintReport, accepted: readonly Accepted[] = ACCEPTED): string[] {
  const findings = [
    ...report.errors.map((f) => ["error", f] as const),
    ...report.warnings.map((f) => ["warning", f] as const),
    ...report.notices.map((f) => ["notice", f] as const),
  ];
  const problems = findings
    .filter(([, f]) => !accepted.some((a) => matches(f, a)))
    .map(([severity, f]) => `${severity} ${f.code} in ${f.file ?? "<no file>"}: ${f.description ?? f.message}`);
  const stale = accepted
    .filter((a) => !findings.some(([, f]) => matches(f, a)))
    .map((a) => `accepted ${a.code} (${a.mentions}) no longer occurs: remove it from scripts/lint-ext.ts`);
  return [...problems, ...stale];
}

function main() {
  const res = spawnSync(WEB_EXT, ["lint", "--source-dir", "dist/cc", "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  // web-ext exits non-zero on an error; the JSON is still the report, so read it either way.
  const report = JSON.parse(res.stdout) as LintReport;
  const problems = unacceptedFindings(report);
  for (const [severity, list] of [["error", report.errors], ["warning", report.warnings], ["notice", report.notices]] as const) {
    for (const f of list) console.log(`${severity} ${f.code}: ${f.description ?? f.message}`);
  }
  if (problems.length > 0) {
    console.error(`\nweb-ext lint: ${problems.length} finding(s) not accepted:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`web-ext lint: clean apart from ${ACCEPTED.length} accepted finding(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
