#!/usr/bin/env node
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { CHECKS } from "./checks/index.js";
import { formatMarkdown, formatText } from "./report.js";
import { scan } from "./scan.js";
import { CATEGORIES, ScanError, type Category } from "./types.js";

const HELP = `sitepulse ${pkg.version}
Quick website health check: security headers, SEO basics, performance hints, accessibility basics and broken links.

Usage
  sitepulse <url> [options]
  sitepulse mcp          Run as an MCP server over stdio, for AI assistants (same as the sitepulse-mcp command)

Options
  --json               Print the whole report as JSON
  --markdown, --md     Print the report as Markdown
  --only <list>        Only these categories, comma separated: ${CATEGORIES.join(", ")}
  --max-links <n>      How many links to try, 0 to 30 (default 12; 0 turns the link check off)
  --timeout <ms>       Longest wait for one request (default 8000)
  --fail-under <n>     Exit with code 1 if the score is below n (handy in CI)
  --allow-private      Allow localhost and private-network addresses (for a site you run yourself)
  --list-checks        List every check and exit
  --no-color           No colours in the output
  -v, --version        Print the version
  -h, --help           This help

Exit codes: 0 ok, 1 score below --fail-under or the page could not be loaded, 2 a bad option or a refused address.

By default addresses on private networks are refused, so the tool cannot be tricked into probing internal
services. Set SITEPULSE_ALLOW_PRIVATE=1 (or use --allow-private) to scan http://localhost:3000 and the like.
`;

function fatal(message: string, code = 2): never {
  process.stderr.write(`sitepulse: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        markdown: { type: "boolean" },
        md: { type: "boolean" },
        only: { type: "string" },
        "max-links": { type: "string" },
        timeout: { type: "string" },
        "fail-under": { type: "string" },
        "allow-private": { type: "boolean" },
        "list-checks": { type: "boolean" },
        "no-color": { type: "boolean" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    fatal(`${e instanceof Error ? e.message : String(e)}\nTry: sitepulse --help`);
  }
  const { values, positionals } = parsed;

  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${pkg.version}\n`);
  if (values["list-checks"]) {
    for (const c of CHECKS) process.stdout.write(`${c.id.padEnd(22)} ${c.category.padEnd(14)} weight ${String(c.weight).padEnd(2)} ${c.title}\n`);
    return;
  }

  // `npx sitepulse mcp` starts the MCP server, so the plain package name works in an MCP client's configuration
  // (npx runs the bin named like the package, which is this one)
  if (positionals.length === 1 && positionals[0] === "mcp") {
    await import("./mcp.js");
    return;
  }

  const target = positionals[0];
  if (!target || positionals.length > 1) fatal("give exactly one web address, for example: sitepulse example.com");

  const int = (name: string, v: string | undefined, lo: number, hi: number): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) fatal(`--${name} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  const only = values.only
    ? values.only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : undefined;
  if (only) for (const c of only) if (!(CATEGORIES as readonly string[]).includes(c)) fatal(`unknown category "${c}" (choose from ${CATEGORIES.join(", ")})`);
  const failUnder = int("fail-under", values["fail-under"], 0, 100);

  try {
    const report = await scan(target, {
      categories: only as Category[] | undefined,
      maxLinks: int("max-links", values["max-links"], 0, 30),
      timeoutMs: int("timeout", values.timeout, 500, 60000),
      allowPrivate: values["allow-private"] || process.env["SITEPULSE_ALLOW_PRIVATE"] === "1",
    });
    if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (values.markdown || values.md) process.stdout.write(formatMarkdown(report));
    else process.stdout.write(`${formatText(report, { color: !values["no-color"] && !!process.stdout.isTTY && !process.env["NO_COLOR"] })}\n`);

    // (exitCode, not process.exit: exiting straight after a large write can cut the output short when it goes to a pipe)
    const couldNotLoad = report.notes.some((n) => n.startsWith("The scan stopped"));
    if (couldNotLoad) process.exitCode = 1;
    else if (failUnder !== undefined && report.score < failUnder) {
      process.stderr.write(`sitepulse: score ${report.score} is below --fail-under ${failUnder}\n`);
      process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ScanError) fatal(e.message);
    throw e;
  }
}

main().catch((e) => fatal(e instanceof Error ? e.message : String(e), 2));
