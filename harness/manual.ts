// A HEADED Firefox with CC + probe, for manual testing. Run: npx tsx harness/manual.ts
//
// Builds CC with YOUR REAL config (configurable-containers.config.yaml), starts the local
// test server (for the cookies overlay wire-side check), and opens Firefox with CC and the
// probe installed. Live sites resolve normally, so CC routes github.com, youtube.com and the
// rest per your config. The probe writes CSID:<store> into each tab title so you can see
// where a tab landed. Ctrl+C closes Firefox and the server.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { launch } from "./firefox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(HERE, "../configurable-containers.config.yaml");

async function main() {
  const configYaml = readFileSync(CONFIG_PATH, "utf-8");
  await launch({
    // `extensions` REPLACES launch()'s ["probe"] default rather than adding to it, so
    // naming CC alone dropped the probe — and with it the CSID:<store> titles above, and
    // the notify and decision echoes launch() wires to the probe's id regardless.
    extensions: ["cc", "probe"],
    headless: false,
    configYaml,
    localDomains: null, // live sites resolve normally
    // Marionette otherwise opens at about:blank, which auto-temp ignores. A real Firefox
    // starts on the new-tab page, so start there and the auto-temp sweep greets you with a
    // tmp container as it would at home.
    startupUrl: "about:newtab",
  });

  console.log("\n=== Configurable Containers — manual test session (live) ===\n");
  console.log(`Config:  ${CONFIG_PATH}`);
  console.log("\nTry navigating to any site in your config; CC will route per the config.");
  console.log("\nPress Ctrl+C to close Firefox and exit.\n");

  // No SIGINT handler here: harness/reaper.ts installs one that kills this session's browser
  // and exits. A second would only race it, and would run after it, since the reaper's is
  // registered when harness/firefox.ts is imported.

  // Keep the process alive until interrupted.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
