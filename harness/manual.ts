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
import { launch, type Session } from "./firefox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(HERE, "../configurable-containers.config.yaml");

async function main() {
  const configYaml = readFileSync(CONFIG_PATH, "utf-8");
  const session: Session = await launch({
    extensions: ["cc"],
    headless: false,
    configYaml,
    localDomains: null, // live sites resolve normally
  });

  console.log("\n=== Configurable Containers — manual test session (live) ===\n");
  console.log(`Config:  ${CONFIG_PATH}`);
  console.log("\nTry navigating to any site in your config; CC will route per the config.");
  console.log("\nPress Ctrl+C to close Firefox and exit.\n");

  process.on("SIGINT", async () => {
    console.log("\nClosing...");
    try {
      await session.close();
    } catch {
      // Firefox may already be gone — fine.
    }
    process.exit(0);
  });

  // Keep the process alive until interrupted.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
