import { CHECKS } from "../src/checks/index.js";
import type { Ctx, Outcome } from "../src/checks/types.js";
import { parseHtml } from "../src/html.js";
import type { Fetched, Hop } from "../src/net/fetcher.js";

/* Build a page by hand and hand it to one check: no network, no server. This is why the checks are pure functions. */

export interface CtxInput {
  url?: string;
  status?: number;
  headers?: Record<string, string>;
  setCookies?: string[];
  html?: string | null;
  redirects?: Hop[];
  ttfbMs?: number;
  encoding?: string | null;
  bodyBytes?: number;
  truncated?: boolean;
  extras?: Ctx["extras"];
}

export function makeCtx(i: CtxInput = {}): Ctx {
  const url = i.url ?? "https://example.com/";
  const html = i.html === undefined ? "<html><body></body></html>" : i.html;
  const page: Fetched = {
    url,
    finalUrl: url,
    status: i.status ?? 200,
    statusText: i.status === 404 ? "Not Found" : "OK",
    headers: { "content-type": "text/html; charset=utf-8", ...(i.headers ?? {}) },
    setCookies: i.setCookies ?? [],
    redirects: i.redirects ?? [],
    contentType: html === null ? "application/json" : "text/html; charset=utf-8",
    encoding: i.encoding === undefined ? "gzip" : i.encoding,
    body: html ?? "{}",
    bodyBytes: i.bodyBytes ?? (html ?? "{}").length,
    truncated: i.truncated ?? false,
    ttfbMs: i.ttfbMs ?? 120,
    totalMs: 200,
  };
  return { opts: { maxLinks: 12 }, inputUrl: url, page, isHttps: url.startsWith("https:"), isHtml: html !== null, root: html === null ? null : parseHtml(html), extras: i.extras ?? {} };
}

/** Run one check by id against a made-up page */
export function run(id: string, input: CtxInput = {}): Outcome {
  const def = CHECKS.find((c) => c.id === id);
  if (!def) throw new Error(`no check named ${id}`);
  return def.run(makeCtx(input));
}

/** A tiny page with the given <head> and <body> pieces */
export const page = (head = "", body = "", htmlAttrs = ' lang="en"') => `<!doctype html><html${htmlAttrs}><head>${head}</head><body>${body}</body></html>`;
