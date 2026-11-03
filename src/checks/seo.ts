import { absolute, clean, linksWithRel, meta } from "../html.js";
import { fail, pass, skip, warn, type CheckDef, type Ctx } from "./types.js";

const needsHtml = (c: Ctx) => (c.root ? null : skip("The address did not return an HTML page."));

export const seoChecks: CheckDef[] = [
  {
    id: "seo-status",
    category: "seo",
    title: "Page loads (HTTP 200)",
    description: "Whether the address answers with a normal page. Error pages and broken redirects do not rank and send visitors away.",
    weight: 6,
    run: (c) => {
      const s = c.page.status;
      if (s >= 200 && s < 300) return pass(`The page answers ${s} ${c.page.statusText}`.trim() + ".");
      if (s >= 300 && s < 400) return warn(`The address ends in a redirect (${s}) that could not be followed to a page.`, "Make the redirect point at a page that answers 200.");
      return fail(`The page answers ${s} ${c.page.statusText}`.trim() + ".", s === 404 ? "Check the address, or restore or redirect the missing page." : "Fix the server error or the permission problem for this address.");
    },
  },
  {
    id: "seo-title",
    category: "seo",
    title: "Page title",
    description: "The <title> is the headline in search results and browser tabs. Around 10 to 60 characters shows in full.",
    weight: 5,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const t = clean(c.root!.querySelector("title")?.text);
      if (!t) return fail("The page has no <title>.", "Add a short, specific <title> that says what the page is.");
      if (t.length < 10) return warn(`The title is very short (${t.length} characters): "${t}".`, "Make it more descriptive, around 30 to 60 characters.");
      if (t.length > 60) return warn(`The title is ${t.length} characters, so search results will cut it off.`, "Shorten it to about 60 characters, key words first.");
      return pass(`The title is ${t.length} characters: "${t}".`);
    },
  },
  {
    id: "seo-description",
    category: "seo",
    title: "Meta description",
    description: "The summary search engines often show under the title. About 70 to 160 characters fits.",
    weight: 5,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const d = clean(meta(c.root!, "description"));
      if (!d) return fail("There is no meta description.", "Add `<meta name=\"description\" content=\"...\">` with one clear sentence or two about the page.");
      if (d.length < 50) return warn(`The description is short (${d.length} characters).`, "Write 70 to 160 characters that explain what the page offers.");
      if (d.length > 170) return warn(`The description is ${d.length} characters and will be cut off.`, "Shorten it to about 160 characters.");
      return pass(`The description is ${d.length} characters.`);
    },
  },
  {
    id: "seo-h1",
    category: "seo",
    title: "One main heading (h1)",
    description: "A page should have a single h1 that says what it is about. It helps search engines and screen reader users find the point.",
    weight: 3,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const hs = c.root!.querySelectorAll("h1");
      if (hs.length === 0) return fail("The page has no <h1>.", "Add one <h1> that names the page.");
      if (hs.length > 1) return warn(`The page has ${hs.length} <h1> elements.`, "Use one <h1> and make the others <h2> or lower.", hs.slice(0, 5).map((h) => clean(h.text).slice(0, 80)));
      return pass(`One <h1>: "${clean(hs[0]!.text).slice(0, 80)}".`);
    },
  },
  {
    id: "seo-canonical",
    category: "seo",
    title: "Canonical address",
    description: "A <link rel=canonical> tells search engines which address is the real one when the same page is reachable several ways.",
    weight: 3,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const l = linksWithRel(c.root!, "canonical")[0];
      const href = l?.getAttribute("href");
      if (!href) return warn("No canonical link.", "Add `<link rel=\"canonical\" href=\"https://your-site/this-page\">`.");
      const abs = absolute(href, c.page.finalUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return warn(`The canonical link is not a valid address: ${href}.`, "Use a full https:// address.");
      return pass(`Canonical: ${abs}`);
    },
  },
  {
    id: "seo-lang",
    category: "seo",
    title: "Page language",
    description: "The lang attribute on <html> tells browsers, search engines and screen readers which language the page is in.",
    weight: 2,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const lang = clean(c.root!.querySelector("html")?.getAttribute("lang"));
      if (!lang) return warn("<html> has no lang attribute.", "Add one, for example `<html lang=\"en\">`.");
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) return warn(`The lang value "${lang}" is not a valid language code.`, "Use a code such as en, en-GB or ur.");
      return pass(`The page language is ${lang}.`);
    },
  },
  {
    id: "seo-viewport",
    category: "seo",
    title: "Mobile viewport",
    description: "Without `width=device-width` phones show a tiny zoomed-out desktop page. Search engines rank mobile-friendly pages higher.",
    weight: 4,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const v = meta(c.root!, "viewport");
      if (v === undefined) return fail("There is no viewport meta tag, so phones will show the page zoomed out.", "Add `<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">`.");
      if (!/width\s*=\s*device-width/i.test(v)) return warn(`The viewport is "${v}" and does not use width=device-width.`, "Use `width=device-width, initial-scale=1`.");
      return pass("The viewport is set for mobile screens.");
    },
  },
  {
    id: "seo-social",
    category: "seo",
    title: "Social sharing tags",
    description: "Open Graph tags (og:title, og:description, og:image) decide how the page looks when shared on LinkedIn, WhatsApp, Slack and others.",
    weight: 2,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const missing = ["og:title", "og:description", "og:image"].filter((k) => !clean(meta(c.root!, k)));
      return missing.length ? warn(`Missing Open Graph tag(s): ${missing.join(", ")}.`, "Add them so shared links show a title, a description and a picture.") : pass("Open Graph title, description and image are set.");
    },
  },
  {
    id: "seo-indexable",
    category: "seo",
    title: "Page can be indexed",
    description: "A `noindex` in the robots meta tag or the X-Robots-Tag header keeps the page out of search results.",
    weight: 3,
    run: (c) => {
      const header = c.page.headers["x-robots-tag"] ?? "";
      const tag = c.root ? meta(c.root, "robots") ?? "" : "";
      if (/noindex/i.test(header) || /noindex/i.test(tag)) return warn("The page tells search engines not to index it (noindex).", "Remove noindex if this page should appear in search results.", [/noindex/i.test(header) ? `X-Robots-Tag: ${header}` : `<meta name="robots" content="${tag}">`]);
      return pass("Nothing stops search engines from indexing the page.");
    },
  },
  {
    id: "seo-robots-txt",
    category: "seo",
    title: "robots.txt",
    description: "The file at /robots.txt tells crawlers what they may visit. A missing file is fine for crawlers but common to flag; blocking everything is a classic launch mistake.",
    weight: 2,
    needs: ["robots"],
    run: (c) => {
      const p = c.extras.robots;
      if (!p) return skip("Not checked.");
      if (!p.ok) return warn(`/robots.txt could not be read (${p.error}).`, "Serve a robots.txt, even a minimal one.");
      if (p.res.status !== 200) return warn(`/robots.txt answers ${p.res.status}.`, "Add a robots.txt that allows crawling and points to your sitemap.");
      const body = p.res.body;
      if (/<html/i.test(body.slice(0, 300))) return warn("/robots.txt returns a web page, not a text file.", "Serve plain text at /robots.txt.");
      const blocksAll = /user-agent:\s*\*\s*(?:\r?\n\s*(?:#.*)?)*disallow:\s*\/\s*(?:\r?\n|$)/i.test(body);
      if (blocksAll) return fail("robots.txt blocks every crawler from the whole site (Disallow: /).", "Remove `Disallow: /` unless the site is meant to be private.");
      return pass("robots.txt is present and does not block the site.");
    },
  },
  {
    id: "seo-sitemap",
    category: "seo",
    title: "XML sitemap",
    description: "A sitemap lists the pages you want search engines to find.",
    weight: 2,
    needs: ["sitemap"],
    run: (c) => {
      const p = c.extras.sitemap;
      if (!p) return skip("Not checked.");
      if (!p.ok) return warn(`No sitemap found (${p.error}).`, "Publish /sitemap.xml and list it in robots.txt with a `Sitemap:` line.");
      const b = p.res.body.trimStart();
      if (p.res.status !== 200 || !/^(<\?xml|<urlset|<sitemapindex)/i.test(b)) return warn("No valid XML sitemap found.", "Publish /sitemap.xml and list it in robots.txt with a `Sitemap:` line.");
      const n = (b.match(/<loc>/gi) ?? []).length;
      return pass(`A sitemap is published (${n} ${n === 1 ? "address" : "addresses"}).`);
    },
  },
  {
    id: "seo-structured-data",
    category: "seo",
    title: "Structured data (JSON-LD)",
    description: "Schema.org data in JSON-LD helps search engines understand the page and can earn rich results. Invalid JSON is ignored.",
    weight: 1,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const blocks = c.root!.querySelectorAll("script").filter((s) => (s.getAttribute("type") ?? "").toLowerCase() === "application/ld+json");
      if (blocks.length === 0) return warn("No structured data found.", "Add Schema.org JSON-LD that describes the page (Organization, Person, Article, Product...).");
      const bad = blocks.filter((b) => { try { JSON.parse(b.text); return false; } catch { return true; } });
      return bad.length ? fail(`${bad.length} of ${blocks.length} JSON-LD block(s) are not valid JSON, so search engines ignore them.`, "Fix the JSON syntax (a trailing comma or a stray quote is the usual cause).") : pass(`${blocks.length} valid JSON-LD block(s).`);
    },
  },
  {
    id: "seo-favicon",
    category: "seo",
    title: "Favicon",
    description: "The small icon in browser tabs, bookmarks and search results.",
    weight: 1,
    needs: ["favicon"],
    run: (c) => {
      if (c.root && linksWithRel(c.root, "icon").length) return pass("The page declares an icon.");
      const p = c.extras.favicon;
      if (p?.ok && p.res.status === 200) return pass("/favicon.ico exists.");
      return warn("No favicon found.", "Add `<link rel=\"icon\" href=\"/favicon.ico\">` (or an SVG/PNG icon).");
    },
  },
];
