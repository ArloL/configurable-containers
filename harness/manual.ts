// Launch a HEADED Firefox with CC + probe for manual interactive testing.
// Run: npx tsx harness/manual.ts
//
// This builds the CC extension with YOUR REAL config (configurable-containers.config.yaml),
// starts a local test server (for the cookies overlay wire-side check), and opens a real
// Firefox window with CC + probe installed. Live sites resolve normally — navigate to
// github.com, youtube.com, notion.com, etc. and CC will route per your config.
//
// The probe writes CSID:<store> into the tab title so you can see which container
// each tab landed in.
//
// Ctrl+C closes Firefox and the server.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { launch } from "./firefox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(HERE, "../configurable-containers.config.yaml");

async function main() {
  const configYaml = readFileSync(CONFIG_PATH, "utf-8");
  await launch({
    extensions: ["cc"],
    headless: false,
    configYaml,
    localDomains: null, // live sites resolve normally
    // Marionette otherwise opens the session at about:blank, which auto-temp ignores;
    // a real user's Firefox starts on the new-tab page, so start there too and the
    // auto-temp startup sweep greets you with a tmp container like it would at home.
    startupUrl: "about:newtab",
  });

  console.log("\n=== Configurable Containers — manual test session (live) ===\n");
  console.log(`Config:  ${CONFIG_PATH}`);
  console.log("\nTry navigating to any site in your config; CC will route per the config.");
  console.log("\nPress Ctrl+C to close Firefox and exit.\n");

  // No SIGINT handler here: harness/reaper.ts installs one that kills this session's
  // browser and exits. A second handler would only race it — and would run *after* it,
  // since the reaper's is registered when harness/firefox.ts is imported.

  // Keep the process alive until interrupted.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
