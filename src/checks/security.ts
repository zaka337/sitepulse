import { absolute } from "../html.js";
import { fail, pass, sample, skip, warn, type CheckDef, type Ctx } from "./types.js";

const header = (c: Ctx, name: string) => c.page.headers[name];

/** Pull the directive values out of a Content-Security-Policy header: { "script-src": ["'self'", ...], ... } */
export function parseCsp(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of value.split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = vals;
  }
  return out;
}

interface Cookie { name: string; secure: boolean; httpOnly: boolean; sameSite: string | null }
export function parseCookie(line: string): Cookie {
  const [first = "", ...attrs] = line.split(";").map((s) => s.trim());
  const name = first.split("=")[0] ?? "";
  const flags = attrs.map((a) => a.toLowerCase());
  const same = flags.find((a) => a.startsWith("samesite="));
  return { name, secure: flags.includes("secure"), httpOnly: flags.includes("httponly"), sameSite: same ? same.split("=")[1] ?? "" : null };
}

const SESSION_LIKE = /sess|auth|token|sid|jwt|login|csrf|xsrf/i;

export const securityChecks: CheckDef[] = [
  {
    id: "sec-https",
    category: "security",
    title: "Served over HTTPS",
    description: "Whether the page is delivered over an encrypted connection. Without it anyone on the network can read or change what visitors see.",
    weight: 10,
    run: (c) =>
      c.isHttps
        ? pass("The page is served over HTTPS.")
        : fail("The page is served over plain HTTP, so it is not encrypted.", "Serve the whole site over HTTPS (hosts such as Vercel, Netlify and Cloudflare do this for free; otherwise use Let's Encrypt) and redirect HTTP to it."),
  },
  {
    id: "sec-http-redirect",
    category: "security",
    title: "HTTP redirects to HTTPS",
    description: "Whether http://your-site sends people to the HTTPS version. Visitors and old links still use http://.",
    weight: 5,
    needs: ["httpVariant"],
    run: (c) => {
      if (!c.isHttps) return skip("The site is not on HTTPS, so there is nothing to redirect to.");
      const p = c.extras.httpVariant;
      if (!p) return skip("Not checked.");
      if (!p.ok) return warn("http:// does not answer, so someone who types it gets an error.", "Answer on port 80 with a permanent redirect (301 or 308) to the HTTPS address.");
      const s = p.res.status;
      const loc = p.res.headers["location"] ?? "";
      if (s >= 300 && s < 400 && /^https:/i.test(absolute(loc, p.res.finalUrl) ?? "")) return pass(`http:// redirects to HTTPS (${s}).`);
      if (s >= 200 && s < 300) return fail("http:// serves the page without redirecting, so people can stay on the unencrypted version.", "Redirect all HTTP requests to HTTPS with a 301 or 308.");
      return warn(`http:// answers with status ${s}, which is not a redirect to HTTPS.`, "Redirect all HTTP requests to HTTPS with a 301 or 308.");
    },
  },
  {
    id: "sec-hsts",
    category: "security",
    title: "Strict-Transport-Security (HSTS)",
    description: "The header that tells browsers to use HTTPS only for this site, for a long time. It stops downgrade attacks after the first visit.",
    weight: 6,
    run: (c) => {
      if (!c.isHttps) return skip("HSTS only applies to HTTPS sites.");
      const v = header(c, "strict-transport-security");
      if (!v) return fail("No Strict-Transport-Security header.", "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every HTTPS response.");
      const age = Number(/max-age=(\d+)/i.exec(v)?.[1] ?? 0);
      if (age < 15_552_000) return warn(`HSTS is on but short (max-age ${age} seconds, under 180 days).`, "Raise max-age to at least 15552000 (180 days); one year (31536000) is the usual value.");
      return pass(`HSTS is on (max-age ${Math.round(age / 86400)} days${/includesubdomains/i.test(v) ? ", includes subdomains" : ""}).`);
    },
  },
  {
    id: "sec-csp",
    category: "security",
    title: "Content-Security-Policy",
    description: "A policy that limits where scripts and other resources may load from. It is the strongest defence against injected scripts (XSS).",
    weight: 5,
    run: (c) => {
      const enforced = header(c, "content-security-policy");
      const reportOnly = header(c, "content-security-policy-report-only");
      if (!enforced && !reportOnly) return warn("No Content-Security-Policy header.", "Add a policy, starting from `default-src 'self'` and allowing only what the site really loads. Test it with the report-only header first.");
      if (!enforced) return warn("A Content-Security-Policy is only in report-only mode, so it blocks nothing yet.", "Once the reports are clean, send it as Content-Security-Policy.");
      const p = parseCsp(enforced);
      const scripts = p["script-src"] ?? p["default-src"] ?? [];
      // Each problem comes with its own advice, so the fix names only what was actually found
      // (it once said "remove 'unsafe-eval'" to a site that only had 'unsafe-inline').
      const problems: string[] = [];
      const fixes: string[] = [];
      if (scripts.includes("'unsafe-eval'")) {
        problems.push("script-src allows 'unsafe-eval'");
        fixes.push("Remove 'unsafe-eval' from script-src.");
      }
      if (scripts.includes("'unsafe-inline'") && !scripts.some((s) => s.startsWith("'nonce-") || s.startsWith("'sha"))) {
        problems.push("script-src allows 'unsafe-inline' without nonces or hashes");
        fixes.push("Replace 'unsafe-inline' for scripts with nonces or hashes.");
      }
      if (scripts.includes("*")) {
        problems.push("script-src allows scripts from anywhere (*)");
        fixes.push("List the hosts scripts may load from instead of *.");
      }
      if (!p["script-src"] && !p["default-src"]) {
        problems.push("no script-src or default-src");
        fixes.push("Add default-src 'self' (or a script-src) so scripts are restricted.");
      }
      return problems.length
        ? warn("A Content-Security-Policy is set but it is weak.", fixes.join(" "), problems)
        : pass("A Content-Security-Policy is set and restricts scripts.");
    },
  },
  {
    id: "sec-nosniff",
    category: "security",
    title: "X-Content-Type-Options",
    description: "Stops browsers from guessing a file's type, which attackers can use to run an uploaded file as a script.",
    weight: 3,
    run: (c) => (/nosniff/i.test(header(c, "x-content-type-options") ?? "") ? pass("X-Content-Type-Options: nosniff is set.") : warn("No `X-Content-Type-Options: nosniff` header.", "Send `X-Content-Type-Options: nosniff` on every response.")),
  },
  {
    id: "sec-framing",
    category: "security",
    title: "Clickjacking protection",
    description: "Whether other sites can put this page in a frame (X-Frame-Options or the CSP frame-ancestors directive). Framing is how clickjacking works.",
    weight: 3,
    run: (c) => {
      const xfo = header(c, "x-frame-options");
      const fa = parseCsp(header(c, "content-security-policy") ?? "")["frame-ancestors"];
      if (fa) return pass("The page limits who may frame it (CSP frame-ancestors).");
      if (xfo && /deny|sameorigin/i.test(xfo)) return pass(`The page limits framing (X-Frame-Options: ${xfo}).`);
      return warn("Nothing stops other sites from framing this page.", "Send `Content-Security-Policy: frame-ancestors 'self'` (or `X-Frame-Options: SAMEORIGIN`).");
    },
  },
  {
    id: "sec-referrer",
    category: "security",
    title: "Referrer-Policy",
    description: "Controls how much of the page address is sent to other sites when someone clicks a link or a resource loads.",
    weight: 2,
    run: (c) => {
      const v = (header(c, "referrer-policy") ?? "").toLowerCase();
      if (!v) return warn("No Referrer-Policy header.", "Send `Referrer-Policy: strict-origin-when-cross-origin` (or stricter).");
      if (/unsafe-url|no-referrer-when-downgrade/.test(v)) return warn(`Referrer-Policy is ${v}, which sends full addresses to other sites.`, "Use `strict-origin-when-cross-origin`, `same-origin` or `no-referrer`.");
      return pass(`Referrer-Policy is ${v}.`);
    },
  },
  {
    id: "sec-permissions",
    category: "security",
    title: "Permissions-Policy",
    description: "Lets the site switch off powerful browser features (camera, microphone, location...) it does not use, including for embedded frames.",
    weight: 1,
    run: (c) => (header(c, "permissions-policy") || header(c, "feature-policy") ? pass("A Permissions-Policy is set.") : warn("No Permissions-Policy header.", "Send `Permissions-Policy: camera=(), microphone=(), geolocation=()` for features the site does not use.")),
  },
  {
    id: "sec-cookies",
    category: "security",
    title: "Cookie flags",
    description: "Whether cookies set by the page are marked Secure, SameSite and (for session-like cookies) HttpOnly.",
    weight: 4,
    run: (c) => {
      if (c.page.setCookies.length === 0) return skip("The page sets no cookies.");
      const cookies = c.page.setCookies.map(parseCookie);
      const problems: string[] = [];
      for (const k of cookies) {
        const missing: string[] = [];
        if (c.isHttps && !k.secure) missing.push("Secure");
        if (!k.sameSite) missing.push("SameSite");
        if (SESSION_LIKE.test(k.name) && !k.httpOnly) missing.push("HttpOnly");
        if (missing.length) problems.push(`${k.name || "(unnamed)"}: missing ${missing.join(", ")}`);
      }
      return problems.length
        ? warn(`${problems.length} of ${cookies.length} cookies are missing protective flags.`, "Add Secure, SameSite=Lax (or Strict) and, for session or token cookies, HttpOnly.", sample(problems))
        : pass(`All ${cookies.length} cookies have the protective flags.`);
    },
  },
  {
    id: "sec-mixed-content",
    category: "security",
    title: "No mixed content",
    description: "An HTTPS page that loads scripts, styles, frames or images over plain HTTP. Browsers block the risky ones and the page breaks, or warn.",
    weight: 4,
    run: (c) => {
      if (!c.isHttps || !c.root) return skip("Only applies to an HTML page served over HTTPS.");
      const active: string[] = [];
      const passive: string[] = [];
      const add = (list: string[], sel: string, attr: string) => {
        for (const el of c.root!.querySelectorAll(sel)) {
          const v = el.getAttribute(attr) ?? "";
          if (/^http:\/\//i.test(v)) list.push(v);
        }
      };
      add(active, "script[src]", "src");
      add(active, "link[rel=stylesheet]", "href");
      add(active, "iframe[src]", "src");
      add(active, "form[action]", "action");
      add(passive, "img[src]", "src");
      add(passive, "audio[src], video[src], source[src]", "src");
      if (active.length) return fail(`${active.length} script, style, frame or form address(es) use plain HTTP on an HTTPS page.`, "Change them to https:// (or protocol-relative paths) so the browser does not block them.", sample(active));
      if (passive.length) return warn(`${passive.length} image or media address(es) use plain HTTP on an HTTPS page.`, "Change them to https://.", sample(passive));
      return pass("Nothing on the page is loaded over plain HTTP.");
    },
  },
  {
    id: "sec-server-leak",
    category: "security",
    title: "Server version not disclosed",
    description: "Headers like `Server: nginx/1.18.0` or `X-Powered-By: PHP/7.4` tell attackers exactly which known flaws to try.",
    weight: 1,
    run: (c) => {
      const found: string[] = [];
      const server = header(c, "server");
      if (server && /\d+\.\d+/.test(server)) found.push(`Server: ${server}`);
      const powered = header(c, "x-powered-by");
      if (powered) found.push(`X-Powered-By: ${powered}`);
      return found.length ? warn("Response headers reveal the server software.", "Remove X-Powered-By and hide the version number in the Server header.", found) : pass("No software versions are revealed in the headers.");
    },
  },
];
