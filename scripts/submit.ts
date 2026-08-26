// Submit the listed build to AMO, carrying the listing copy with it.
//
// A script rather than an inline web-ext command in package.json, because --amo-metadata
// takes a FILE and that file has to be generated per version: the reviewer notes name the
// version and the BUILD_TIMESTAMP this very build was made against. Extra arguments are
// forwarded, so the workflow's --upload-source-code still reaches web-ext.
//
// Run: VERSION=<version> BUILD_TIMESTAMP=<stamp> npm run submit
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { writeAmoMetadata } from "./amo-metadata";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_EXT = path.resolve(HERE, "../node_modules/.bin/web-ext");
const METADATA = path.resolve(HERE, "../dist/amo-metadata.json");

export function submitArgs(metadataPath: string, extra: readonly string[]): string[] {
  return [
    "sign",
    "--source-dir",
    "dist/cc",
    "--artifacts-dir",
    "dist",
    "--channel",
    "listed",
    "--amo-metadata",
    metadataPath,
    ...extra,
  ];
}

function main() {
  for (const name of ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET", "VERSION", "BUILD_TIMESTAMP"]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is not set`);
  }

  const metadata = writeAmoMetadata(METADATA, {
    version: process.env["VERSION"] ?? "",
    timestamp: process.env["BUILD_TIMESTAMP"] ?? "",
    channel: "listed",
  });

  const res = spawnSync(WEB_EXT, submitArgs(metadata, process.argv.slice(2)), { stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// The argv guard keeps an import from uploading anything.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
