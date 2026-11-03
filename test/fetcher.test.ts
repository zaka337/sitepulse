import { afterAll, beforeAll, describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { fetchUrl } from "../src/net/fetcher.js";
import { ScanError } from "../src/types.js";
import { startFixture, type Fixture } from "./fixtures/server.js";

/* The fetcher against a real local server. Every test passes allowPrivate because the fixture lives on loopback;
   the tests of what happens WITHOUT it are at the end. */

let fx: Fixture;
const bomb = zlib.gzipSync(Buffer.alloc(80_000_000)); // 80 MB of zeros that is about 80 KB on the wire
const big = "x".repeat(3_000_000);

beforeAll(async () => {
  fx = await startFixture({
    "/": { headers: { "content-type": "text/html; charset=utf-8", "x-custom": "yes", "set-cookie": ["a=1; Secure", "b=2; HttpOnly"] }, body: "<h1>hello</h1>" },
    "/r1": { status: 301, headers: { location: "/r2" } },
    "/r2": { status: 302, headers: { location: "/" } },
    "/loop": { status: 302, headers: { location: "/loop" } },
    "/to-other-port": { status: 302, headers: { location: "http://127.0.0.1:9/" } },
    "/big": { headers: { "content-type": "text/html" }, body: big },
    "/gzip": { headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: zlib.gzipSync("<p>zipped hello</p>") },
    "/br": { headers: { "content-type": "text/html", "content-encoding": "br" }, body: zlib.brotliCompressSync("<p>brotli hello</p>") },
    "/bomb": { headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: bomb },
    "/slow": { delayMs: 2000, body: "late" },
    "/image": { headers: { "content-type": "image/png" }, body: Buffer.from("not really a png") },
    "/json": { headers: { "content-type": "application/json" }, body: '{"ok":true}' },
  });
});
afterAll(() => fx.close());

const get = (path: string, opts: Parameters<typeof fetchUrl>[1] = {}) => fetchUrl(fx.url + path, { allowPrivate: true, ...opts });

describe("a plain request", () => {
  it("returns status, lower-cased headers, body, content type and timings", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${fx.url}/`);
    expect(r.headers["x-custom"]).toBe("yes");
    expect(r.contentType).toContain("text/html");
    expect(r.body).toBe("<h1>hello</h1>");
    expect(r.bodyBytes).toBe(14);
    expect(r.truncated).toBe(false);
    expect(r.ttfbMs).toBeGreaterThan(0);
    expect(r.totalMs).toBeGreaterThanOrEqual(r.ttfbMs);
  });

  it("keeps cookies apart from the other headers (a response can set several)", async () => {
    const r = await get("/");
    expect(r.setCookies).toEqual(["a=1; Secure", "b=2; HttpOnly"]);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("sends an honest User-Agent and no cookies", async () => {
    const seen: string[] = [];
    const f = await startFixture({ "/": (req) => { seen.push(String(req.headers["user-agent"]), String(req.headers["cookie"])); return { body: "ok" }; } });
    await fetchUrl(`${f.url}/`, { allowPrivate: true });
    await f.close();
    expect(seen[0]).toMatch(/^sitepulse\/[\d.]+ \(\+https:\/\/github\.com\/zaka337\/sitepulse\)$/);
    expect(seen[1]).toBe("undefined");
  });

  it("does not read a body for HEAD, or for answers that are not text", async () => {
    expect((await get("/", { method: "HEAD" })).body).toBe("");
    const img = await get("/image");
    expect(img.status).toBe(200);
    expect(img.body).toBe("");
    expect((await get("/json")).body).toBe('{"ok":true}');
  });
});

describe("redirects", () => {
  it("follows them and records the chain", async () => {
    const r = await get("/r1");
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${fx.url}/`);
    expect(r.redirects.map((h) => [h.status, new URL(h.url).pathname])).toEqual([[301, "/r1"], [302, "/r2"]]);
  });

  it("can be told not to follow", async () => {
    const r = await get("/r1", { follow: false });
    expect(r.status).toBe(301);
    expect(r.headers["location"]).toBe("/r2");
    expect(r.redirects).toEqual([]);
  });

  it("gives up on a loop after the maximum number of redirects", async () => {
    await expect(get("/loop", { maxRedirects: 3 })).rejects.toMatchObject({ code: "too-many-redirects" });
  });

  it("checks every hop: a redirect to a port that is not allowed is refused", async () => {
    await expect(get("/to-other-port", { allowedPorts: [fx.port] })).rejects.toMatchObject({ code: "port-not-allowed" });
  });
});

describe("limits", () => {
  it("stops reading a huge page at the cap and says it was truncated", async () => {
    const r = await get("/big", { maxBytes: 100_000 });
    expect(r.truncated).toBe(true);
    expect(r.bodyBytes).toBe(100_000);
    expect(r.body.length).toBe(100_000);
  });

  it("decodes gzip and brotli, and reports which was used", async () => {
    const g = await get("/gzip");
    expect(g.body).toBe("<p>zipped hello</p>");
    expect(g.encoding).toBe("gzip");
    const b = await get("/br");
    expect(b.body).toBe("<p>brotli hello</p>");
    expect(b.encoding).toBe("br");
  });

  it("survives a compression bomb: 80 MB when unpacked, but only 1 MB is ever kept", async () => {
    const before = process.memoryUsage().heapUsed;
    const r = await get("/bomb", { maxBytes: 1_000_000 });
    expect(r.truncated).toBe(true);
    expect(r.bodyBytes).toBe(1_000_000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(40_000_000);
  });

  it("gives up on a server that is too slow", async () => {
    const t0 = Date.now();
    await expect(get("/slow", { timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("can be cancelled", async () => {
    const ctl = new AbortController();
    const p = get("/slow", { signal: ctl.signal, timeoutMs: 5000 });
    setTimeout(() => ctl.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("without allowPrivate (the default)", () => {
  it("refuses to connect to the machine it runs on, by number or by name", async () => {
    // (the port is allowed here so that it is the address, not the port, that gets refused)
    const open = { allowedPorts: [fx.port] };
    await expect(fetchUrl(`http://127.0.0.1:${fx.port}/`, open)).rejects.toMatchObject({ code: "blocked-address" });
    await expect(fetchUrl(`http://localhost:${fx.port}/`, open)).rejects.toMatchObject({ code: "blocked-host" });
    // and with the default ports the odd port refuses it first
    await expect(fetchUrl(`http://127.0.0.1:${fx.port}/`)).rejects.toBeInstanceOf(ScanError);
  });

  it("never touches the server when refusing", async () => {
    const before = fx.hits.length;
    await fetchUrl(`http://127.0.0.1:${fx.port}/secret`).catch(() => undefined);
    expect(fx.hits.length).toBe(before);
  });

  it("refuses a public-looking name that resolves to a private address (DNS rebinding), before connecting", async () => {
    const before = fx.hits.length;
    const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(fetchUrl("http://rebind.example/", { resolver })).rejects.toMatchObject({ code: "blocked-address" });
    expect(fx.hits.length).toBe(before);
  });
});

describe("network failures", () => {
  it("reports a closed port as a connection error", async () => {
    const f = await startFixture({});
    const url = f.url;
    await f.close();
    await expect(fetchUrl(`${url}/`, { allowPrivate: true })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
