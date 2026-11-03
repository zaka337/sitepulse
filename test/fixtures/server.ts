import http from "node:http";
import type { AddressInfo } from "node:net";

/* A tiny configurable web server for the tests: each path answers with whatever the test says (status, headers, body,
   delay), and every request is recorded. It listens on all interfaces (IPv4 and IPv6), so both 127.0.0.1 and "localhost"
   reach it, which lets a test treat one name as "the site" and the other as "an external site". */

export interface Route {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  /** Wait this long before answering (to test timeouts) */
  delayMs?: number;
  /** Drop the connection without answering (to test resets) */
  destroy?: boolean;
}
export type Routes = Record<string, Route | ((req: http.IncomingMessage) => Route)>;

export interface Fixture {
  /** http://127.0.0.1:port */
  url: string;
  /** http://localhost:port (the same server under another name) */
  altUrl: string;
  port: number;
  /** "GET /path" for every request received */
  hits: string[];
  close(): Promise<void>;
}

export async function startFixture(routes: Routes): Promise<Fixture> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    hits.push(`${req.method} ${path}`);
    const entry = routes[path] ?? routes["*"];
    const r: Route = typeof entry === "function" ? entry(req) : entry ?? { status: 404, headers: { "content-type": "text/html" }, body: "<h1>Not found</h1>" };
    if (r.destroy) return void req.socket.destroy();
    const send = () => {
      res.writeHead(r.status ?? 200, r.headers ?? { "content-type": "text/html; charset=utf-8" });
      res.end(r.body ?? "");
    };
    if (r.delayMs) setTimeout(send, r.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    altUrl: `http://localhost:${port}`,
    port,
    hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** A page that passes nearly every content check (the tests then break one thing at a time) */
export const GOOD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>A good page about testing things well</title>
  <meta name="description" content="A page that is written well, with a title, a description, headings, labelled forms and working links, used as the reference in the tests.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="https://example.com/">
  <link rel="icon" href="/icon.png">
  <meta property="og:title" content="A good page"><meta property="og:description" content="Described"><meta property="og:image" content="https://example.com/og.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Fixture"}</script>
</head>
<body>
  <main>
    <h1>A good page</h1>
    <h2>Section</h2>
    <img src="/pic.png" alt="A picture of something">
    <form><label for="q">Search</label><input id="q" name="q"><button type="submit">Go</button></form>
    <a href="/about">About</a>
  </main>
</body>
</html>`;
