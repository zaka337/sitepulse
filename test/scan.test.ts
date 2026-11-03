import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHECKS } from "../src/checks/index.js";
import { parseHtml } from "../src/html.js";
import { fetchUrl } from "../src/net/fetcher.js";
import { pickLinks, probeLinks } from "../src/probe.js";
import { describeNetworkError, scan } from "../src/scan.js";
import { ScanError } from "../src/types.js";
import { GOOD_HTML, startFixture, type Fixture } from "./fixtures/server.js";

/* The whole scan, end to end, against a real local web server. Everything here passes allowPrivate because the
   server lives on loopback; "127.0.0.1" plays the part of the site and "localhost" the part of an outside site. */

let site: Fixture;
const HTML = { "content-type": "text/html; charset=utf-8" };
const SECURE = { ...HTML, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

beforeAll(async () => {
  site = await startFixture({
    "/": () => ({ headers: SECURE, body: GOOD_HTML.replace("</main>", `<a href="${site.altUrl}/elsewhere">Elsewhere</a></main>`) }),
    "/about": { headers: HTML, body: "<h1>About</h1>" },
    "/elsewhere": { headers: HTML, body: "<h1>Elsewhere</h1>" },
    "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /admin/\n" },
    "/sitemap.xml": { headers: { "content-type": "application/xml" }, body: "<urlset><url><loc>https://example.com/</loc></url></urlset>" },
    "/bad": { headers: HTML, body: "<p>hi</p><img src=a.png><a href=/x></a>" },
    "/old": { status: 301, headers: { location: "/" } },
    "/data.json": { headers: { "content-type": "application/json" }, body: '{"hello":"world"}' },
    "/huge": { headers: HTML, body: `<!doctype html><html lang="en"><head><title>A big page with a good title</title></head><body>${"<p>filler text</p>".repeat(100_000)}</body></html>` },
    "/slow": { delayMs: 2000, headers: HTML, body: "late" },
    "/to-refused-port": { status: 302, headers: { location: "http://127.0.0.1:9/" } },
  });
});
afterAll(() => site.close());
afterEach(() => vi.restoreAllMocks());

const local = { allowPrivate: true } as const;
const scanSite = (path = "/", o: Parameters<typeof scan>[1] = {}) => scan(site.url + path, { ...local, ...o });
const status = (r: Awaited<ReturnType<typeof scan>>, id: string) => r.results.find((x) => x.id === id)?.status;

describe("a scan of a good page", () => {
  it("runs every check and returns a complete, consistent report", async () => {
    const r = await scanSite();
    expect(r.results).toHaveLength(CHECKS.length);
    expect(r.results.map((x) => x.id)).toEqual(CHECKS.map((c) => c.id));
    expect(r.url).toBe(`${site.url}/`);
    expect(r.finalUrl).toBe(`${site.url}/`);
    expect(new Date(r.scannedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(r.durationMs).toBeGreaterThan(0);
    expect(r.score).toBeGreaterThan(50);
    expect(["A", "B", "C", "D", "F"]).toContain(r.grade);
    // the summary adds up to the number of results, and every category score exists
    expect(r.summary.pass + r.summary.warn + r.summary.fail + r.summary.skip).toBe(r.results.length);
    expect(Object.keys(r.categories).sort()).toEqual(["accessibility", "links", "performance", "security", "seo"]);
    expect(r.notes).toEqual([]);
  });

  it("finds what is right and what is wrong", async () => {
    const r = await scanSite();
    expect(status(r, "seo-title")).toBe("pass");
    expect(status(r, "seo-description")).toBe("pass");
    expect(status(r, "a11y-img-alt")).toBe("pass");
    expect(status(r, "a11y-form-labels")).toBe("pass");
    expect(status(r, "sec-nosniff")).toBe("pass");
    expect(status(r, "seo-robots-txt")).toBe("pass");
    expect(status(r, "seo-sitemap")).toBe("pass");
    expect(status(r, "links-broken")).toBe("pass");
    expect(status(r, "sec-https")).toBe("fail"); // the fixture is plain http
    expect(status(r, "sec-hsts")).toBe("skip");
  });

  it("fetches robots.txt, the sitemap and a sample of the links, but not what it does not need", async () => {
    const from = site.hits.length;
    await scanSite();
    const hits = site.hits.slice(from);
    expect(hits).toContain("GET /");
    expect(hits).toContain("GET /robots.txt");
    expect(hits).toContain("GET /sitemap.xml");
    expect(hits).toContain("HEAD /about");
    expect(hits).toContain("HEAD /elsewhere");
    expect(hits).not.toContain("HEAD /favicon.ico"); // the page declares its icon, so no guessing
  });

  it("tries /favicon.ico only when the page declares no icon", async () => {
    const from = site.hits.length;
    await scanSite("/bad");
    expect(site.hits.slice(from)).toContain("HEAD /favicon.ico");
  });

  it("follows a redirect and reports where it ended up", async () => {
    const r = await scanSite("/old");
    expect(r.url).toBe(`${site.url}/old`);
    expect(r.finalUrl).toBe(`${site.url}/`);
    expect(status(r, "perf-redirects")).toBe("pass");
  });

  it("accepts an address without the scheme, as people type it: it assumes https", async () => {
    // (this server only speaks plain http, so the https attempt fails: a failed page in the report, not a thrown error)
    const r = await scan(`127.0.0.1:${site.port}/data.json`, { ...local });
    expect(r.url).toBe(`https://127.0.0.1:${site.port}/data.json`);
    expect(r.results[0]).toMatchObject({ id: "seo-status", status: "fail" });
  }, 15000);
});

describe("a poor page scores worse, with reasons", () => {
  it("fails the basics and says how to fix them", async () => {
    const good = await scanSite();
    const bad = await scanSite("/bad");
    expect(bad.score).toBeLessThan(good.score);
    expect(status(bad, "seo-title")).toBe("fail");
    expect(status(bad, "seo-h1")).toBe("fail");
    expect(status(bad, "a11y-img-alt")).toBe("fail");
    expect(status(bad, "a11y-link-names")).toBe("warn");
    for (const x of bad.results.filter((y) => y.status === "warn" || y.status === "fail")) expect(x.fix, x.id).toBeTruthy();
  });
});

describe("options", () => {
  it("runs only the categories asked for", async () => {
    const from = site.hits.length;
    const r = await scanSite("/", { categories: ["seo"] });
    expect(r.results.length).toBeGreaterThan(5);
    expect(r.results.every((x) => x.category === "seo")).toBe(true);
    expect(r.categories.security.score).toBeNull(); // nothing ran there
    expect(site.hits.slice(from).some((h) => h.startsWith("HEAD"))).toBe(false); // so the links were not touched
  });

  it("does no link checking with maxLinks 0", async () => {
    const from = site.hits.length;
    const r = await scanSite("/", { maxLinks: 0 });
    expect(status(r, "links-broken")).toBe("skip");
    expect(site.hits.slice(from).some((h) => h.startsWith("HEAD"))).toBe(false);
  });

  it("keeps maxLinks within 0 to 30", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("");
    const f = await startFixture({ "/": { headers: HTML, body: `<!doctype html><html lang="en"><body><main>${many}</main></body></html>` }, "*": { headers: HTML, body: "ok" } });
    try {
      await scan(f.url, { ...local, maxLinks: 500 });
      expect(f.hits.filter((h) => h.startsWith("HEAD /p")).length).toBe(30);
    } finally {
      await f.close();
    }
  });

  it("does not ask a host for the sitemap after the same host just failed to answer for robots.txt", async () => {
    const f = await startFixture({ "/": { headers: HTML, body: GOOD_HTML }, "/robots.txt": { destroy: true }, "/sitemap.xml": { headers: { "content-type": "application/xml" }, body: "<urlset><url><loc>https://x/</loc></url></urlset>" } });
    try {
      const r = await scan(f.url, { ...local, maxLinks: 0 });
      expect(status(r, "seo-robots-txt")).toBe("warn");
      expect(status(r, "seo-sitemap")).toBe("warn"); // reported as unreadable, with the same reason, rather than waiting out another timeout
      expect(f.hits).not.toContain("GET /sitemap.xml");
    } finally {
      await f.close();
    }
  });

  it("looks for the sitemap where robots.txt says it is", async () => {
    const f = await startFixture({
      "/": () => ({ headers: HTML, body: GOOD_HTML }),
      "/robots.txt": () => ({ headers: { "content-type": "text/plain" }, body: `User-agent: *\nSitemap: ${f.url}/maps/custom.xml\n` }),
      "/maps/custom.xml": { headers: { "content-type": "application/xml" }, body: "<urlset><url><loc>https://x/</loc></url></urlset>" },
    });
    try {
      const r = await scan(f.url, { ...local, maxLinks: 0 });
      expect(status(r, "seo-sitemap")).toBe("pass");
      expect(f.hits).toContain("GET /maps/custom.xml");
      expect(f.hits).not.toContain("GET /sitemap.xml");
    } finally {
      await f.close();
    }
  });
});

describe("links", () => {
  it("separates broken links from ones that merely refuse robots, and retries GET when HEAD is not allowed", async () => {
    const f = await startFixture({
      "/": () => ({ headers: HTML, body: `<!doctype html><html lang="en"><body><main><a href="/ok">ok</a><a href="/gone">gone</a><a href="/forbidden">forbidden</a><a href="/boom">boom</a><a href="/nohead">nohead</a></main></body></html>` }),
      "/ok": { headers: HTML, body: "ok" },
      "/gone": { status: 404, headers: HTML, body: "no" },
      "/forbidden": { status: 403, headers: HTML, body: "no" },
      "/boom": { status: 500, headers: HTML, body: "no" },
      "/nohead": (req) => (req.method === "HEAD" ? { status: 405, headers: HTML } : { headers: HTML, body: "fine" }),
    });
    try {
      const r = await scan(f.url, { ...local });
      const links = r.results.find((x) => x.id === "links-broken")!;
      const text = (links.details ?? []).join("\n");
      expect(text).toContain("/gone");
      expect(text).toContain("404");
      expect(text).toContain("/boom");
      expect(text).not.toContain("/forbidden");
      expect(text).not.toContain("/nohead");
      expect(text).not.toContain("/ok");
      expect(links.message).toContain("could not be verified");
      expect(f.hits).toContain("GET /nohead");
    } finally {
      await f.close();
    }
  });

  it("a dead external link is reported, not fatal", async () => {
    const dead = await startFixture({});
    const deadUrl = dead.altUrl;
    await dead.close();
    const f = await startFixture({ "/": { headers: HTML, body: `<!doctype html><html lang="en"><body><main><a href="${deadUrl}/x">gone host</a></main></body></html>` } });
    try {
      const r = await scan(f.url, { ...local });
      const links = r.results.find((x) => x.id === "links-broken")!;
      expect(links.status).not.toBe("pass");
      expect((links.details ?? []).join()).toContain("connection refused");
    } finally {
      await f.close();
    }
  });

  describe("pickLinks", () => {
    const html = (...a: string[]) => parseHtml(`<body>${a.join("")}</body>`);
    const urls = (r: ReturnType<typeof pickLinks>) => r.map((x) => x.url);

    it("ignores fragments, mail, phone, script and duplicate links, and resolves relative ones", () => {
      const root = html('<a href="#top">t</a>', '<a href="mailto:a@b.co">m</a>', '<a href="tel:1">t</a>', '<a href="javascript:void 0">j</a>', '<a href="">e</a>', '<a href="/a">1</a>', '<a href="/a#x">2</a>', '<a href="a2">3</a>', '<a href="https://other.example/p">4</a>');
      expect(urls(pickLinks(root, "https://site.example/dir/", 10))).toEqual(["https://site.example/a", "https://site.example/dir/a2", "https://other.example/p"]);
    });

    it("treats www and non-www as the same site, and prefers the site's own links", () => {
      const root = html(...Array.from({ length: 10 }, (_, i) => `<a href="https://www.site.example/i${i}">i</a>`), ...Array.from({ length: 10 }, (_, i) => `<a href="https://x${i}.example/">x</a>`));
      const picked = pickLinks(root, "https://site.example/", 10);
      expect(picked).toHaveLength(10);
      expect(picked.filter((p) => p.internal)).toHaveLength(6);
    });

    it("fills up with the site's own links when there are not enough outside ones", () => {
      const root = html(...Array.from({ length: 10 }, (_, i) => `<a href="/i${i}">i</a>`));
      expect(pickLinks(root, "https://site.example/", 8)).toHaveLength(8);
    });

    it("never returns more than asked for, and nothing for 0", () => {
      const root = html('<a href="/a">a</a><a href="/b">b</a>');
      expect(pickLinks(root, "https://site.example/", 1)).toHaveLength(1);
      expect(pickLinks(root, "https://site.example/", 0)).toEqual([]);
    });
  });

  it("a page cannot make the scanner touch private addresses by linking to them", async () => {
    // (the default guard, no allowPrivate: these must be classified without any request being made)
    const root = parseHtml(
      `<body>${["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/admin", "http://localhost/", "http://[::1]/", "http://2130706433/", "http://internal.corp/", "http://example.com:6379/"].map((u) => `<a href="${u}">x</a>`).join("")}</body>`,
    );
    const res = await probeLinks(root, "https://public.example/", 10, (url, extra) => fetchUrl(url, extra));
    expect(res).toHaveLength(7);
    for (const l of res) expect(l.kind, l.url).toBe("skipped");
  });
});

describe("pages that are not ordinary", () => {
  it("handles an answer that is not HTML: says so, skips the content checks, still scores", async () => {
    const r = await scanSite("/data.json");
    expect(r.notes.join()).toContain("application/json");
    expect(r.notes.join()).toContain("page-content checks were skipped");
    expect(status(r, "seo-title")).toBe("skip");
    expect(status(r, "a11y-img-alt")).toBe("skip");
    expect(status(r, "perf-ttfb")).toBe("pass");
  });

  it("reads only the first part of an enormous page and says so", async () => {
    const r = await scanSite("/huge");
    expect(r.notes.join()).toContain("larger than the scan reads");
    expect(status(r, "perf-html-size")).toBe("fail");
    expect(status(r, "seo-title")).toBe("pass"); // the head was in the part that was read
  }, 20000);

  it("reports a site that cannot be reached as a failed page, not as a crash", async () => {
    const dead = await startFixture({});
    const url = dead.url;
    await dead.close();
    const r = await scan(url, { ...local });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ id: "seo-status", status: "fail" });
    expect(r.results[0]!.message).toContain("refused the connection");
    expect(r.score).toBe(0);
    expect(r.grade).toBe("F");
    expect(r.notes[0]).toMatch(/^The scan stopped/);
  });

  it("reports a site that is too slow as a failed page, with the limit in the message", async () => {
    const t0 = Date.now();
    const r = await scanSite("/slow", { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.results[0]!.message).toContain("300 ms");
  });

  it("survives a check that throws, and says which one", async () => {
    const victim = CHECKS.find((c) => c.id === "seo-title")!;
    vi.spyOn(victim, "run").mockImplementation(() => { throw new Error("boom"); });
    const r = await scanSite("/", { maxLinks: 0 });
    expect(status(r, "seo-title")).toBe("skip");
    expect(r.results).toHaveLength(CHECKS.length);
    expect(r.notes.join()).toContain("seo-title");
    expect(r.notes.join()).toContain("boom");
    expect(status(r, "seo-description")).toBe("pass"); // the others carried on
  });
});

describe("describeNetworkError turns system error codes into plain sentences", () => {
  const msg = (code: string) => describeNetworkError(Object.assign(new Error("x"), { code }));
  it.each(["ENOTFOUND", "ENODATA", "ENOENT", "EAI_NONAME"])("%s means the name does not exist", (code) => {
    expect(msg(code).message).toContain("name does not exist");
  });
  it("recognises the common failures", () => {
    expect(msg("ECONNREFUSED").message).toContain("refused");
    expect(msg("ECONNRESET").message).toContain("reset");
    expect(msg("ETIMEDOUT").message).toContain("could not be reached");
  });
  it("marks certificate problems, so the report can fail the HTTPS check too", () => {
    for (const code of ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) expect(msg(code).tls, code).toBe(true);
    expect(msg("ECONNREFUSED").tls).toBe(false);
  });
  it("does not leak a long internal message", () => {
    expect(describeNetworkError(new Error("y".repeat(500))).message.length).toBeLessThanOrEqual(120);
  });
});

describe("the safety rules hold for the whole scan", () => {
  it("refuses a private address by default, before any request", async () => {
    const from = site.hits.length;
    await expect(scan(site.url, { allowedPorts: [site.port] })).rejects.toMatchObject({ code: "blocked-address" });
    await expect(scan(site.url)).rejects.toMatchObject({ code: "port-not-allowed" });
    await expect(scan(site.altUrl, { allowedPorts: [site.port] })).rejects.toMatchObject({ code: "blocked-host" });
    expect(site.hits.length).toBe(from);
  });

  it.each([
    ["file:///etc/passwd", "bad-protocol"],
    ["http://169.254.169.254/latest/meta-data/", "blocked-address"],
    ["http://[::1]/", "blocked-address"],
    ["http://2130706433/", "blocked-address"],
    ["http://user:pw@example.com/", "credentials-in-url"],
    ["http://example.com:22/", "port-not-allowed"],
    ["", "invalid-url"],
  ])("throws for %s", async (url, code) => {
    const err = await scan(url).catch((e) => e);
    expect(err).toBeInstanceOf(ScanError);
    expect(err.code).toBe(code);
  });

  it("a redirect to a refused place is thrown, not scanned", async () => {
    await expect(scanSite("/to-refused-port", { allowedPorts: [site.port] })).rejects.toMatchObject({ code: "port-not-allowed" });
  });

  it("a cancelled scan is an error, not a failed page", async () => {
    const ctl = new AbortController();
    const p = scanSite("/slow", { signal: ctl.signal, timeoutMs: 5000 });
    setTimeout(() => ctl.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});
