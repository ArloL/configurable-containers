import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE, "../extensions/cc");
const ENTRY = path.resolve(HERE, "../src/extension/background.ts");
const CHOICE_ENTRY = path.resolve(HERE, "../src/extension/choice.ts");
const OPTIONS_ENTRY = path.resolve(HERE, "../src/extension/options.ts");
const OUTFILE = path.resolve(OUTDIR, "background.js");

// The test config (used by e2e tests). The manual launcher injects the user's real
// config via the `configYaml` option instead.
const TEST_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script', '1');" }
  - match: redirect.example
    redirector: true
  - match: figma.example
    open: [Personal, Work]
  - match: youtube.example
    open: [Temporary, Personal]
    default: Temporary
`;

// The keep-alive grace `npm run package` ships: five minutes between a throwaway's
// last tab closing and its removal. Exported so the nightly real-delay case waits out
// the SAME number the bundle carries, rather than a copy of it that could drift.
export const PRODUCTION_GRACE_MS = 300000;

// One classic script Firefox can load as an MV2 background, plus the choice-page script.
// Returns the background path; the harness installs the whole directory.
export async function buildExtension(
  opts: {
    graceMs?: number | undefined;
    redirectorDelayMs?: number | undefined;
    configYaml?: string | undefined;
    notifyEchoTo?: string | undefined;
    // The probe id CC echoes its ROUTING DECISIONS to. Defaults off for the same reason the
    // notify echo does: no shipped bundle may contain a probe id, and
    // `test/extension/package.test.ts` asserts it does not.
    decisionEchoTo?: string | undefined;
  } = {},
): Promise<string> {
  await build({
    entryPoints: [ENTRY, CHOICE_ENTRY, OPTIONS_ENTRY],
    bundle: true,
    outdir: OUTDIR,
    format: "iife",
    platform: "browser",
    // The floor the manifest declares (`strict_min_version`), which is all this says: which
    // syntax esbuild may emit, never which browser.* APIs the code may call. The two used to
    // disagree — a build claiming 115 shipping a manifest key from 140 — and
    // `test/fitness/firefox-floor.test.ts` is what keeps them from drifting apart again.
    target: "firefox140",
    logLevel: "silent",
    define: {
      __CC_GRACE_MS__: String(opts.graceMs ?? PRODUCTION_GRACE_MS),
      __CC_REDIRECTOR_DELAY_MS__: String(opts.redirectorDelayMs ?? 2000),
      __CC_CONFIG_YAML__: JSON.stringify(opts.configYaml ?? TEST_CONFIG_YAML),
      __CC_NOTIFY_ECHO_TO__: JSON.stringify(opts.notifyEchoTo ?? ""),
      __CC_DECISION_ECHO_TO__: JSON.stringify(opts.decisionEchoTo ?? ""),
    },
  });
  return OUTFILE;
}
