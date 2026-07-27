import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE, "../extensions/cc");
const ENTRY = path.resolve(HERE, "../src/extension/background.ts");
const CHOICE_ENTRY = path.resolve(HERE, "../src/extension/choice.ts");
const OUTFILE = path.resolve(OUTDIR, "background.js");

// Bundle the extension background (engine + real port + tldts + yaml) into one
// classic script Firefox can load as an MV2 background, plus the keyboard-driven choice
// page script. Returns the background path (the harness installs the whole dir).
export async function buildExtension(
  opts: { graceMs?: number; redirectorDelayMs?: number } = {},
): Promise<string> {
  await build({
    entryPoints: [ENTRY, CHOICE_ENTRY],
    bundle: true,
    outdir: OUTDIR,
    format: "iife",
    platform: "browser",
    target: "firefox115",
    logLevel: "silent",
    define: {
      __CC_GRACE_MS__: String(opts.graceMs ?? 300000),
      __CC_REDIRECTOR_DELAY_MS__: String(opts.redirectorDelayMs ?? 2000),
    },
  });
  return OUTFILE;
}
