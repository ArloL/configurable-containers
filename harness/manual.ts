// Launch a HEADED Firefox with CC + probe for manual interactive testing.
// Run: npx tsx harness/manual.ts
//
// This builds the CC extension (same build as the e2e tests), starts the local
// test server, and opens a real Firefox window with CC + probe installed. The
// fake domains (work.example, figma.example, youtube.example, etc.) resolve to
// loopback so you can navigate to them directly.
//
// Ctrl+C closes Firefox and the server.

import { launch, type Session } from "./firefox";

async function main() {
  const session: Session = await launch({ extensions: ["probe", "cc"], headless: false });

  const port = new URL(session.serverUrl).port;
  const sites: Array<[string, string]> = [
    ["work.example", "routes to Work (cookies + scripts overlay)"],
    ["figma.example", "multi-open [Personal, Work], no default → choice screen"],
    ["youtube.example", "default: Temporary → fresh tmp; reopen picker → Personal"],
    ["redirect.example", "redirector rule (auto-closes after 2s if stranded)"],
    ["nomatch.example", "unmatched → fresh tmp"],
  ];

  console.log("\n=== Configurable Containers — manual test session ===\n");
  console.log(`Server:  ${session.serverUrl}`);
  console.log("Try navigating to:");
  for (const [host, desc] of sites) {
    console.log(`  http://${host}:${port}/   — ${desc}`);
  }
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
