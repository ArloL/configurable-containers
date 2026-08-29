// A HEADED Firefox running CC ALONE, for manual testing. Run: npx tsx harness/manual.ts
//
// Builds CC with YOUR REAL config (configurable-containers.config.yaml), starts the local
// test server (for the cookies overlay wire-side check), and opens Firefox with CC
// installed. Live sites resolve normally, so CC routes github.com, youtube.com and the rest
// per your config. Ctrl+C closes Firefox and the server.
//
// NO PROBE, deliberately — this is the one caller that does not want it, which is why
// `extensions` names CC alone. The probe is the e2e suite's answer to WebDriver being unable
// to read chrome UI: it smuggles a tab's container into `document.title`, so every page in
// the session would read `CSID:firefox-container-3` instead of its own title. A person needs
// none of that — Firefox itself shows the container on the tab and in the URL bar. It would
// also add a `probe` container to the list you are inspecting, and hand every live page a
// list of your default-container cookie names, which is a boundary a session browsing real
// logged-in sites should keep.
//
// When you are debugging a decision rather than browsing, add "probe" and read CC's echoed
// decision log — `decisions`, the last 100 — from about:debugging -> Inspect on the probe.
// The titles go with it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { launch } from "./firefox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(HERE, "../configurable-containers.config.yaml");

async function main() {
  const configYaml = readFileSync(CONFIG_PATH, "utf-8");
  await launch({
    extensions: ["cc"], // see the header: the probe would take every page's title with it
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
