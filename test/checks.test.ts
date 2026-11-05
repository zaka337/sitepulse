import { describe, expect, it } from "vitest";
import { CHECKS } from "../src/checks/index.js";
import type { Fetched } from "../src/net/fetcher.js";
import { parseCookie, parseCsp } from "../src/checks/security.js";
import { page, run } from "./helpers.js";

/* Each check is a pure function of a made-up page, so each is tested the same way: a table of (page, expected status). */

const status = (id: string, input: Parameters<typeof run>[1]) => run(id, input).status;

/** A fetched answer with only the fields a check reads (the rest of a real one is irrelevant to these checks) */
const answer = (partial: { status: number; body?: string; headers?: Record<string, string> }) => partial as unknown as Fetched;

describe("the catalogue", () => {
  it("has unique ids, a known category, a positive weight and a description for every check", () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHECKS) {
      expect(["security", "seo", "performance", "accessibility", "links"], c.id).toContain(c.category);
      expect(c.weight, c.id).toBeGreaterThan(0);
      expect(c.description.length, c.id).toBeGreaterThan(20);
      expect(c.id.startsWith(c.category === "accessibility" ? "a11y-" : c.category === "performance" ? "perf-" : c.category === "security" ? "sec-" : c.category === "seo" ? "seo-" : "links-"), c.id).toBe(true);
    }
  });

  it("always explains how to fix a warning or a failure", () => {
    // run each check against an empty page, and every warn/fail it gives must carry a fix
    for (const c of CHECKS) {
      const o = run(c.id, { html: page("", "<img src=a.png><input name=x><a href=/x><svg></svg></a><h1>a</h1><h3>b</h3>", ""), url: "http://example.com/", ttfbMs: 5000, encoding: null, bodyBytes: 600_000 });
      if (o.status === "warn" || o.status === "fail") expect(o.fix, c.id).toBeTruthy();
    }
  });
});

describe("security", () => {
  it("sec-https", () => {
    expect(status("sec-https", { url: "https://example.com/" })).toBe("pass");
    expect(status("sec-https", { url: "http://example.com/" })).toBe("fail");
  });

  it.each([
    [undefined, "fail"],
    ["max-age=31536000; includeSubDomains; preload", "pass"],
    ["max-age=31536000", "pass"],
    ["max-age=300", "warn"],
    ["max-age=0", "warn"],
    ["includeSubDomains", "warn"],
  ])("sec-hsts with %s -> %s", (value, expected) => {
    expect(status("sec-hsts", { headers: value ? { "strict-transport-security": value } : {} })).toBe(expected);
  });
  it("sec-hsts does not apply to plain HTTP", () => {
    expect(status("sec-hsts", { url: "http://example.com/" })).toBe("skip");
  });

  it.each([
    [undefined, "warn"],
    ["default-src 'self'", "pass"],
    ["default-src 'self'; script-src 'self' https://cdn.example", "pass"],
    ["script-src 'self' 'unsafe-eval'", "warn"],
    ["script-src 'self' 'unsafe-inline'", "warn"],
    ["script-src 'self' 'unsafe-inline' 'nonce-abc123'", "pass"],
    ["script-src *", "warn"],
    ["img-src 'self'", "warn"], // a policy that does not restrict scripts at all
  ])("sec-csp with %s -> %s", (value, expected) => {
    expect(status("sec-csp", { headers: value ? { "content-security-policy": value } : {} })).toBe(expected);
  });
  it.each([
    ["script-src 'self' 'unsafe-inline'", ["unsafe-inline"], ["unsafe-eval", "*"]],
    ["script-src 'self' 'unsafe-eval'", ["unsafe-eval"], ["unsafe-inline"]],
    ["script-src 'self' 'wasm-unsafe-eval'", [], ["unsafe-eval", "unsafe-inline"]], // WebAssembly only: a narrower permission, not a warning
    ["script-src *", ["from"], ["unsafe-eval", "unsafe-inline"]],
    ["img-src 'self'", ["default-src"], ["unsafe-eval", "unsafe-inline"]],
  ])("sec-csp advice for %s names only the problems found", (value, mentioned, notMentioned) => {
    const o = run("sec-csp", { headers: { "content-security-policy": value } });
    if (mentioned.length === 0) {
      expect(o.status).toBe("pass");
      return;
    }
    expect(o.status).toBe("warn");
    for (const m of mentioned) expect(o.fix, `fix should mention ${m}`).toContain(m);
    for (const n of notMentioned) expect(o.fix, `fix should not mention ${n}`).not.toContain(n);
  });
  it("sec-csp: two problems give two pieces of advice", () => {
    const o = run("sec-csp", { headers: { "content-security-policy": "script-src 'self' 'unsafe-inline' 'unsafe-eval'" } });
    expect(o.fix).toContain("unsafe-eval");
    expect(o.fix).toContain("unsafe-inline");
  });
  it("sec-csp: report-only does not block anything, so it only warns", () => {
    expect(status("sec-csp", { headers: { "content-security-policy-report-only": "default-src 'self'" } })).toBe("warn");
  });

  it("sec-nosniff", () => {
    expect(status("sec-nosniff", { headers: { "x-content-type-options": "nosniff" } })).toBe("pass");
    expect(status("sec-nosniff", {})).toBe("warn");
  });

  it.each([
    [{}, "warn"],
    [{ "x-frame-options": "DENY" }, "pass"],
    [{ "x-frame-options": "SAMEORIGIN" }, "pass"],
    [{ "x-frame-options": "ALLOW-FROM https://x" }, "warn"],
    [{ "content-security-policy": "frame-ancestors 'none'" }, "pass"],
    [{ "content-security-policy": "default-src 'self'" }, "warn"],
  ])("sec-framing with %j -> %s", (headers, expected) => {
    expect(status("sec-framing", { headers: headers as Record<string, string> })).toBe(expected);
  });

  it.each([
    [undefined, "warn"],
    ["strict-origin-when-cross-origin", "pass"],
    ["no-referrer", "pass"],
    ["unsafe-url", "warn"],
    ["no-referrer-when-downgrade", "warn"],
  ])("sec-referrer with %s -> %s", (value, expected) => {
    expect(status("sec-referrer", { headers: value ? { "referrer-policy": value } : {} })).toBe(expected);
  });

  it("sec-permissions", () => {
    expect(status("sec-permissions", { headers: { "permissions-policy": "camera=()" } })).toBe("pass");
    expect(status("sec-permissions", {})).toBe("warn");
  });

  describe("sec-cookies", () => {
    it("skips when there are no cookies", () => expect(status("sec-cookies", {})).toBe("skip"));
    it("passes when every cookie is protected", () => {
      expect(status("sec-cookies", { setCookies: ["theme=dark; Secure; SameSite=Lax; Path=/", "sessionid=abc; Secure; HttpOnly; SameSite=Strict"] })).toBe("pass");
    });
    it("warns about a missing Secure on HTTPS and names the cookie", () => {
      const o = run("sec-cookies", { setCookies: ["theme=dark; SameSite=Lax"] });
      expect(o.status).toBe("warn");
      expect(o.details?.[0]).toContain("theme: missing Secure");
    });
    it("wants HttpOnly on session-like cookies only", () => {
      expect(status("sec-cookies", { setCookies: ["theme=dark; Secure; SameSite=Lax"] })).toBe("pass");
      expect(run("sec-cookies", { setCookies: ["auth_token=x; Secure; SameSite=Lax"] }).details?.[0]).toContain("HttpOnly");
    });
    it("does not ask for Secure on a plain HTTP page", () => {
      expect(status("sec-cookies", { url: "http://example.com/", setCookies: ["a=1; SameSite=Lax"] })).toBe("pass");
    });
  });

  describe("sec-mixed-content", () => {
    it("skips on HTTP pages", () => expect(status("sec-mixed-content", { url: "http://example.com/", html: page() })).toBe("skip"));
    it("passes with https and relative resources", () => {
      expect(status("sec-mixed-content", { html: page('<script src="/a.js"></script><link rel="stylesheet" href="https://x/a.css">', '<img src="/a.png">') })).toBe("pass");
    });
    it("fails on an insecure script, stylesheet, frame or form", () => {
      for (const body of ['<script src="http://x/a.js"></script>', '<iframe src="http://x/"></iframe>', '<form action="http://x/post"></form>']) {
        expect(status("sec-mixed-content", { html: page("", body) }), body).toBe("fail");
      }
      expect(status("sec-mixed-content", { html: page('<link rel="stylesheet" href="http://x/a.css">') })).toBe("fail");
    });
    it("only warns about an insecure image", () => {
      expect(status("sec-mixed-content", { html: page("", '<img src="http://x/a.png">') })).toBe("warn");
    });
  });

  it("sec-server-leak", () => {
    expect(status("sec-server-leak", { headers: { server: "cloudflare" } })).toBe("pass");
    expect(status("sec-server-leak", { headers: { server: "nginx/1.18.0" } })).toBe("warn");
    expect(status("sec-server-leak", { headers: { "x-powered-by": "Express" } })).toBe("warn");
    expect(status("sec-server-leak", {})).toBe("pass");
  });

  it("parseCsp and parseCookie", () => {
    expect(parseCsp("default-src 'self'; img-src * data:")).toEqual({ "default-src": ["'self'"], "img-src": ["*", "data:"] });
    expect(parseCookie("id=1; Path=/; Secure; HttpOnly; SameSite=None")).toEqual({ name: "id", secure: true, httpOnly: true, sameSite: "none" });
    expect(parseCookie("bare")).toEqual({ name: "bare", secure: false, httpOnly: false, sameSite: null });
  });
});

describe("seo", () => {
  it.each([
    [200, "pass"], [204, "pass"], [301, "warn"], [404, "fail"], [500, "fail"], [403, "fail"],
  ])("seo-status %i -> %s", (code, expected) => {
    expect(status("seo-status", { status: code })).toBe(expected);
  });

  it.each([
    ["", "fail"],
    ["<title></title>", "fail"],
    ["<title>Hi</title>", "warn"],
    ["<title>A well sized title for a page</title>", "pass"],
    [`<title>${"A very long title ".repeat(6)}</title>`, "warn"],
    ["<title>  Spread\n   over   lines  but fine  </title>", "pass"],
  ])("seo-title %s -> %s", (head, expected) => {
    expect(status("seo-title", { html: page(head) })).toBe(expected);
  });

  it.each([
    ["", "fail"],
    ['<meta name="description" content="">', "fail"],
    ['<meta name="description" content="Too short.">', "warn"],
    [`<meta name="description" content="${"Right sized ".repeat(8)}">`, "pass"],
    [`<meta name="description" content="${"Far too long ".repeat(20)}">`, "warn"],
    [`<meta name="DESCRIPTION" content="${"Case insensitive ".repeat(5)}">`, "pass"],
  ])("seo-description %# -> %s", (head, expected) => {
    expect(status("seo-description", { html: page(head) })).toBe(expected);
  });

  it("seo-h1: none fails, one passes, several warn", () => {
    expect(status("seo-h1", { html: page("", "<h2>x</h2>") })).toBe("fail");
    expect(status("seo-h1", { html: page("", "<h1>x</h1>") })).toBe("pass");
    expect(status("seo-h1", { html: page("", "<h1>x</h1><h1>y</h1>") })).toBe("warn");
  });

  it("seo-canonical", () => {
    expect(status("seo-canonical", { html: page('<link rel="canonical" href="https://example.com/a">') })).toBe("pass");
    expect(status("seo-canonical", { html: page('<link rel="canonical" href="/a">') })).toBe("pass"); // relative is resolved against the page
    expect(status("seo-canonical", { html: page() })).toBe("warn");
    expect(status("seo-canonical", { html: page('<link rel="canonical" href="javascript:1">') })).toBe("warn");
  });

  it.each([
    [' lang="en"', "pass"], [' lang="en-GB"', "pass"], [' lang="ur"', "pass"], ["", "warn"], [' lang=""', "warn"], [' lang="english"', "warn"],
  ])("seo-lang with <html%s> -> %s", (attrs, expected) => {
    expect(status("seo-lang", { html: page("", "", attrs) })).toBe(expected);
  });

  it.each([
    ["", "fail"],
    ['<meta name="viewport" content="width=device-width, initial-scale=1">', "pass"],
    ['<meta name="viewport" content="width=1024">', "warn"],
  ])("seo-viewport %# -> %s", (head, expected) => {
    expect(status("seo-viewport", { html: page(head) })).toBe(expected);
  });

  it("seo-social needs all three Open Graph tags", () => {
    const og = (t: string, d: string, i: string) => page(`${t && `<meta property="og:title" content="${t}">`}${d && `<meta property="og:description" content="${d}">`}${i && `<meta property="og:image" content="${i}">`}`);
    expect(status("seo-social", { html: og("a", "b", "https://x/i.png") })).toBe("pass");
    expect(run("seo-social", { html: og("a", "", "https://x/i.png") }).message).toContain("og:description");
    expect(status("seo-social", { html: page() })).toBe("warn");
  });

  it("seo-indexable notices noindex in the meta tag and in the header", () => {
    expect(status("seo-indexable", { html: page() })).toBe("pass");
    expect(status("seo-indexable", { html: page('<meta name="robots" content="noindex, nofollow">') })).toBe("warn");
    expect(status("seo-indexable", { html: page(), headers: { "x-robots-tag": "noindex" } })).toBe("warn");
    expect(status("seo-indexable", { html: page('<meta name="robots" content="index, follow">') })).toBe("pass");
  });

  describe("seo-robots-txt", () => {
    const probe = (status: number, body: string) => ({ robots: { ok: true as const, res: answer({ status, body, headers: {} }) } });
    it("skips when not fetched", () => expect(status("seo-robots-txt", {})).toBe("skip"));
    it("warns when unreadable or missing", () => {
      expect(status("seo-robots-txt", { extras: { robots: { ok: false, error: "refused" } } })).toBe("warn");
      expect(status("seo-robots-txt", { extras: probe(404, "") })).toBe("warn");
    });
    it("passes a normal file", () => {
      expect(status("seo-robots-txt", { extras: probe(200, "User-agent: *\nDisallow: /admin/\nSitemap: https://x/sitemap.xml") })).toBe("pass");
    });
    it("fails a file that blocks everything", () => {
      expect(status("seo-robots-txt", { extras: probe(200, "User-agent: *\nDisallow: /\n") })).toBe("fail");
      expect(status("seo-robots-txt", { extras: probe(200, "User-agent: *\r\nDisallow: /") })).toBe("fail");
      expect(status("seo-robots-txt", { extras: probe(200, "User-agent: Googlebot\nDisallow: /private/\n\nUser-agent: *\nDisallow:\n") })).toBe("pass");
    });
    it("warns when robots.txt is really an HTML page", () => {
      expect(status("seo-robots-txt", { extras: probe(200, "<!doctype html><html><body>Not found</body></html>") })).toBe("warn");
    });
  });

  describe("seo-sitemap", () => {
    const probe = (status: number, body: string) => ({ sitemap: { ok: true as const, res: answer({ status, body, headers: {} }) } });
    it("passes a real sitemap and counts its entries", () => {
      const o = run("seo-sitemap", { extras: probe(200, '<?xml version="1.0"?><urlset><url><loc>https://x/</loc></url><url><loc>https://x/a</loc></url></urlset>') });
      expect(o.status).toBe("pass");
      expect(o.message).toContain("2 addresses");
    });
    it("accepts a sitemap index", () => expect(status("seo-sitemap", { extras: probe(200, "<sitemapindex><sitemap><loc>https://x/s1.xml</loc></sitemap></sitemapindex>") })).toBe("pass"));
    it("warns on a missing one, or an HTML page pretending to be one", () => {
      expect(status("seo-sitemap", { extras: probe(404, "") })).toBe("warn");
      expect(status("seo-sitemap", { extras: probe(200, "<html>nope</html>") })).toBe("warn");
      expect(status("seo-sitemap", { extras: { sitemap: { ok: false, error: "no answer" } } })).toBe("warn");
    });
  });

  it("seo-structured-data: absent warns, valid passes, broken JSON fails", () => {
    const ld = (json: string) => page(`<script type="application/ld+json">${json}</script>`);
    expect(status("seo-structured-data", { html: page() })).toBe("warn");
    expect(status("seo-structured-data", { html: ld('{"@context":"https://schema.org","@type":"Person"}') })).toBe("pass");
    expect(status("seo-structured-data", { html: ld('{"@type":"Person",}') })).toBe("fail");
  });

  it("seo-favicon: a declared icon passes; otherwise /favicon.ico is tried", () => {
    expect(status("seo-favicon", { html: page('<link rel="icon" href="/i.png">') })).toBe("pass");
    expect(status("seo-favicon", { html: page('<link rel="shortcut icon" href="/i.png">') })).toBe("pass");
    expect(status("seo-favicon", { html: page(), extras: { favicon: { ok: true, res: answer({ status: 200 }) } } })).toBe("pass");
    expect(status("seo-favicon", { html: page(), extras: { favicon: { ok: true, res: answer({ status: 404 }) } } })).toBe("warn");
  });

  it("content checks skip when the answer is not HTML", () => {
    for (const id of ["seo-title", "seo-description", "seo-h1", "seo-canonical", "seo-lang", "seo-viewport", "seo-social", "seo-structured-data", "a11y-img-alt", "a11y-form-labels", "a11y-link-names", "a11y-headings", "a11y-zoom", "a11y-landmarks"]) {
      expect(status(id, { html: null }), id).toBe("skip");
    }
  });
});

describe("performance", () => {
  it.each([[50, "pass"], [800, "pass"], [801, "warn"], [1800, "warn"], [1801, "fail"], [6000, "fail"]])("perf-ttfb %i ms -> %s", (ms, expected) => {
    expect(status("perf-ttfb", { ttfbMs: ms })).toBe(expected);
  });

  it("perf-compression", () => {
    expect(status("perf-compression", { encoding: "gzip" })).toBe("pass");
    expect(status("perf-compression", { encoding: "br" })).toBe("pass");
    expect(status("perf-compression", { encoding: null, bodyBytes: 50_000 })).toBe("fail");
    expect(status("perf-compression", { encoding: null, bodyBytes: 800 })).toBe("pass"); // too small to matter
    expect(status("perf-compression", { html: null, encoding: null })).toBe("pass");
  });

  it.each([[10_000, false, "pass"], [300_000, false, "pass"], [300_001, false, "warn"], [700_000, false, "warn"], [1_000_000, false, "warn"], [1_000_001, false, "fail"], [1_500_000, true, "fail"]])("perf-html-size %i (truncated %s) -> %s", (bytes, truncated, expected) => {
    expect(status("perf-html-size", { bodyBytes: bytes, truncated })).toBe(expected);
  });

  it("perf-redirects counts the chain", () => {
    const hop = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://x/${i}`, status: 301, location: `https://x/${i + 1}` }));
    expect(status("perf-redirects", { redirects: hop(0) })).toBe("pass");
    expect(status("perf-redirects", { redirects: hop(1) })).toBe("pass");
    expect(status("perf-redirects", { redirects: hop(2) })).toBe("warn");
    expect(status("perf-redirects", { redirects: hop(4) })).toBe("fail");
    expect(run("perf-redirects", { redirects: hop(2) }).details).toHaveLength(2);
  });
});

describe("accessibility", () => {
  it("a11y-img-alt", () => {
    expect(status("a11y-img-alt", { html: page("", "<p>no images</p>") })).toBe("skip");
    expect(status("a11y-img-alt", { html: page("", '<img src="a" alt="A"><img src="b" alt="">') })).toBe("pass"); // empty alt = decorative: fine
    expect(status("a11y-img-alt", { html: page("", '<img src="a" alt="A"><img src="b" alt="B"><img src="c" alt="C"><img src="d" alt="D"><img src="e">') })).toBe("warn");
    expect(status("a11y-img-alt", { html: page("", '<img src="a"><img src="b">') })).toBe("fail");
    expect(status("a11y-img-alt", { html: page("", '<img src="a" alt="A"><img src="b" role="presentation">') })).toBe("pass");
  });

  describe("a11y-form-labels", () => {
    it("skips a page with no fields, and ignores buttons and hidden fields", () => {
      expect(status("a11y-form-labels", { html: page() })).toBe("skip");
      expect(status("a11y-form-labels", { html: page("", '<input type="submit"><input type="hidden" name="t"><button>Go</button>') })).toBe("skip");
    });
    it("accepts every way of labelling a field", () => {
      const ok = ['<label for="a">A</label><input id="a">', "<label>B <input></label>", '<input aria-label="C">', '<span id="s">D</span><input aria-labelledby="s">', '<input title="E">', '<label for="sel">F</label><select id="sel"></select>', '<label for="t">G</label><textarea id="t"></textarea>'];
      for (const f of ok) expect(status("a11y-form-labels", { html: page("", f) }), f).toBe("pass");
    });
    it("fails fields with only a placeholder", () => {
      const o = run("a11y-form-labels", { html: page("", '<input name="email" placeholder="Email"><input id="x"><label for="y">Y</label><input id="y">') });
      expect(o.status).toBe("fail");
      expect(o.message).toContain("2 of 3");
    });
  });

  it("a11y-link-names", () => {
    expect(status("a11y-link-names", { html: page("", "<p>none</p>") })).toBe("skip");
    expect(status("a11y-link-names", { html: page("", '<a href="/a">Text</a><button>Go</button><a href="/b" aria-label="Open"></a><a href="/c"><img src=x alt="Logo"></a><a href="/d" title="Docs"></a>') })).toBe("pass");
    expect(status("a11y-link-names", { html: page("", '<a href="/a"></a>') })).toBe("warn");
    expect(status("a11y-link-names", { html: page("", '<button><svg><path d="M0"/></svg></button>') })).toBe("warn");
    expect(status("a11y-link-names", { html: page("", '<button><svg><title>Close</title></svg></button>') })).toBe("pass");
  });

  it("a11y-headings", () => {
    expect(status("a11y-headings", { html: page("", "<p>none</p>") })).toBe("skip");
    expect(status("a11y-headings", { html: page("", "<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>") })).toBe("pass");
    expect(status("a11y-headings", { html: page("", "<h1>a</h1><h3>c</h3>") })).toBe("warn");
    expect(status("a11y-headings", { html: page("", "<h2>a</h2><h3>b</h3>") })).toBe("pass");
  });

  it.each([
    ["width=device-width, initial-scale=1", "pass"],
    ["width=device-width, initial-scale=1, maximum-scale=5", "pass"],
    ["width=device-width, user-scalable=no", "fail"],
    ["width=device-width, maximum-scale=1", "fail"],
    ["width=device-width, user-scalable=0", "fail"],
  ])("a11y-zoom %s -> %s", (v, expected) => {
    expect(status("a11y-zoom", { html: page(`<meta name="viewport" content="${v}">`) })).toBe(expected);
  });

  it("a11y-landmarks", () => {
    expect(status("a11y-landmarks", { html: page("", "<main>x</main>") })).toBe("pass");
    expect(status("a11y-landmarks", { html: page("", '<div role="main">x</div>') })).toBe("pass");
    expect(status("a11y-landmarks", { html: page("", "<div>x</div>") })).toBe("warn");
  });
});

describe("links", () => {
  const link = (kind: "ok" | "broken" | "blocked" | "skipped", status: number | null = null, url = "https://x/a") => ({ url, internal: true, status, kind, note: kind });
  it("skips when links were not checked or there are none", () => {
    expect(status("links-broken", {})).toBe("skip");
    expect(status("links-broken", { extras: { links: [] } })).toBe("skip");
  });
  it("passes when nothing is broken, and says what could not be verified", () => {
    const o = run("links-broken", { extras: { links: [link("ok", 200), link("blocked", 403), link("skipped")] } });
    expect(o.status).toBe("pass");
    expect(o.message).toContain("could not be verified");
    expect(o.message).toContain("skipped");
  });
  it("warns for one or two broken links and fails for three or a quarter", () => {
    const ok = Array.from({ length: 10 }, () => link("ok", 200));
    expect(status("links-broken", { extras: { links: [...ok, link("broken", 404)] } })).toBe("warn");
    expect(status("links-broken", { extras: { links: [...ok, link("broken", 404), link("broken", 500)] } })).toBe("warn");
    expect(status("links-broken", { extras: { links: [...ok, link("broken", 404), link("broken", 500), link("broken", null)] } })).toBe("fail");
    expect(status("links-broken", { extras: { links: [link("ok", 200), link("broken", 404)] } })).toBe("fail"); // half of them
  });
  it("lists the broken links with their status", () => {
    const o = run("links-broken", { extras: { links: [link("broken", 404, "https://x/gone")] } });
    expect(o.details?.[0]).toContain("404");
    expect(o.details?.[0]).toContain("https://x/gone");
  });
});
