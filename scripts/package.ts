// Build a distributable XPI. Stages extensions/cc/ into dist/cc/ and stamps the
// version THERE, so manifest.json stays a placeholder in the tracked tree and a
// local run never dirties git. Run: npx tsx scripts/package.ts [version]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { buildExtension } from "../harness/build-extension";
import { parseConfig } from "../src/config/parse";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../extensions/cc");
const DEFAULT_SEED = path.resolve(HERE, "../src/config/default.yaml");
const DEFAULT_OUT = path.resolve(HERE, "../dist");

export interface PackageOptions {
  version: string;
  seedPath?: string;
  outDir?: string;
}

export async function packageExtension(
  opts: PackageOptions,
): Promise<{ xpiPath: string; stageDir: string }> {
  const seedPath = opts.seedPath ?? DEFAULT_SEED;
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const configYaml = readFileSync(seedPath, "utf8");

  // Fail before building: a seed that does not parse would make every fresh install
  // temporary-only, and the user would only see a swallowed console.error. This check
  // belongs HERE, not in buildExtension — the options e2e needs to build a broken seed
  // on purpose.
  parseConfig(configYaml);

  await buildExtension({ configYaml });

  const stageDir = path.join(outDir, "cc");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(SRC_DIR, stageDir, { recursive: true });

  const manifestPath = path.join(stageDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = opts.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const xpiPath = path.join(outDir, `configurable-containers-${opts.version}.xpi`);
  rmSync(xpiPath, { force: true });
  execFileSync("zip", ["-r", "-FS", xpiPath, ".", "-x", ".*"], { cwd: stageDir });

  return { xpiPath, stageDir };
}

// CLI: `npx tsx scripts/package.ts 2607.0.101`. Defaults to 0.0.0 for local builds,
// which are never submitted — real versions come from the CalVer tag in CI.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const version = process.argv[2] ?? process.env.CC_VERSION ?? "0.0.0";
  packageExtension({ version })
    .then(({ xpiPath }) => console.log(xpiPath))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
