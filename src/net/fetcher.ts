import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { IncomingMessage } from "node:http";
import { ScanError, type ScanOptions } from "../types.js";
import { assertAllowedUrl, createGuardedLookup, type Resolver } from "./guard.js";

/* One careful HTTP client for everything the scanner requests. It is deliberately small and does not use fetch():
   the connection must use the address the guard approved (guard.ts), and plain node:http lets the guard supply it.

   Limits that apply to every request: a time limit, a cap on how much of the body is read (a page of any size must not
   fill memory, and neither must a compressed "bomb" that is tiny on the wire and huge when unpacked), redirects followed
   by hand (at most 5, each one checked again) and no cookies or credentials sent. */

export interface FetchOptions extends Pick<ScanOptions, "allowPrivate" | "allowedPorts" | "userAgent" | "signal"> {
  method?: "GET" | "HEAD";
  /** Follow redirects (default true) */
  follow?: boolean;
  maxRedirects?: number;
  /** Most body bytes kept after unpacking (default 1.5 MB); the rest is dropped and `truncated` is set */
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Tests can supply their own name resolution */
  resolver?: Resolver;
}

export interface Hop { url: string; status: number; location: string }

export interface Fetched {
  /** The URL that was requested, and the one that finally answered */
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  /** Header names are lower case; repeated headers are joined with ", " (set-cookie is kept apart in setCookies) */
  headers: Record<string, string>;
  setCookies: string[];
  redirects: Hop[];
  contentType: string;
  /** The content-encoding the server used (gzip, br, ...), or null */
  encoding: string | null;
  /** The body as text (empty for HEAD and for non-text answers), and how many bytes it was after unpacking */
  body: string;
  bodyBytes: number;
  truncated: boolean;
  /** Time until the first byte of the final answer, and until the end */
  ttfbMs: number;
  totalMs: number;
}

const DEFAULT_MAX_BYTES = 1_500_000;
const TEXTLIKE = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml)|image\/svg\+xml)/i;

export const DEFAULT_USER_AGENT = "sitepulse/0.1 (+https://github.com/zaka337/sitepulse)";

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

function once(u: URL, o: Required<Pick<FetchOptions, "method" | "maxBytes" | "timeoutMs">> & FetchOptions): Promise<Omit<Fetched, "url" | "finalUrl" | "redirects">> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const lib = u.protocol === "https:" ? https : http;
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } };

    const req = lib.request(
      u,
      {
        method: o.method,
        agent: false,
        lookup: createGuardedLookup(!!o.allowPrivate, o.resolver) as never,
        headers: {
          "user-agent": o.userAgent ?? DEFAULT_USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
          connection: "close",
          ...o.headers,
        },
      },
      (res: IncomingMessage) => {
        const ttfbMs = performance.now() - started;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (k !== "set-cookie" && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        const setCookies = res.headers["set-cookie"] ?? [];
        const contentType = (headers["content-type"] ?? "").toLowerCase();
        const encoding = (headers["content-encoding"] ?? "").toLowerCase().trim() || null;
        const base = { status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers, setCookies, contentType, encoding, ttfbMs };

        const wantBody = o.method === "GET" && TEXTLIKE.test(contentType) && !isRedirect(base.status);
        if (!wantBody) {
          res.resume();
          res.destroy();
          return finish(() => resolve({ ...base, body: "", bodyBytes: 0, truncated: false, totalMs: performance.now() - started }));
        }

        let stream: NodeJS.ReadableStream = res;
        try {
          if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
          else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
          else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
        } catch (e) {
          return finish(() => reject(e));
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        const end = () => finish(() => {
          const buf = Buffer.concat(chunks);
          resolve({ ...base, body: buf.toString("utf8"), bodyBytes: bytes, truncated, totalMs: performance.now() - started });
        });
        stream.on("data", (c: Buffer) => {
          if (truncated) return;
          const room = o.maxBytes - bytes;
          if (c.length >= room) {
            chunks.push(c.subarray(0, Math.max(0, room)));
            bytes += Math.max(0, room);
            truncated = true;
            res.destroy(); // stop reading: the rest is not needed (and may be a decompression bomb)
            end();
          } else {
            chunks.push(c);
            bytes += c.length;
          }
        });
        // Finish only when the (unpacked) stream has ended: the raw response closing first does not mean the decompressor has
        // handed over everything it has, and finishing then would return a body that is empty or cut short.
        stream.on("end", end);
        stream.on("error", (e) => finish(() => reject(e)));
        res.on("error", (e) => finish(() => reject(e)));
      },
    );

    const timer = setTimeout(() => {
      finish(() => { req.destroy(); reject(new ScanError("timeout", `No answer within ${o.timeoutMs >= 1000 ? `${Math.round(o.timeoutMs / 1000)} seconds` : `${o.timeoutMs} ms`}`)); });
    }, o.timeoutMs);

    if (o.signal) {
      const abort = () => finish(() => { req.destroy(); reject(new ScanError("aborted", "The scan was cancelled")); });
      if (o.signal.aborted) abort();
      else o.signal.addEventListener("abort", abort, { once: true });
    }
    req.on("error", (e) => finish(() => reject(e)));
    req.end();
  });
}

/** Request a URL (following redirects unless told not to), with every safety limit applied at every hop. */
export async function fetchUrl(startUrl: string, options: FetchOptions = {}): Promise<Fetched> {
  const o = {
    ...options,
    method: options.method ?? "GET",
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? 8000,
  } as const;
  const maxRedirects = options.maxRedirects ?? 5;
  const follow = options.follow ?? true;
  const redirects: Hop[] = [];
  const started = performance.now();
  let current = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = assertAllowedUrl(current, o);
    const r = await once(u, o);
    const location = r.headers["location"];
    if (follow && isRedirect(r.status) && location) {
      redirects.push({ url: u.href, status: r.status, location });
      try {
        current = new URL(location, u).href;
      } catch {
        throw new ScanError("invalid-url", "A redirect pointed at an address that is not valid");
      }
      continue;
    }
    return { ...r, url: startUrl, finalUrl: u.href, redirects, totalMs: performance.now() - started };
  }
  throw new ScanError("too-many-redirects", `More than ${maxRedirects} redirects in a row`);
}
