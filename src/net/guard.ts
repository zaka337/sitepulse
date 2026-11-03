import dns from "node:dns";
import net, { BlockList } from "node:net";
import { ScanError, type ScanOptions } from "../types.js";

/* The safety net. A tool that fetches a URL it is given can be tricked into fetching one it should not: the address of a
   server inside a company network, a cloud provider's metadata service (169.254.169.254 hands out credentials), the
   machine it runs on. Everything here exists to stop that, and it is checked at two points:

   1. Before a request: the URL must be http or https, on an allowed port, with no user:password, and its host must not
      be a private name or a private IP address (including the odd spellings: decimal, hex, IPv4-mapped IPv6).
   2. At the moment of connecting: the name is resolved HERE and every address it resolves to is checked, and the
      connection then uses exactly the address that was checked. Checking a name first and letting the connection
      resolve it again would allow "DNS rebinding" (a name that answers with a public address for the check and a private
      one for the connection). Redirects go through both points again, hop by hop.

   Private addresses can be allowed (allowPrivate) for the legitimate case of checking a site on your own machine. */

const blocked = new BlockList();

const V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6: [string, number][] = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];
for (const [a, p] of V4) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of V6) blocked.addSubnet(a, p, "ipv6");

/** Is this IP address one a public scanner must never connect to? Anything that is not an IP at all counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  if (bare.includes("%")) return true; // a zone id (fe80::1%eth0) only means something on a local link
  const family = net.isIP(bare);
  if (family === 0) return true;
  // an IPv4 address written inside IPv6 (::ffff:127.0.0.1) is checked as the IPv4 address it is (BlockList does this itself)
  return blocked.check(bare, family === 4 ? "ipv4" : "ipv6");
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa"];

function isPrivateName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h === "metadata" || PRIVATE_SUFFIXES.some((s) => h.endsWith(s));
}

/** "example.com" and "  https://Example.com/x " both become a full URL; the scheme defaults to https. */
export function normalizeInput(raw: string): string {
  const t = raw.trim();
  if (!t) throw new ScanError("invalid-url", "Enter a web address, for example example.com");
  return /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/?#]*:\d+(\/|$)/.test(t) ? t : `https://${t}`;
}

const DEFAULT_PORTS = [80, 443];

/** Throws a ScanError unless this URL may be requested. Returns the parsed URL. */
export function assertAllowedUrl(raw: string, opts: Pick<ScanOptions, "allowPrivate" | "allowedPorts"> = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ScanError("invalid-url", `That does not look like a web address: ${raw.slice(0, 80)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ScanError("bad-protocol", `Only http and https addresses can be checked, not ${u.protocol}`);
  }
  if (u.username || u.password) throw new ScanError("credentials-in-url", "Addresses with a user name or password in them are not allowed");

  const ports = opts.allowedPorts ?? (opts.allowPrivate ? "any" : DEFAULT_PORTS);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (ports !== "any" && !ports.includes(port)) {
    throw new ScanError("port-not-allowed", `Port ${port} is not allowed (allowed: ${ports.join(", ")})`);
  }

  if (!opts.allowPrivate) {
    const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
    if (net.isIP(host)) {
      if (isBlockedAddress(host)) throw new ScanError("blocked-address", "That address is on a private or reserved network and cannot be checked");
    } else if (isPrivateName(host)) {
      throw new ScanError("blocked-host", "That name points to a private network and cannot be checked");
    }
  }
  return u;
}

/** The error codes operating systems use for "this name has no address" (Windows says ENOENT, Linux ENODATA or ENOTFOUND) */
export const isMissingName = (code: string | undefined): boolean => code === "ENOTFOUND" || code === "ENODATA" || code === "ENOENT" || code === "EAI_NONAME" || code === "EAI_NODATA";

type Resolved = { address: string; family: number }[];
export type Resolver = (hostname: string) => Promise<Resolved>;

const systemResolver: Resolver = async (hostname) => (await dns.promises.lookup(hostname, { all: true, verbatim: true })) as Resolved;

/**
 * A `lookup` function for http.request: resolves the name, refuses it if ANY of its addresses is blocked, and hands the
 * connection one of the addresses that were checked. `resolver` can be replaced in tests.
 */
export function createGuardedLookup(allowPrivate: boolean, resolver: Resolver = systemResolver) {
  return (hostname: string, options: unknown, callback: unknown): void => {
    const cb = (typeof options === "function" ? options : callback) as (err: Error | null, a?: unknown, f?: number) => void;
    const o = (typeof options === "function" ? {} : options ?? {}) as { all?: boolean; family?: number };
    resolver(hostname).then(
      (addrs) => {
        if (!addrs.length) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
        if (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address))) {
          return cb(new ScanError("blocked-address", "That name resolves to a private or reserved address and cannot be checked"));
        }
        const wanted = o.family === 4 || o.family === 6 ? addrs.filter((a) => a.family === o.family) : addrs;
        const use = wanted.length ? wanted : addrs;
        if (o.all) cb(null, use);
        else cb(null, use[0]!.address, use[0]!.family);
      },
      (err: Error) => cb(err),
    );
  };
}
