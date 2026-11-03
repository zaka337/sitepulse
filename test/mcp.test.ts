import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { CHECKS } from "../src/checks/index.js";
import { GOOD_HTML, startFixture, type Fixture } from "./fixtures/server.js";

/* The MCP server, driven by the official MCP client over stdio exactly as Claude Desktop, Cursor or VS Code would:
   the built file as a child process, real protocol messages in both directions. */

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp.js");

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "pipe" });
  const client = new Client({ name: "sitepulse-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

let site: Fixture;
let open: Client; // may scan private addresses (SITEPULSE_ALLOW_PRIVATE=1)
let closed: Client; // the default: refuses them

beforeAll(async () => {
  site = await startFixture({
    "/": { headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" }, body: GOOD_HTML },
    "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
    "/about": { body: "<h1>About</h1>" },
  });
  [open, closed] = await Promise.all([connect({ SITEPULSE_ALLOW_PRIVATE: "1" }), connect({})]);
});
afterAll(async () => {
  await Promise.all([open?.close(), closed?.close(), site?.close()]);
});

const text = (res: unknown) => ((res as { content: { type: string; text: string }[] }).content[0]?.text ?? "");

describe("the server describes itself", () => {
  it("identifies itself and gives usage instructions", () => {
    const info = open.getServerVersion();
    expect(info?.name).toBe("sitepulse");
    expect(info?.version).toBe(pkg.version);
    expect(open.getInstructions()).toContain("scan_website");
    expect(open.getInstructions()).toMatch(/not a full audit/);
  });

  it("offers exactly two tools, both marked read-only", async () => {
    const { tools } = await open.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_checks", "scan_website"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t.description?.length, t.name).toBeGreaterThan(40);
    }
  });

  it("describes the scan inputs and the structured output", async () => {
    const scanTool = (await open.listTools()).tools.find((t) => t.name === "scan_website")!;
    expect(scanTool.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(scanTool.inputSchema.properties ?? {}).sort()).toEqual(["categories", "maxLinks", "url"]);
    expect(Object.keys(scanTool.outputSchema?.properties ?? {}).sort()).toEqual(["categoryScores", "finalUrl", "grade", "issues", "notes", "score", "summary"]);
  });
});

describe("list_checks", () => {
  it("lists every check", async () => {
    const res = await open.callTool({ name: "list_checks", arguments: {} });
    expect(res.isError).toBeFalsy();
    for (const c of CHECKS) expect(text(res)).toContain(c.id);
  });
});

describe("scan_website", () => {
  it("returns a Markdown report and a machine-readable summary", async () => {
    const res = await open.callTool({ name: "scan_website", arguments: { url: site.url } });
    expect(res.isError).toBeFalsy();
    expect(text(res).startsWith("# Website health:")).toBe(true);
    const s = res.structuredContent as { score: number; grade: string; finalUrl: string; summary: { pass: number; warn: number; fail: number; skip: number }; categoryScores: Record<string, number | null>; issues: { id: string; status: string; fix?: string }[]; notes: string[] };
    expect(s.score).toBeGreaterThan(0);
    expect(["A", "B", "C", "D", "F"]).toContain(s.grade);
    expect(s.finalUrl).toBe(`${site.url}/`);
    expect(s.summary.pass + s.summary.warn + s.summary.fail + s.summary.skip).toBe(CHECKS.length);
    expect(Object.keys(s.categoryScores).sort()).toEqual(["accessibility", "links", "performance", "security", "seo"]);
    // only problems are listed as issues, and each says how to fix it
    expect(s.issues.length).toBe(s.summary.warn + s.summary.fail);
    for (const i of s.issues) {
      expect(["warn", "fail"]).toContain(i.status);
      expect(i.fix, i.id).toBeTruthy();
    }
  });

  it("honours categories and maxLinks", async () => {
    const res = await open.callTool({ name: "scan_website", arguments: { url: site.url, categories: ["seo"], maxLinks: 0 } });
    const s = res.structuredContent as { categoryScores: Record<string, number | null> };
    expect(s.categoryScores["security"]).toBeNull();
    expect(typeof s.categoryScores["seo"]).toBe("number");
  });

  it("reports a site that cannot be reached as a result, not as a protocol failure", async () => {
    const dead = await startFixture({});
    const url = dead.url;
    await dead.close();
    const res = await open.callTool({ name: "scan_website", arguments: { url } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { score: number }).score).toBe(0);
    expect(text(res)).toContain("could not be loaded");
  });

  it("rejects bad arguments instead of scanning", async () => {
    const outcome = await open.callTool({ name: "scan_website", arguments: { url: site.url, maxLinks: 500 } }).then((r) => r, (e: unknown) => e);
    const failed = outcome instanceof Error || (outcome as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    const missing = await open.callTool({ name: "scan_website", arguments: {} }).then((r) => r, (e: unknown) => e);
    expect(missing instanceof Error || (missing as { isError?: boolean }).isError === true).toBe(true);
  });
});

describe("an AI assistant cannot be steered into probing the private network", () => {
  it("refuses private and local addresses by default, as a tool error with a reason", async () => {
    const before = site.hits.length;
    for (const url of [site.url, site.altUrl, "http://169.254.169.254/latest/meta-data/", "http://[::1]:8080/", "http://10.0.0.1/admin", "http://2130706433/"]) {
      const res = await closed.callTool({ name: "scan_website", arguments: { url } });
      expect(res.isError, url).toBe(true);
      expect(text(res).length, url).toBeGreaterThan(10);
    }
    expect(site.hits.length).toBe(before); // the local server never saw a request
  });

  it("refuses other schemes and credentials too", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/"]) {
      const res = await closed.callTool({ name: "scan_website", arguments: { url } });
      expect(res.isError, url).toBe(true);
    }
  });

  it("can be told to allow them, but only by whoever configures the server (its environment), not by the model", async () => {
    // (the tool has no parameter for it at all)
    const scanTool = (await closed.listTools()).tools.find((t) => t.name === "scan_website")!;
    expect(JSON.stringify(scanTool.inputSchema)).not.toMatch(/private/i);
    const res = await open.callTool({ name: "scan_website", arguments: { url: site.url, maxLinks: 0 } });
    expect(res.isError).toBeFalsy();
  });
});
