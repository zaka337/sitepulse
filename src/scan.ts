import { CHECKS } from "./checks/index.js";
import type { Ctx, Probe } from "./checks/types.js";
import { linksWithRel, parseHtml } from "./html.js";
import { fetchUrl, type Fetched, type FetchOptions } from "./net/fetcher.js";
import { assertAllowedUrl, isMissingName, normalizeInput } from "./net/guard.js";
import { probeLinks } from "./probe.js";
import { summarise } from "./score.js";
import { CATEGORIES, ScanError, type CheckResult, type Report, type ScanErrorCode, type ScanOptions } from "./types.js";

/* The orchestrator: fetch the page, fetch the few extra things the checks need (robots.txt, the sitemap, the http://
   variant, a sample of the page's links) in parallel under one overall time budget, then run every check against what
   was collected. The checks themselves know nothing about the network. */

/** Problems with the address itself: the caller's to fix, so they are thrown rather than reported as a failed check. */
const REFUSED = new Set<ScanErrorCode>(["invalid-url", "bad-protocol", "credentials-in-url", "port-not-allowed", "blocked-host", "blocked-address"]);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A readable reason for a request that failed at the network level */
export function describeNetworkError(e: unknown): { message: string; tls: boolean } {
  const code = (e as { code?: string })?.code ?? "";
  if (e instanceof ScanError) return { message: e.message, tls: false };
  if (isMissingName(code)) return { message: "the name does not exist (DNS lookup failed)", tls: false };
  if (code === "ECONNREFUSED") return { message: "the server refused the connection", tls: false };
  if (code === "ECONNRESET" || code === "EPIPE") return { message: "the connection was reset", tls: false };
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return { message: "the server could not be reached", tls: false };
  if (code === "CERT_HAS_EXPIRED") return { message: "its security certificate has expired", tls: true };
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN") return { message: "its security certificate is self-signed, so browsers will warn visitors", tls: true };
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return { message: "its security certificate is for a different name", tls: true };
  if (code.startsWith("UNABLE_TO_") || code.startsWith("ERR_TLS") || code.startsWith("CERT_")) return { message: "its security certificate could not be verified", tls: true };
  return { message: e instanceof Error ? e.message.slice(0, 120) : "the request failed", tls: false };
}

function unreachable(startUrl: string, e: unknown, started: number): Report {
  const { message, tls } = describeNetworkError(e);
  const results: CheckResult[] = [
    { id: "seo-status", category: "seo", title: "Page loads (HTTP 200)", weight: 6, status: "fail", message: `The page could not be loaded: ${message}.`, fix: "Check that the address is right and the site is up, then scan again." },
  ];
  if (tls) results.push({ id: "sec-https", category: "security", title: "Served over HTTPS", weight: 10, status: "fail", message: `The HTTPS connection failed: ${message}.`, fix: "Install a valid certificate for this exact name (free ones from Let's Encrypt, or your host) and renew it before it expires." });
  return { url: startUrl, finalUrl: startUrl, scannedAt: new Date().toISOString(), durationMs: Date.now() - started, ...summarise(results), results, notes: ["The scan stopped here because the page could not be loaded."] };
}

export async function scan(input: string, options: ScanOptions = {}): Promise<Report> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 8000;
  const budgetMs = options.budgetMs ?? 15000;
  const maxLinks = clamp(Math.floor(options.maxLinks ?? 12), 0, 30);
  const categories = new Set(options.categories?.length ? options.categories : CATEGORIES);

  const startUrl = normalizeInput(input);
  assertAllowedUrl(startUrl, options); // refuse a bad address before any request is made

  const deadline = started + budgetMs;
  const budget = AbortSignal.timeout(budgetMs);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  const req = (url: string, extra: Partial<FetchOptions> = {}) =>
    fetchUrl(url, {
      allowPrivate: options.allowPrivate,
      allowedPorts: options.allowedPorts,
      userAgent: options.userAgent,
      signal,
      timeoutMs: Math.max(1000, Math.min(timeoutMs, deadline - Date.now())),
      ...extra,
    });
  const probe = async (url: string, extra?: Partial<FetchOptions>): Promise<Probe> => {
    try {
      return { ok: true, res: await req(url, extra) };
    } catch (e) {
      return { ok: false, error: describeNetworkError(e).message };
    }
  };

  let page: Fetched;
  try {
    page = await req(startUrl, { timeoutMs });
  } catch (e) {
    if (e instanceof ScanError && REFUSED.has(e.code)) throw e; // e.g. a redirect to a private address
    if (e instanceof ScanError && e.code === "aborted" && options.signal?.aborted) throw e; // the caller cancelled: that is not a failed page
    return unreachable(startUrl, e, started);
  }

  const final = new URL(page.finalUrl);
  const isHttps = final.protocol === "https:";
  const isHtml = /html/.test(page.contentType) || (!page.contentType && /^\s*<(!doctype|html)/i.test(page.body.slice(0, 300)));
  const root = isHtml ? parseHtml(page.body) : null;
  const notes: string[] = [];
  if (page.truncated) notes.push("The page was larger than the scan reads, so only the first part was examined.");
  if (!isHtml) notes.push(`The address returned ${page.contentType || "something that is not HTML"}, so the page-content checks were skipped.`);

  const wanted = CHECKS.filter((c) => categories.has(c.category));
  const needs = new Set(wanted.flatMap((c) => c.needs ?? []));
  const extras: Ctx["extras"] = {};
  const origin = final.origin;

  await Promise.all([
    needs.has("robots") || needs.has("sitemap")
      ? (async () => {
          extras.robots = await probe(`${origin}/robots.txt`, { maxBytes: 200_000, timeoutMs: 5000 });
          if (needs.has("sitemap")) {
            // if the very same host just failed at the network level (no answer, reset...), asking again would only wait out another timeout
            if (!extras.robots.ok) extras.sitemap = extras.robots;
            else {
              const listed = extras.robots.res.status === 200 ? /^\s*sitemap:\s*(\S+)/im.exec(extras.robots.res.body)?.[1] : undefined;
              extras.sitemap = await probe(listed ?? `${origin}/sitemap.xml`, { maxBytes: 200_000, timeoutMs: 5000 });
            }
          }
        })()
      : undefined,
    needs.has("httpVariant") && isHttps && (final.port === "" || final.port === "443")
      ? probe(`http://${final.hostname}/`, { follow: false, maxBytes: 4096, timeoutMs: 5000 }).then((p) => { extras.httpVariant = p; })
      : undefined,
    needs.has("favicon") && !(root && linksWithRel(root, "icon").length)
      ? probe(`${origin}/favicon.ico`, { method: "HEAD", timeoutMs: 5000 }).then((p) => { extras.favicon = p; })
      : undefined,
    needs.has("links") && root && maxLinks > 0
      ? probeLinks(root, page.finalUrl, maxLinks, req).then((l) => { extras.links = l; })
      : undefined,
  ]);

  const ctx: Ctx = { opts: { maxLinks }, inputUrl: startUrl, page, isHttps, isHtml, root, extras };
  const results: CheckResult[] = wanted.map((def) => {
    const head = { id: def.id, category: def.category, title: def.title, weight: def.weight };
    try {
      return { ...head, ...def.run(ctx) };
    } catch (e) {
      // a bug in one check must not take the scan down
      notes.push(`The check "${def.id}" could not run: ${e instanceof Error ? e.message : String(e)}`);
      return { ...head, status: "skip" as const, message: "This check could not run on this page." };
    }
  });

  return { url: startUrl, finalUrl: page.finalUrl, scannedAt: new Date().toISOString(), durationMs: Date.now() - started, ...summarise(results), results, notes };
}
