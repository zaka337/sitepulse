import { ScanError } from "./types.js";
import { isMissingName } from "./net/guard.js";
import type { Root } from "./html.js";
import { absolute } from "./html.js";
import type { LinkProbe } from "./checks/types.js";
import type { Fetched, FetchOptions } from "./net/fetcher.js";

/* The link sampler. It picks a handful of the page's links (mostly the site's own, because those are the ones its owner
   can fix), asks each whether it still answers, and sorts the answers into: ok, broken, "blocked" (the site refuses
   robots: not the page's fault, so it is not counted as broken) and "skipped" (a private address, which the safety guard
   refuses: a hostile page could link to internal addresses to make a scanner touch them). */

type Request = (url: string, extra?: Partial<FetchOptions>) => Promise<Fetched>;

const strip = (h: string) => h.replace(/^www\./i, "").toLowerCase();

/** Choose up to `max` distinct http(s) links: about 60% internal first, then external */
export function pickLinks(root: Root, pageUrl: string, max: number): { url: string; internal: boolean }[] {
  if (max <= 0) return [];
  const here = new URL(pageUrl);
  const seen = new Set<string>([here.href.split("#")[0]!]);
  const internal: string[] = [];
  const external: string[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    const raw = (a.getAttribute("href") ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|sms|javascript|data|blob|ftp):/i.test(raw)) continue;
    const abs = absolute(raw, pageUrl);
    if (!abs) continue;
    const u = new URL(abs);
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.hash = "";
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    (strip(u.hostname) === strip(here.hostname) ? internal : external).push(u.href);
  }
  const wantInternal = Math.min(internal.length, Math.ceil(max * 0.6));
  const picked = [...internal.slice(0, wantInternal).map((url) => ({ url, internal: true })), ...external.slice(0, max - wantInternal).map((url) => ({ url, internal: false }))];
  // if there were not enough external ones, fill the rest with more internal ones
  let i = wantInternal;
  while (picked.length < max && i < internal.length) picked.push({ url: internal[i++]!, internal: true });
  return picked;
}

const BLOCKED = new Set([401, 403, 429, 999]);

async function probeOne(req: Request, url: string, internal: boolean): Promise<LinkProbe> {
  const base = { url, internal };
  try {
    let r = await req(url, { method: "HEAD", maxRedirects: 4, timeoutMs: 5000 });
    // some servers refuse HEAD but answer GET
    if (r.status === 405 || r.status === 501 || r.status === 400) r = await req(url, { method: "GET", maxRedirects: 4, timeoutMs: 5000, maxBytes: 1 });
    if (r.status >= 200 && r.status < 400) return { ...base, status: r.status, kind: "ok", note: "ok" };
    if (BLOCKED.has(r.status)) return { ...base, status: r.status, kind: "blocked", note: "refuses automated requests" };
    return { ...base, status: r.status, kind: "broken", note: r.status === 404 || r.status === 410 ? "not found" : r.status >= 500 ? "server error" : "error" };
  } catch (e) {
    if (e instanceof ScanError && (e.code === "blocked-address" || e.code === "blocked-host" || e.code === "port-not-allowed" || e.code === "bad-protocol")) {
      return { ...base, status: null, kind: "skipped", note: "not requested (private or unusual address)" };
    }
    const code = (e as { code?: string }).code;
    const note = e instanceof ScanError && (e.code === "timeout" || e.code === "aborted") ? "no answer in time" : isMissingName(code) ? "the name does not exist" : code === "ECONNREFUSED" ? "connection refused" : code?.startsWith("CERT") || code?.includes("TLS") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" ? "certificate problem" : e instanceof Error ? e.message.slice(0, 80) : "no answer";
    return { ...base, status: null, kind: "broken", note };
  }
}

/** Probe the picked links with a small amount of parallelism */
export async function probeLinks(root: Root, pageUrl: string, max: number, req: Request): Promise<LinkProbe[]> {
  const picked = pickLinks(root, pageUrl, max);
  const out: LinkProbe[] = new Array(picked.length);
  let next = 0;
  const worker = async () => {
    while (next < picked.length) {
      const i = next++;
      out[i] = await probeOne(req, picked[i]!.url, picked[i]!.internal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, picked.length) }, worker));
  return out;
}
