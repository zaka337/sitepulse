import { fail, pass, warn, type CheckDef } from "./types.js";

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

export const performanceChecks: CheckDef[] = [
  {
    id: "perf-ttfb",
    category: "performance",
    title: "Server response time",
    description: "Time until the server starts sending the page (including DNS and connecting). Measured from where the scan runs, so treat it as a rough guide.",
    weight: 5,
    run: (c) => {
      const ms = Math.round(c.page.ttfbMs);
      if (ms <= 800) return pass(`The server started answering after ${ms} ms.`);
      if (ms <= 1800) return warn(`The server took ${ms} ms to start answering.`, "Cache the page (a CDN or server-side caching), or look for slow database queries before the page is sent.");
      return fail(`The server took ${ms} ms to start answering.`, "This is slow: cache the page at a CDN, and find what the server does before it sends anything.");
    },
  },
  {
    id: "perf-compression",
    category: "performance",
    title: "Text compression",
    description: "Whether the page is sent compressed (gzip or Brotli). It usually cuts the size by two thirds or more.",
    weight: 4,
    run: (c) => {
      if (!c.isHtml) return pass("Not an HTML page; nothing to compress.");
      if (c.page.encoding && /^(gzip|x-gzip|br|zstd|deflate)$/.test(c.page.encoding)) return pass(`The page is compressed (${c.page.encoding}).`);
      if (c.page.bodyBytes < 1400) return pass("The page is tiny, so compression would not help.");
      return fail(`The page (${kb(c.page.bodyBytes)}) is sent uncompressed.`, "Turn on gzip or Brotli compression for HTML, CSS and JavaScript on your server or CDN.");
    },
  },
  {
    id: "perf-html-size",
    category: "performance",
    title: "HTML size",
    description: "The size of the HTML document itself, after unpacking (up to 300 KB is fine, up to 1 MB is worth trimming, more than that is a problem: search engines stop reading at about 2 MB and phones are slow to parse a document that large).",
    weight: 2,
    run: (c) => {
      if (!c.isHtml) return pass("Not an HTML page.");
      const n = c.page.bodyBytes;
      if (c.page.truncated) return fail(`The HTML is larger than ${kb(n)} (the scan stopped reading there).`, "Trim the document: remove inline data, split long pages, load the rest on demand.");
      if (n <= 300_000) return pass(`The HTML is ${kb(n)}.`);
      if (n <= 1_000_000) return warn(`The HTML is ${kb(n)}.`, "Consider trimming inline scripts, inline images and repeated markup.");
      return fail(`The HTML is ${kb(n)}.`, "Trim the document: remove inline data, split long pages, load the rest on demand.");
    },
  },
  {
    id: "perf-redirects",
    category: "performance",
    title: "Redirect chain",
    description: "Every redirect adds a full round trip before the page can start. The best case is none or one (http to https, or www to non-www).",
    weight: 2,
    run: (c) => {
      const n = c.page.redirects.length;
      const chain = c.page.redirects.map((h) => `${h.status} ${h.url} -> ${h.location}`);
      if (n <= 1) return pass(n === 0 ? "The address answers directly." : "One redirect.");
      if (n === 2) return warn("Two redirects before the page.", "Point links and the first redirect straight at the final address.", chain);
      return fail(`${n} redirects in a row before the page.`, "Cut the chain: send people straight to the final address.", chain);
    },
  },
];
