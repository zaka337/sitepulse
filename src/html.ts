import { parse, type HTMLElement } from "node-html-parser";

/* Small helpers over node-html-parser, so the checks read as what they check and not as DOM plumbing. */

export type Root = HTMLElement;

export function parseHtml(html: string): Root {
  return parse(html, { comment: false });
}

/** The content of <meta name="..."> or <meta property="..."> (names are case-insensitive) */
export function meta(root: Root, key: string): string | undefined {
  const want = key.toLowerCase();
  for (const m of root.querySelectorAll("meta")) {
    const k = (m.getAttribute("name") ?? m.getAttribute("property") ?? "").toLowerCase();
    if (k === want) return m.getAttribute("content") ?? "";
  }
  return undefined;
}

/** All <link rel="..."> whose rel list contains the word */
export function linksWithRel(root: Root, rel: string) {
  const want = rel.toLowerCase();
  return root.querySelectorAll("link").filter((l) => (l.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes(want));
}

/** Collapse whitespace so a title spread over three lines counts as one line */
export const clean = (s: string | undefined | null): string => (s ?? "").replace(/\s+/g, " ").trim();

/** The text a person or a screen reader would get from an element: its text, else aria-label, title, or an image's alt */
export function accessibleName(el: Root): string {
  const text = clean(el.text);
  if (text) return text;
  const label = clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title"));
  if (label) return label;
  if (el.getAttribute("aria-labelledby")) return "(labelled by another element)";
  for (const img of el.querySelectorAll("img")) {
    const alt = clean(img.getAttribute("alt"));
    if (alt) return alt;
  }
  for (const svg of el.querySelectorAll("svg")) {
    const t = clean(svg.querySelector("title")?.text) || clean(svg.getAttribute("aria-label"));
    if (t) return t;
  }
  return "";
}

/** A relative or absolute reference turned into an absolute URL, or null when it cannot be one */
export function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}
