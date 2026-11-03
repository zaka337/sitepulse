/* sitepulse: a quick health check of a website's security headers, SEO basics, performance hints, accessibility basics
   and broken links. No browser needed. Use it as a library (this file), a command line tool (cli.ts) or an MCP server
   for AI assistants (mcp.ts).

     import { scan, formatMarkdown } from "sitepulse";
     const report = await scan("https://example.com");
     console.log(report.score, report.grade);
*/

export { scan, describeNetworkError } from "./scan.js";
export { CHECKS } from "./checks/index.js";
export { formatText, formatMarkdown, topIssues } from "./report.js";
export { gradeFor, scoreOf } from "./score.js";
export { assertAllowedUrl, isBlockedAddress, normalizeInput } from "./net/guard.js";
export { fetchUrl, DEFAULT_USER_AGENT } from "./net/fetcher.js";
export { CATEGORIES, ScanError } from "./types.js";
export type { Category, CategoryScore, CheckResult, Grade, Report, ScanErrorCode, ScanOptions, Status } from "./types.js";
export type { CheckDef } from "./checks/types.js";
export type { Fetched, FetchOptions } from "./net/fetcher.js";
