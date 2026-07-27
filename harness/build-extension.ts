import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../src/extension/background.ts");
const OUTFILE = path.resolve(HERE, "../extensions/cc/background.js");

// Bundle the extension background (engine + real port + tldts + yaml) into one
// classic script Firefox can load as an MV2 background. Returns the output path.
export async function buildExtension(): Promise<string> {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: OUTFILE,
    format: "iife",
    platform: "browser",
    target: "firefox115",
    logLevel: "silent",
  });
  return OUTFILE;
}
