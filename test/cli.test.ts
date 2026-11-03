import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { CHECKS } from "../src/checks/index.js";
import { GOOD_HTML, startFixture, type Fixture } from "./fixtures/server.js";

/* The command line, run exactly as a user runs it: the built file, a real process, real exit codes. */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

interface Run { code: number; stdout: string; stderr: string }
const cli = (args: string[], env: Record<string, string> = {}): Promise<Run> =>
  new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", ...env }, maxBuffer: 20_000_000, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

let site: Fixture;
beforeAll(async () => {
  site = await startFixture({
    "/": { headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" }, body: GOOD_HTML },
    "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
    "/about": { body: "<h1>About</h1>" },
  });
});
afterAll(() => site.close());

describe("information", () => {
  it("--version and -v print the version", async () => {
    for (const flag of ["--version", "-v"]) {
      const r = await cli([flag]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(pkg.version);
    }
  });

  it("--help explains the options and the exit codes", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    for (const word of ["Usage", "--json", "--markdown", "--only", "--max-links", "--timeout", "--fail-under", "--allow-private", "--list-checks", "Exit codes"]) expect(r.stdout).toContain(word);
  });

  it("--list-checks lists every check", async () => {
    const r = await cli(["--list-checks"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(CHECKS.length);
    for (const c of CHECKS) expect(r.stdout).toContain(c.id);
  });
});

describe("bad usage is a clear message and exit code 2", () => {
  it.each([
    [[], "give exactly one web address"],
    [["a.example", "b.example"], "give exactly one web address"],
    [["--bogus", "a.example"], "bogus"],
    [["a.example", "--only", "nonsense"], 'unknown category "nonsense"'],
    [["a.example", "--max-links", "99"], "--max-links must be a whole number from 0 to 30"],
    [["a.example", "--max-links", "2.5"], "--max-links must be a whole number"],
    [["a.example", "--timeout", "abc"], "--timeout must be a whole number"],
    [["a.example", "--timeout", "10"], "--timeout must be a whole number from 500"],
    [["a.example", "--fail-under", "101"], "--fail-under must be a whole number from 0 to 100"],
  ])("sitepulse %j", async (args, message) => {
    const r = await cli(args as string[]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe("");
  });
});

describe("scanning", () => {
  const scanArgs = (...more: string[]) => [site.url, "--allow-private", ...more];

  it("prints a readable report, without colour codes when the output is not a terminal", async () => {
    const r = await cli(scanArgs());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sitepulse report:");
    expect(r.stdout).toMatch(/Score \d+\/100 \(grade [A-F]\)/);
    expect(r.stdout).toContain("Security");
    expect(r.stdout).not.toContain("\u001b[");
  });

  it("--json prints the whole report as valid JSON", async () => {
    const r = await cli(scanArgs("--json"));
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.results).toHaveLength(CHECKS.length);
    expect(typeof report.score).toBe("number");
    expect(report.finalUrl).toBe(`${site.url}/`);
    expect(Object.keys(report.categories)).toHaveLength(5);
  });

  it("--markdown (and --md) print Markdown", async () => {
    for (const flag of ["--markdown", "--md"]) {
      const r = await cli(scanArgs(flag));
      expect(r.code).toBe(0);
      expect(r.stdout.startsWith("# Website health:")).toBe(true);
      expect(r.stdout).toContain("| Category | Score |");
    }
  });

  it("--only limits the categories", async () => {
    const r = await cli(scanArgs("--only", "security, SEO"));
    expect(r.stdout).toContain("Security");
    expect(r.stdout).toContain("SEO and content");
    expect(r.stdout).not.toContain("Performance");
    expect(r.stdout).not.toContain("Accessibility");
  });

  it("--max-links 0 turns link checking off", async () => {
    const r = await cli(scanArgs("--max-links", "0", "--json"));
    expect(JSON.parse(r.stdout).results.find((x: { id: string }) => x.id === "links-broken").status).toBe("skip");
  });

  it("works with the environment variable instead of the flag", async () => {
    const r = await cli([site.url], { SITEPULSE_ALLOW_PRIVATE: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sitepulse report:");
  });
});

describe("exit codes for CI", () => {
  it("--fail-under: exit 1 when the score is lower, 0 when it is not", async () => {
    const low = await cli([site.url, "--allow-private", "--fail-under", "100"]);
    expect(low.code).toBe(1);
    expect(low.stderr).toMatch(/score \d+ is below --fail-under 100/);
    expect(low.stdout).toContain("sitepulse report:"); // the report is still printed
    const ok = await cli([site.url, "--allow-private", "--fail-under", "0"]);
    expect(ok.code).toBe(0);
  });

  it("exits 1 when the page cannot be loaded, but still prints why", async () => {
    const dead = await startFixture({});
    const url = dead.url;
    await dead.close();
    const r = await cli([url, "--allow-private"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("could not be loaded");
  });

  it("refuses a private address by default: exit 2, a plain explanation, and the server is never touched", async () => {
    const before = site.hits.length;
    const r = await cli([site.url]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/sitepulse: /);
    expect(r.stdout).toBe("");
    expect(site.hits.length).toBe(before);
  });

  it.each(["http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "http://user:pw@example.com/"])("refuses %s", async (url) => {
    const r = await cli([url]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });
});
