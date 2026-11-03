import { describe, expect, it } from "vitest";
import { assertAllowedUrl, createGuardedLookup, isBlockedAddress, normalizeInput } from "../src/net/guard.js";
import { ScanError } from "../src/types.js";

/* The guard is the security boundary of the whole tool: if it has a hole, a public scanner can be pointed at
   a company's internal network or a cloud metadata service. So it is tested by attack, not by example. */

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof ScanError ? e.code : `other: ${String(e)}`;
  }
};

describe("isBlockedAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback range"],
    ["10.0.0.1", "private 10/8"],
    ["172.16.0.1", "private 172.16/12 start"],
    ["172.31.255.255", "private 172.16/12 end"],
    ["192.168.0.1", "private 192.168/16"],
    ["169.254.169.254", "cloud metadata service"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "this host"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.1", "documentation range"],
    ["198.18.0.1", "benchmarking range"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd12:3456::1", "IPv6 unique local (fd)"],
    ["ff02::1", "IPv6 multicast"],
    ["2001:db8::1", "IPv6 documentation"],
    ["::ffff:127.0.0.1", "IPv4 loopback written as IPv6"],
    ["::ffff:7f00:1", "IPv4 loopback written as IPv6, hex form"],
    ["::ffff:10.0.0.1", "private IPv4 written as IPv6"],
    ["::ffff:169.254.169.254", "metadata service written as IPv6"],
    ["64:ff9b::7f00:1", "NAT64 wrapping loopback"],
    ["2002:7f00:1::1", "6to4 wrapping loopback"],
    ["fe80::1%eth0", "link-local with a zone id"],
    ["not-an-ip", "not an address at all"],
    ["", "empty"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "11.0.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
  ])("allows the public address %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("assertAllowedUrl: addresses written to hide where they point", () => {
  it.each([
    ["http://127.0.0.1/", "blocked-address"],
    ["http://127.1/", "blocked-address"],
    ["http://2130706433/", "blocked-address"], // 127.0.0.1 as one decimal number
    ["http://0x7f000001/", "blocked-address"], // as hex
    ["http://0x7f.0.0.1/", "blocked-address"],
    ["http://017700000001/", "blocked-address"], // as octal
    ["http://0177.0.0.1/", "blocked-address"],
    ["http://0/", "blocked-address"],
    ["http://[::1]/", "blocked-address"],
    ["http://[::ffff:7f00:1]/", "blocked-address"],
    ["http://[::ffff:127.0.0.1]/", "blocked-address"],
    ["http://[0:0:0:0:0:0:0:1]/", "blocked-address"],
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "blocked-address"],
    ["http://10.1.2.3/admin", "blocked-address"],
    ["https://192.168.1.1/", "blocked-address"],
    ["http://100.100.100.200/latest/meta-data/", "blocked-address"], // a cloud provider's metadata address
    ["http://localhost/", "blocked-host"],
    ["http://LOCALHOST./", "blocked-host"],
    ["http://app.localhost/", "blocked-host"],
    ["http://printer.local/", "blocked-host"],
    ["http://intranet.corp/", "blocked-host"],
    ["http://metadata.google.internal/computeMetadata/v1/", "blocked-host"],
    ["http://router.home.arpa/", "blocked-host"],
  ])("refuses %s", (url, expected) => {
    expect(code(() => assertAllowedUrl(url))).toBe(expected);
  });
});

describe("assertAllowedUrl: the rest of the URL", () => {
  it.each([
    ["file:///etc/passwd", "bad-protocol"],
    ["ftp://example.com/", "bad-protocol"],
    ["javascript:alert(1)", "bad-protocol"],
    ["data:text/html,<script>1</script>", "bad-protocol"],
    ["gopher://example.com/", "bad-protocol"],
    ["http://user:pass@example.com/", "credentials-in-url"],
    ["https://admin@example.com/", "credentials-in-url"],
    ["http://example.com:22/", "port-not-allowed"],
    ["http://example.com:6379/", "port-not-allowed"],
    ["https://example.com:8443/", "port-not-allowed"],
    ["not a url", "invalid-url"],
    ["http://", "invalid-url"],
    ["", "invalid-url"],
  ])("refuses %s", (url, expected) => {
    expect(code(() => assertAllowedUrl(url))).toBe(expected);
  });

  it("allows ordinary public addresses, with or without the default port", () => {
    for (const u of ["https://example.com", "http://example.com/a?b=c#d", "https://example.com:443/", "http://example.com:80/", "https://sub.example.co.uk/path"]) {
      expect(code(() => assertAllowedUrl(u)), u).toBeUndefined();
    }
  });

  it("lets private addresses and other ports through only when asked (for scanning your own dev site)", () => {
    expect(code(() => assertAllowedUrl("http://localhost:3000/", { allowPrivate: true }))).toBeUndefined();
    expect(code(() => assertAllowedUrl("http://127.0.0.1:8080/", { allowPrivate: true }))).toBeUndefined();
    // but not the things that are wrong whatever the setting
    expect(code(() => assertAllowedUrl("file:///etc/passwd", { allowPrivate: true }))).toBe("bad-protocol");
    expect(code(() => assertAllowedUrl("http://u:p@localhost/", { allowPrivate: true }))).toBe("credentials-in-url");
  });

  it("can limit the ports explicitly", () => {
    expect(code(() => assertAllowedUrl("http://example.com:8080/", { allowedPorts: [8080] }))).toBeUndefined();
    expect(code(() => assertAllowedUrl("http://example.com/", { allowedPorts: [8080] }))).toBe("port-not-allowed");
  });
});

describe("normalizeInput", () => {
  it.each([
    ["example.com", "https://example.com"],
    ["  example.com/path  ", "https://example.com/path"],
    ["localhost:3000", "https://localhost:3000"],
    ["localhost:3000/x", "https://localhost:3000/x"],
    ["http://example.com", "http://example.com"],
    ["HTTPS://Example.com/A", "HTTPS://Example.com/A"],
    ["javascript:alert(1)", "javascript:alert(1)"], // left alone: assertAllowedUrl refuses it
    ["mailto:a@b.co", "mailto:a@b.co"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeInput(input)).toBe(expected);
  });

  it("refuses an empty address with a helpful message", () => {
    expect(() => normalizeInput("   ")).toThrow(/Enter a web address/);
  });
});

describe("createGuardedLookup (the check at the moment of connecting)", () => {
  const ask = (lookup: ReturnType<typeof createGuardedLookup>, host: string, options: object = {}) =>
    new Promise<{ err: unknown; address?: unknown; family?: number }>((resolve) => {
      (lookup as (h: string, o: object, cb: (e: unknown, a?: unknown, f?: number) => void) => void)(host, options, (err, address, family) => resolve({ err, address, family }));
    });
  const resolverFor = (addrs: { address: string; family: number }[]) => async () => addrs;

  it("hands the connection a public address", async () => {
    const r = await ask(createGuardedLookup(false, resolverFor([{ address: "93.184.216.34", family: 4 }])), "example.com");
    expect(r.err).toBeNull();
    expect(r.address).toBe("93.184.216.34");
  });

  it("refuses a name that resolves to a private address (DNS rebinding and sneaky DNS records)", async () => {
    const r = await ask(createGuardedLookup(false, resolverFor([{ address: "127.0.0.1", family: 4 }])), "evil.example");
    expect((r.err as ScanError).code).toBe("blocked-address");
    const meta = await ask(createGuardedLookup(false, resolverFor([{ address: "169.254.169.254", family: 4 }])), "evil.example");
    expect((meta.err as ScanError).code).toBe("blocked-address");
  });

  it("refuses a name if ANY of its addresses is private, so a mixed answer cannot slip a private one through", async () => {
    const r = await ask(createGuardedLookup(false, resolverFor([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }])), "mixed.example");
    expect((r.err as ScanError).code).toBe("blocked-address");
  });

  it("refuses IPv6 private answers too, including IPv4-mapped ones", async () => {
    for (const address of ["::1", "fd00::1", "::ffff:192.168.0.1"]) {
      const r = await ask(createGuardedLookup(false, resolverFor([{ address, family: 6 }])), "v6.example");
      expect((r.err as ScanError).code, address).toBe("blocked-address");
    }
  });

  it("allows private answers when private addresses are allowed", async () => {
    const r = await ask(createGuardedLookup(true, resolverFor([{ address: "127.0.0.1", family: 4 }])), "localhost");
    expect(r.err).toBeNull();
    expect(r.address).toBe("127.0.0.1");
  });

  it("reports a name with no addresses as not found", async () => {
    const r = await ask(createGuardedLookup(false, resolverFor([])), "nothing.example");
    expect((r.err as { code?: string }).code).toBe("ENOTFOUND");
  });

  it("returns every checked address when the caller asks for all of them", async () => {
    const addrs = [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }];
    const r = await ask(createGuardedLookup(false, resolverFor(addrs)), "dual.example", { all: true });
    expect(r.address).toEqual(addrs);
  });

  it("passes a resolver failure through", async () => {
    const lookup = createGuardedLookup(false, async () => { throw Object.assign(new Error("boom"), { code: "ESERVFAIL" }); });
    const r = await ask(lookup, "x.example");
    expect((r.err as { code?: string }).code).toBe("ESERVFAIL");
  });
});
