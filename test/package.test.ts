import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

/* The things around the code that break a release: metadata that disagrees with itself, and entry points that do not start. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = JSON.parse(readFileSync(path.join(root, "server.json"), "utf8"));

describe("server.json agrees with package.json (the MCP Registry rejects a mismatch)", () => {
  it("has the same name, version and repository", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.repository.url).toBe(pkg.homepage.replace(/#readme$/, ""));
    expect(server.repository.url).toBe(pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
  });

  it("points at this npm package and version", () => {
    const [p] = server.packages;
    expect(server.packages).toHaveLength(1);
    expect(p.registryType).toBe("npm");
    expect(p.identifier).toBe(pkg.name);
    expect(p.version).toBe(pkg.version);
    expect(p.transport.type).toBe("stdio");
  });

  it("starts the MCP server through the package's main command", () => {
    expect(server.packages[0].packageArguments).toEqual([{ type: "positional", value: "mcp" }]);
  });

  it("obeys the registry's limits", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.name).toMatch(/^io\.github\.zaka337\/[a-zA-Z0-9._-]+$/);
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/.+\/server\.schema\.json$/);
  });

  it("documents the one environment variable the server reads", () => {
    const names = server.packages[0].environmentVariables.map((e: { name: string }) => e.name);
    expect(names).toEqual(["SITEPULSE_ALLOW_PRIVATE"]);
    expect(server.packages[0].environmentVariables[0].isSecret).toBe(false);
  });
});

describe("package.json", () => {
  it("ships only what is needed", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "server.json"]);
  });
  it("declares both commands, and they exist after a build", () => {
    expect(Object.keys(pkg.bin).sort()).toEqual(["sitepulse", "sitepulse-mcp"]);
    for (const file of Object.values(pkg.bin)) expect(() => readFileSync(path.join(root, file), "utf8")).not.toThrow();
  });
  it("has the shebang on both commands, ending in a plain newline (a \\r there breaks the command on Linux and macOS when the package is built on Windows)", () => {
    for (const file of Object.values(pkg.bin)) expect(readFileSync(path.join(root, file), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
  it("has no dependency that is only needed for development", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "node-html-parser", "zod"]);
  });
});

describe("`sitepulse mcp` (what the registry entry runs)", () => {
  it("serves the MCP protocol through the main command", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "cli.js"), "mcp"], env: {}, stderr: "pipe" });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["list_checks", "scan_website"]);
      expect(client.getServerVersion()?.name).toBe("sitepulse");
    } finally {
      await client.close();
    }
  });
});
