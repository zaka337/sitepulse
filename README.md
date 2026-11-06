# sitepulse

A quick health check for any website. One command (or one tool call from an AI assistant) fetches a page and tells you, with a score and a fix for each finding:

- **Security**: HTTPS, HSTS, Content-Security-Policy, clickjacking and MIME-sniffing protection, cookie flags, mixed content
- **SEO**: title, description, headings, canonical address, language, social tags, robots.txt, sitemap, structured data
- **Performance**: server response time, compression, page size, redirect chains
- **Accessibility**: alt text, form labels, link and button names, heading order, pinch zoom, landmarks
- **Links**: a sample of the page's links, checked for ones that are broken

It needs no browser and no account, makes a handful of requests (the page, `robots.txt`, the sitemap, a sample of links), changes nothing on the site, and finishes in a few seconds.

```text
$ npx sitepulse example.com

sitepulse report: https://example.com/
Score 67/100 (grade D)   14 passed, 11 to improve, 4 failed, 6 skipped   0.4 s

Security  55/100
  pass  Served over HTTPS: The page is served over HTTPS.
  FAIL  Strict-Transport-Security (HSTS): No Strict-Transport-Security header.
        fix: Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every HTTPS response.
  warn  Content-Security-Policy: No Content-Security-Policy header.
        fix: Add a policy, starting from `default-src 'self'` and allowing only what the site really loads. ...
  ...
```

## Use it

### Command line

```bash
npx sitepulse https://your-site.com
npx sitepulse your-site.com --markdown > report.md     # paste into an issue or a chat
npx sitepulse your-site.com --json                      # the whole report as data
npx sitepulse your-site.com --only security,seo         # some categories only
npx sitepulse your-site.com --fail-under 80             # exit code 1 below a score (for CI)
npx sitepulse http://localhost:3000 --allow-private     # your own dev server
```

| Option | Meaning |
|---|---|
| `--json` | Print the whole report as JSON |
| `--markdown`, `--md` | Print the report as Markdown |
| `--only <list>` | Only these categories: `security,seo,performance,accessibility,links` |
| `--max-links <n>` | How many links to try, 0 to 30 (default 12; 0 turns the link check off) |
| `--timeout <ms>` | Longest wait for one request (default 8000) |
| `--fail-under <n>` | Exit with code 1 if the score is below `n` |
| `--allow-private` | Allow localhost and private-network addresses (see [Safety](#safety)) |
| `--list-checks` | List every check |
| `--no-color` | No colours (they are already off when the output is not a terminal) |

Exit codes: `0` ok, `1` the score is below `--fail-under` or the page could not be loaded, `2` a bad option or a refused address.

### In CI

```yaml
- name: Website health
  run: npx sitepulse https://staging.your-site.com --fail-under 85
```

### With an AI assistant (MCP)

`sitepulse` is also a [Model Context Protocol](https://modelcontextprotocol.io) server, so an assistant can check a site as part of a conversation ("is my staging site missing any security headers?"). It runs on your machine over stdio and offers two read-only tools: `scan_website` and `list_checks`.

Claude Code:

```bash
claude mcp add sitepulse -- npx -y sitepulse mcp
```

Claude Desktop (`claude_desktop_config.json`) and Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sitepulse": { "command": "npx", "args": ["-y", "sitepulse", "mcp"] }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "sitepulse": { "type": "stdio", "command": "npx", "args": ["-y", "sitepulse", "mcp"] }
  }
}
```

`scan_website` returns the report as Markdown and as structured data (score, grade, per-category scores, and every problem with its fix). Its name in the official MCP Registry is `io.github.zaka337/sitepulse`.

### As a library

```ts
import { scan, formatMarkdown } from "sitepulse";

const report = await scan("https://your-site.com", { maxLinks: 20 });
console.log(report.score, report.grade);                 // 87 "B"
for (const r of report.results) {
  if (r.status === "fail") console.log(r.title, "-", r.fix);
}
console.log(formatMarkdown(report));
```

`scan()` returns a `Report` (typed, see `dist/index.d.ts`). It throws a `ScanError` with a `code` when the address itself is refused (`blocked-address`, `bad-protocol`, ...). A site that cannot be reached is not an exception: it comes back as a report with a failed "page loads" check, so a monitoring loop does not need a `try`/`catch` for ordinary outages.

## What it checks

| Category | Checks |
|---|---|
| Security (11) | HTTPS, HTTP-to-HTTPS redirect, HSTS, Content-Security-Policy (and whether it is weak), `nosniff`, clickjacking protection, Referrer-Policy, Permissions-Policy, cookie flags, mixed content, server version disclosure |
| SEO (13) | Status 200, title, meta description, one `h1`, canonical, `lang`, viewport, Open Graph tags, `noindex`, robots.txt (and that it does not block everything), XML sitemap (found through robots.txt too), JSON-LD validity, favicon |
| Performance (4) | Time to first byte, compression, HTML size, redirect chain |
| Accessibility (6) | Image alt text, form labels, link and button names, heading order, pinch zoom not disabled, `main` landmark |
| Links (1) | A sample of the page's links, mostly its own: broken ones reported, sites that refuse robots (403, 429) reported as "could not be verified" rather than broken |

`sitepulse --list-checks` prints them all, and the `description` of each check says exactly what it looks at.

### How the score works

Every check has a weight (HTTPS counts 10, a favicon counts 1). A pass earns all of its weight, a warning half, a failure none. A check that does not apply (no forms on the page, so nothing to label) is left out of the arithmetic instead of counting for or against. The score is points earned out of points possible, 0 to 100, for the whole scan and for each category. Grades: A from 90, B from 80, C from 70, D from 55.

The weights are opinions. They are all in one place per check (`src/checks/`), so changing what matters to you is a one-line edit.

## Safety

A tool that fetches whatever address it is given is a classic way to reach things you are not meant to reach (a cloud provider's metadata service, an admin panel behind a firewall). That is especially true when the address comes from a web form, or from an AI assistant that a hostile web page might be steering. So the fetching is the most carefully built part of this package, and it is tested by attack (`test/guard.test.ts`, `test/fetcher.test.ts`, and the refusal cases in the CLI and MCP tests).

By default it refuses:

- every scheme except `http` and `https` (`file:`, `ftp:`, `gopher:`, `data:`, `javascript:`), and URLs that carry a username or password
- ports other than 80 and 443
- local and private names (`localhost`, `*.local`, `*.internal`, `*.corp`, `*.home.arpa`, cloud metadata hostnames)
- private, loopback, link-local, carrier-grade-NAT, multicast, documentation and reserved addresses, in IPv4 and IPv6, including the disguises: `2130706433`, `0x7f000001`, `017700000001`, `127.1`, `::ffff:127.0.0.1`, NAT64 and 6to4 forms that wrap a private address

Two things make that more than a list of strings:

1. **The check happens at the moment of connecting.** A name that looks public can resolve to a private address (and an attacker can change the answer between your check and your connection: "DNS rebinding"). The package resolves the name itself, refuses if *any* of the returned addresses is private, and connects to exactly the address it checked.
2. **Every redirect is checked again.** At most 5 are followed, each one by hand, each through the same guard. A public page that redirects to `http://169.254.169.254/` is refused.

Links found on a page are only probed if they pass the same guard, so a page cannot make the scanner touch an internal address by linking to it.

Also: responses are read up to a size cap, after decompression (a tiny "compression bomb" that unpacks to gigabytes is cut off); every request has a time limit and the scan has an overall budget; no cookies or credentials are ever sent; the scanner identifies itself honestly (`sitepulse/0.1 (+https://github.com/zaka337/sitepulse)`); and it never crawls: it fetches the one page you asked for plus `robots.txt`, the sitemap, `/favicon.ico` if the page declares none, and a small sample of links.

To scan a site you are developing, opt in: `--allow-private`, the `allowPrivate` option, or `SITEPULSE_ALLOW_PRIVATE=1` in the environment of the MCP server. The MCP tools have **no** parameter for it: the person who configures the server decides, not the model.

What this does not protect against: you pointing the tool at someone else's public site. It is polite (a few requests, honest user agent), but only scan sites you have a reason to scan.

## Limits (read before trusting a score)

- It reads the **HTML the server sends**. It does not run JavaScript. On a site that builds its page in the browser, the scan sees the empty shell: "no `h1`", "no links" can be true of the HTML and false of what a visitor sees.
- It does **not measure** rendering speed, Core Web Vitals, or layout. "Performance" here means server response time, compression and page size. For real user-facing numbers use Lighthouse or PageSpeed Insights.
- The accessibility checks are a small, reliable subset of WCAG (the kind a static scan can decide). Passing them does not make a site accessible; colour contrast, keyboard use and screen reader behaviour need a human and a browser.
- Time to first byte is measured from where the scan runs, once, so treat it as a hint.
- The link check is a sample (12 by default, 30 at most), not a crawl.
- It does not detect HTTP/2 or HTTP/3.
- The checks encode common good practice. A site can have a good reason to deviate (an intentionally `noindex` staging site), so read a warning as "worth a look", not as an error.

## Development

```bash
npm install
npm run check      # type-check, run the tests, build
```

The tests run against a real local web server and the built command-line and MCP programs (the MCP tests drive the server with the official MCP client over stdio). Nothing in the test suite touches the internet.

Layout: `src/net/guard.ts` and `src/net/fetcher.ts` (the safe HTTP client), `src/checks/*.ts` (each check is a pure function of a fetched page, so each is tested with made-up pages), `src/scan.ts` (fetches what the checks need, in parallel, under a time budget), `src/score.ts`, `src/report.ts`, `src/cli.ts`, `src/mcp.ts`.

## License

MIT. By [Zaka Ullah Waheed](https://zaka-portfolio-two.vercel.app).
