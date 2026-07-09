import { describe, it, expect } from "vitest";
import { startServer } from "../../harness/server";

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
});
