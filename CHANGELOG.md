# Changelog

## Unreleased

- Fixed: the Content-Security-Policy advice named every possible problem, whichever one was found (a site with only `'unsafe-inline'` was told to remove `'unsafe-eval'`). Each problem now has its own advice, and only the ones found are shown.

## 0.1.0

First release.

- 35 checks in five categories (security, SEO, performance, accessibility, links), scored 0 to 100 with a letter grade, each finding with a suggested fix.
- Command line (`sitepulse <url>`) with text, Markdown and JSON output, `--only`, `--max-links`, `--timeout`, `--fail-under` for CI.
- MCP server (`sitepulse mcp` or `sitepulse-mcp`) with two read-only tools, `scan_website` and `list_checks`.
- Library API (`scan`, `formatText`, `formatMarkdown`, `topIssues`, ...).
- Safe fetching: private, local and reserved addresses refused by default (including disguised forms), checked again at connection time and on every redirect; size, time and redirect limits; no cookies or credentials sent.
