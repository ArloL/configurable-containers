import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Escape a string for safe inclusion in a double-quoted HTML attribute.
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// The one host /redirect sends a browser to (a launch() local domain, so it resolves to this
// same loopback server). Fixed on purpose: reading the destination off the query string made
// this an open redirect (CodeQL js/server-side-unvalidated-url-redirection), and a chain only
// needs to cross to one other host.
export const REDIRECT_TARGET_HOST = "hop.example";

// The mock IdP's fixed destination and payloads. Constants rather than query parameters for
// the same reason as REDIRECT_TARGET_HOST. The host is a launch() local domain that CC's test
// config routes to "Work", so a navigation to it is one CC wants to move.
export const IDP_TARGET_HOST = "work.example";
export const OAUTH_CODE = "cc-test-code-42";
export const SAML_ASSERTION = "cc-test-assertion";

// The path an extension fetches to tell the harness a step only it can see has finished;
// `?name=` labels which one. Node cannot look inside the browser and a background page's
// state is in no DOM, so this is the only seam a setup step can report readiness through.
export const BEACON_PATH = "/__beacon";

export interface TestServer {
  url: string;
  // Resolves once an extension has fetched BEACON_PATH?name=<name>; rejects on timeout. An
  // already-arrived beacon resolves immediately, so waiting late cannot lose the race.
  awaitBeacon: (name: string, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  let port = 0; // filled in by listen() below, before any request can arrive

  const arrived = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();

  const server = createServer((req, res) => {
    const requested = new URL(req.url ?? "/", "http://127.0.0.1");
    const params = requested.searchParams;

    // A beacon carries no page: it is answered 204 and only its arrival matters.
    if (requested.pathname === BEACON_PATH) {
      const name = params.get("name") ?? "";
      arrived.add(name);
      for (const resolve of waiting.get(name) ?? []) resolve();
      waiting.delete(name);
      res.writeHead(204);
      res.end();
      return;
    }

    // /redirect answers 302 to REDIRECT_TARGET_HOST on this same server, so a test can drive
    // a real cross-host chain — the tab stays pre-commit ("about:blank") across every hop.
    if (requested.pathname === "/redirect") {
      res.writeHead(302, { location: `http://${REDIRECT_TARGET_HOST}:${port}/` });
      res.end();
      return;
    }

    // /authorize is the OAuth code flow: a GET redirect into a host CC routes elsewhere,
    // carrying the parameter that must survive the reopen (F9).
    if (requested.pathname === "/authorize") {
      res.writeHead(302, { location: `http://${IDP_TARGET_HOST}:${port}/callback?code=${OAUTH_CODE}` });
      res.end();
      return;
    }

    // /saml is the POST binding: a self-submitting form to a host CC routes elsewhere.
    // Reopening it turns the POST into a GET and drops the assertion, which CC must decline
    // to do.
    if (requested.pathname === "/saml") {
      const action = `http://${IDP_TARGET_HOST}:${port}/acs`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>idp</title></head><body>" +
          `<form id="saml" method="POST" action="${escapeAttr(action)}">` +
          `<input type="hidden" name="SAMLResponse" value="${escapeAttr(SAML_ASSERTION)}">` +
          "</form><script>document.getElementById('saml').submit();</script></body></html>",
      );
      return;
    }

    // ?link=<url> puts an anchor on the page so a test can CLICK it with a real gesture:
    // target=_blank by default, so the new tab inherits its opener's container the way a
    // middle-click does and no scripted tabs.create reproduces, or same-tab with &same=1.
    // &popup=1 makes the click a window.open with features — a share button. Firefox gives
    // that its own popup WINDOW with a pre-commit tab, the case a reopen must put back where
    // it found it.
    const link = params.get("link");
    const popup = params.has("popup");
    const target = params.has("same") || popup ? "" : ` target="_blank"`;
    const anchor = link ? `<a id="go"${target} href="${escapeAttr(link)}">go</a>` : "";
    // The url stays in the href (escaped above) and the script reads it back from there,
    // never interpolated into JS, so this adds no second injection sink.
    const popupScript =
      link && popup
        ? "<script>document.getElementById('go').addEventListener('click', function (e) {" +
          "  e.preventDefault();" +
          "  window.open(this.href, 'share', 'width=640,height=480');" +
          "});</script>"
        : "";

    // Reflect the request's Cookie header into a body attribute, so a driver can assert the
    // FIRST request already carried a seeded cookie (F12 wire side).
    const cookie = req.headers.cookie ?? "";

    // Reflect a POST body the same way, proving an assertion arrived intact rather than
    // being lost to a reopen's GET (F9).
    const respond = (post: string) => {
      const html =
        "<!doctype html><html><head><title>probe-target</title>" +
        // This inline script runs at parse time, AFTER document_start content scripts, so
        // seeing localStorage.cc_script here proves CC's injected script ran first (F12).
        "<script>document.documentElement.setAttribute('data-cc-script-at-start', localStorage.getItem('cc_script') || '');</script>" +
        `</head><body data-seen-cookie="${escapeAttr(cookie)}" data-seen-post="${escapeAttr(post)}">ok${anchor}${popupScript}</body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => respond(body));
      return;
    }
    respond("");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    awaitBeacon: (name, timeoutMs = 30_000) =>
      new Promise<void>((resolve, reject) => {
        if (arrived.has(name)) return resolve();
        const timer = setTimeout(
          () => reject(new Error(`no "${name}" beacon within ${timeoutMs}ms`)),
          timeoutMs,
        );
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        waiting.set(name, [...(waiting.get(name) ?? []), done]);
      }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
