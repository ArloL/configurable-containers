import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

// F2/F7 against the REAL Multi-Account Containers (the mac/ checkout, loaded unbuilt
// alongside CC). The L3 mock already proves "truthy getAssignment ⇒ defer"; what only
// real Firefox can prove is that the handshake works at all against MAC's actual code:
// that cross-extension sendMessage reaches it, that MAC's permission gate accepts CC
// (it throws unless the caller declares contextualIdentities), and that a real
// assignment comes back in the shape `macOwns` tests with `a != null`.
//
// Those are exactly the facts an unassigned-domain test CANNOT establish: macOwns
// swallows a throw and returns false, so a broken handshake and "no assignment" are
// observationally identical — CC routes normally either way. Only an ASSIGNED domain
// separates them, which is why the harness seeds one.
describe("MAC interop (real Firefox, CC + MAC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({
      extensions: ["cc", "mac"],
      // nomatch.example matches no CC rule, so CC's own answer would be a throwaway.
      // MAC assigns it to Personal (firefox-container-1). The two answers differ, which
      // is what makes the deferral observable.
      macAssign: { host: "nomatch.example", userContextId: "1" },
    });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("defers to MAC on an assigned host instead of routing it into a throwaway", async () => {
    const url = `http://nomatch.example:${serverPort}/`;
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(url);
    } catch {
      // Whichever extension wins tears the tab down mid-nav — expected.
    }

    // MAC's container, not CC's. A tmp here would mean CC ignored the assignment and
    // bought a throwaway — the F2/F7 churn this defers to avoid.
    const { name: containerName } = await awaitContainerTab(firefox.browser, url);
    expect(containerName).toBe("Personal");
  });
});
