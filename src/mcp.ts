#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { CHECKS } from "./checks/index.js";
import { formatMarkdown } from "./report.js";
import { scan } from "./scan.js";
import { CATEGORIES, ScanError } from "./types.js";

/* The MCP server: lets an AI assistant (Claude, Cursor, VS Code Copilot, ...) check a website's health as a tool call.
   It runs on your machine over stdio. Two tools, both read-only:
     scan_website  - run the checks against a URL and get the report
     list_checks   - describe what is checked
   Addresses on private networks are refused unless SITEPULSE_ALLOW_PRIVATE=1 is set in the server's environment, so an
   assistant that is tricked by a hostile web page cannot be steered into probing your internal network. */

const allowPrivate = process.env["SITEPULSE_ALLOW_PRIVATE"] === "1";

const server = new McpServer(
  { name: "sitepulse", version: pkg.version },
  {
    instructions:
      "Use scan_website to check the health of a public website: security headers, SEO basics, performance hints, accessibility basics and broken links. " +
      "It returns a score, a grade and each finding with how to fix it. It needs no browser and changes nothing on the site. " +
      "Use list_checks to see exactly what is checked. Findings are automatic checks, not a full audit: say so when you summarise them.",
  },
);

const issueShape = z.object({
  id: z.string(),
  category: z.enum(CATEGORIES),
  title: z.string(),
  status: z.enum(["warn", "fail"]),
  message: z.string(),
  fix: z.string().optional(),
  details: z.array(z.string()).optional(),
});

server.registerTool(
  "scan_website",
  {
    title: "Scan a website",
    description:
      "Check a website's health in a few seconds: security headers (HTTPS, HSTS, CSP...), SEO basics (title, description, headings, sitemap...), performance hints (response time, compression), accessibility basics (alt text, labels, headings) and broken links. Returns a 0-100 score, a grade, and every problem found with a suggested fix. Read-only.",
    inputSchema: {
      url: z.string().min(1).describe("The page to check, for example https://example.com or just example.com"),
      categories: z.array(z.enum(CATEGORIES)).optional().describe("Only run these categories (default: all)"),
      maxLinks: z.number().int().min(0).max(30).optional().describe("How many links on the page to test (default 12, 0 turns link checking off)"),
    },
    outputSchema: {
      finalUrl: z.string(),
      score: z.number(),
      grade: z.string(),
      summary: z.object({ pass: z.number(), warn: z.number(), fail: z.number(), skip: z.number() }),
      categoryScores: z.record(z.string(), z.number().nullable()),
      issues: z.array(issueShape),
      notes: z.array(z.string()),
    },
    annotations: { title: "Scan a website", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ url, categories, maxLinks }) => {
    try {
      const report = await scan(url, { categories, maxLinks, allowPrivate });
      const issues = report.results
        .filter((r): r is typeof r & { status: "warn" | "fail" } => r.status === "warn" || r.status === "fail")
        .map((r) => ({ id: r.id, category: r.category, title: r.title, status: r.status, message: r.message, fix: r.fix, details: r.details }));
      return {
        content: [{ type: "text" as const, text: formatMarkdown(report) }],
        structuredContent: {
          finalUrl: report.finalUrl,
          score: report.score,
          grade: report.grade,
          summary: report.summary,
          categoryScores: Object.fromEntries(CATEGORIES.map((c) => [c, report.categories[c].score])),
          issues,
          notes: report.notes,
        },
      };
    } catch (e) {
      const message = e instanceof ScanError ? e.message : `The scan failed: ${e instanceof Error ? e.message : String(e)}`;
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  },
);

server.registerTool(
  "list_checks",
  {
    title: "List the checks",
    description: "List every check scan_website runs: its id, category, weight in the score, and what it looks at.",
    inputSchema: {},
    annotations: { title: "List the checks", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => ({
    content: [{ type: "text" as const, text: CHECKS.map((c) => `- ${c.id} (${c.category}, weight ${c.weight}): ${c.title}. ${c.description}`).join("\n") }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`sitepulse MCP server ${pkg.version} ready${allowPrivate ? " (private addresses allowed)" : ""}\n`);
