import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const HTML =
  "<!doctype html><html><head><title>probe-target</title></head>" +
  "<body>ok</body></html>";

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
