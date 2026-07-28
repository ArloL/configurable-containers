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

// Bundle the extension background (engine + real port + tldts + yaml) into one
// classic script Firefox can load as an MV2 background, plus the keyboard-driven choice
// page script. Returns the background path (the harness installs the whole dir).
export async function buildExtension(
  opts: { graceMs?: number; redirectorDelayMs?: number; configYaml?: string; notifyEchoTo?: string } = {},
): Promise<string> {
  await build({
    entryPoints: [ENTRY, CHOICE_ENTRY, OPTIONS_ENTRY],
    bundle: true,
    outdir: OUTDIR,
    format: "iife",
    platform: "browser",
    target: "firefox115",
    logLevel: "silent",
    define: {
      __CC_GRACE_MS__: String(opts.graceMs ?? 300000),
      __CC_REDIRECTOR_DELAY_MS__: String(opts.redirectorDelayMs ?? 2000),
      __CC_CONFIG_YAML__: JSON.stringify(opts.configYaml ?? TEST_CONFIG_YAML),
      __CC_NOTIFY_ECHO_TO__: JSON.stringify(opts.notifyEchoTo ?? ""),
    },
  });
  return OUTFILE;
}
