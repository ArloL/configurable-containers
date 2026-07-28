import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Escape a string for safe inclusion in a double-quoted HTML attribute.
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// The one host /redirect ever sends a browser to (a launch() local domain, so it
// resolves to this same loopback server). Fixed on purpose: reading the destination
// off the query string made this an open redirect — CodeQL
// js/server-side-unvalidated-url-redirection — and a redirect chain only ever needs
// to cross to one other host.
export const REDIRECT_TARGET_HOST = "hop.example";

// The mock IdP's fixed destination and payloads. Like REDIRECT_TARGET_HOST these are
// constants rather than query parameters on purpose: reading a destination off the
// request makes this an open redirect (CodeQL js/server-side-unvalidated-url-redirection).
// The host is a launch() local domain that CC's test config routes to "Work", so a
// navigation to it is one CC wants to move into another container.
export const IDP_TARGET_HOST = "work.example";
export const OAUTH_CODE = "cc-test-code-42";
export const SAML_ASSERTION = "cc-test-assertion";

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  let port = 0; // filled in by listen() below, before any request can arrive

  const server = createServer((req, res) => {
    const requested = new URL(req.url ?? "/", "http://127.0.0.1");
    const params = requested.searchParams;

    // /redirect answers 302 to REDIRECT_TARGET_HOST on this same server, so a test can
    // drive a real cross-host redirect chain — the browser keeps the tab pre-commit
    // ("about:blank") across every hop of it.
    if (requested.pathname === "/redirect") {
      res.writeHead(302, { location: `http://${REDIRECT_TARGET_HOST}:${port}/` });
      res.end();
      return;
    }

    // /authorize is the OAuth code flow: a GET redirect into a host CC routes
    // elsewhere, carrying the parameter that must survive the reopen (F9).
    if (requested.pathname === "/authorize") {
      res.writeHead(302, { location: `http://${IDP_TARGET_HOST}:${port}/callback?code=${OAUTH_CODE}` });
      res.end();
      return;
    }

    // /saml is the POST binding: a form that submits itself to a host CC routes
    // elsewhere. Reopening it would turn the POST into a GET and drop the assertion,
    // which is exactly what CC must decline to do.
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

    // ?link=<url> puts an anchor on the page so a test can CLICK it with a real user
    // gesture: target=_blank by default (the new tab then inherits its opener's
    // container the way a middle-click does, which no scripted tabs.create
    // reproduces), or a plain same-tab link with &same=1.
    const link = params.get("link");
    const target = params.has("same") ? "" : ` target="_blank"`;
    const anchor = link ? `<a id="go"${target} href="${escapeAttr(link)}">go</a>` : "";

    // Reflect the request's Cookie header into a body attribute so an external driver
    // can assert the FIRST request already carried a seeded cookie (F12 wire side).
    const cookie = req.headers.cookie ?? "";

    // Reflect a POST body the same way, so a test can prove an assertion arrived
    // intact rather than being lost to a reopen's GET (F9).
    const respond = (post: string) => {
      const html =
        "<!doctype html><html><head><title>probe-target</title>" +
        // This inline script runs at parse time, AFTER document_start content scripts.
        // If CC's script-injector already set localStorage.cc_script, it's visible here —
        // proving the injected script ran before the page's own scripts (F12 timing).
        "<script>document.documentElement.setAttribute('data-cc-script-at-start', localStorage.getItem('cc_script') || '');</script>" +
        `</head><body data-seen-cookie="${escapeAttr(cookie)}" data-seen-post="${escapeAttr(post)}">ok${anchor}</body></html>`;
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
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
