import { describe, it, expect } from "vitest";
import {
  startServer,
  BEACON_PATH,
  REDIRECT_TARGET_HOST,
  OAUTH_CODE,
  SAML_ASSERTION,
  IDP_TARGET_HOST,
} from "../../harness/server";

describe("startServer", () => {
  it("serves an http page with a title and closes cleanly", async () => {
    const server = await startServer();
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const res = await fetch(server.url);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<title>probe-target</title>");
    } finally {
      await server.close();
    }
    // After close, the port is released — a second connect should fail.
    await expect(fetch(server.url)).rejects.toBeTruthy();
  });

  it("reflects the request Cookie header into a body attribute", async () => {
    const server = await startServer();
    try {
      const res = await fetch(server.url, { headers: { cookie: "seed=1" } });
      const body = await res.text();
      expect(body).toContain('data-seen-cookie="seed=1"');
    } finally {
      await server.close();
    }
  });

  it("302s /redirect to its one fixed cross-host destination", async () => {
    const server = await startServer();
    try {
      const port = new URL(server.url).port;
      const res = await fetch(`${server.url}redirect`, { redirect: "manual" });

      expect(res.status).toBe(302);
      // Fixed, not taken from the request: nothing a caller sends reaches Location.
      expect(res.headers.get("location")).toBe(`http://${REDIRECT_TARGET_HOST}:${port}/`);
    } finally {
      await server.close();
    }
  });

  it("embeds a first-script probe that records the cc_script localStorage value", async () => {
    const server = await startServer();
    try {
      const res = await fetch(server.url);
      const body = await res.text();
      // The page carries an inline script that records — at the page's first run —
      // whether cc_script was already set. The attribute value is only observable in a
      // real browser (the L4 test asserts "1"); here we just assert the probe ships.
      expect(body).toContain("data-cc-script-at-start");
      expect(body).toContain("<script>");
    } finally {
      await server.close();
    }
  });

  it("/authorize redirects to the matched host carrying an OAuth code", async () => {
    const server = await startServer();
    try {
      const res = await fetch(new URL("/authorize", server.url), { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.hostname).toBe(IDP_TARGET_HOST);
      expect(location.pathname).toBe("/callback");
      expect(location.searchParams.get("code")).toBe(OAUTH_CODE);
      expect(location.port).toBe(new URL(server.url).port);
    } finally {
      await server.close();
    }
  });

  it("/saml serves a self-submitting POST-binding form aimed at the matched host", async () => {
    const server = await startServer();
    try {
      const body = await (await fetch(new URL("/saml", server.url))).text();
      expect(body).toContain(`action="http://${IDP_TARGET_HOST}:${new URL(server.url).port}/acs"`);
      expect(body).toContain(`value="${SAML_ASSERTION}"`);
      expect(body).toContain(".submit()");
    } finally {
      await server.close();
    }
  });

  it("resolves awaitBeacon when the named beacon is fetched", async () => {
    const server = await startServer();
    try {
      const waited = server.awaitBeacon("mac-assigned", 5_000);
      const res = await fetch(`${server.url.replace(/\/$/, "")}${BEACON_PATH}?name=mac-assigned`);
      expect(res.status).toBe(204);
      await expect(waited).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("resolves a beacon that arrived before anyone waited for it", async () => {
    const server = await startServer();
    try {
      // The seeding script fetches as soon as it is done, which can be before launch()
      // gets around to waiting. A beacon that only counted while someone listened
      // would hang the caller it was meant to release.
      await fetch(`${server.url.replace(/\/$/, "")}${BEACON_PATH}?name=early`);
      await expect(server.awaitBeacon("early", 5_000)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("rejects awaitBeacon when nothing reports in", async () => {
    const server = await startServer();
    try {
      // The seeding gave up (its container never resolved), so launch() must fail
      // loudly rather than hand back a session whose assignment is not there.
      await expect(server.awaitBeacon("never-sent", 50)).rejects.toThrow(/no "never-sent" beacon/);
    } finally {
      await server.close();
    }
  });

  it("reflects a urlencoded POST body into a body attribute", async () => {
    const server = await startServer();
    try {
      const res = await fetch(new URL("/acs", server.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `SAMLResponse=${SAML_ASSERTION}`,
      });
      expect(await res.text()).toContain(`data-seen-post="SAMLResponse=${SAML_ASSERTION}"`);
    } finally {
      await server.close();
    }
  });
});
