import { accessibleName, clean, meta } from "../html.js";
import { fail, pass, sample, skip, warn, type CheckDef, type Ctx } from "./types.js";

/* These are the quick, automatic accessibility checks: things a script can know for sure. They catch the common
   mistakes, but passing them does not make a page accessible (that needs people, a keyboard and a screen reader). */

const needsHtml = (c: Ctx) => (c.root ? null : skip("The address did not return an HTML page."));

const NOT_LABELLED = new Set(["hidden", "submit", "button", "reset", "image"]);

export const accessibilityChecks: CheckDef[] = [
  {
    id: "a11y-img-alt",
    category: "accessibility",
    title: "Images have alt text",
    description: "Every <img> needs an alt attribute: a description for screen reader users, or an empty alt for decorative images.",
    weight: 4,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const imgs = c.root!.querySelectorAll("img");
      if (imgs.length === 0) return skip("The page has no images.");
      const missing = imgs.filter((i) => !i.hasAttribute("alt") && i.getAttribute("role") !== "presentation" && i.getAttribute("aria-hidden") !== "true");
      if (missing.length === 0) return pass(`All ${imgs.length} images have an alt attribute.`);
      const detail = missing.map((i) => clean(i.getAttribute("src")).slice(0, 100) || "(no src)");
      const msg = `${missing.length} of ${imgs.length} images have no alt attribute.`;
      const fix = "Add alt=\"...\" describing each image, or alt=\"\" if it is purely decorative.";
      return missing.length / imgs.length > 0.3 ? fail(msg, fix, sample(detail)) : warn(msg, fix, sample(detail));
    },
  },
  {
    id: "a11y-form-labels",
    category: "accessibility",
    title: "Form fields have labels",
    description: "Every input needs a visible or programmatic label so people using screen readers know what to type.",
    weight: 4,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const root = c.root!;
      const fields = root.querySelectorAll("input, select, textarea").filter((f) => !NOT_LABELLED.has((f.getAttribute("type") ?? "").toLowerCase()));
      if (fields.length === 0) return skip("The page has no form fields.");
      const forIds = new Set(root.querySelectorAll("label").map((l) => l.getAttribute("for")).filter((v): v is string => !!v));
      const unlabelled = fields.filter((f) => {
        const id = f.getAttribute("id");
        if (id && forIds.has(id)) return false;
        if (clean(f.getAttribute("aria-label")) || f.getAttribute("aria-labelledby") || clean(f.getAttribute("title"))) return false;
        let p = f.parentNode;
        while (p) { if ((p as { tagName?: string }).tagName?.toLowerCase() === "label") return false; p = p.parentNode; }
        return true;
      });
      if (unlabelled.length === 0) return pass(`All ${fields.length} form fields have a label.`);
      return fail(`${unlabelled.length} of ${fields.length} form fields have no label.`, "Connect each field to a <label for=\"id\"> (placeholder text is not a label), or add aria-label.", sample(unlabelled.map((f) => `<${f.tagName.toLowerCase()} ${clean(f.getAttribute("name") ?? f.getAttribute("id") ?? f.getAttribute("type") ?? "")}>`)));
    },
  },
  {
    id: "a11y-link-names",
    category: "accessibility",
    title: "Links and buttons have names",
    description: "A link or button with no text (an icon with no label) is announced as just \"link\" or \"button\" by screen readers.",
    weight: 3,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const els = c.root!.querySelectorAll("a[href], button");
      if (els.length === 0) return skip("The page has no links or buttons.");
      const empty = els.filter((e) => !accessibleName(e));
      if (empty.length === 0) return pass(`All ${els.length} links and buttons have a name.`);
      return warn(`${empty.length} of ${els.length} links or buttons have no accessible name.`, "Add visible text, an aria-label, or alt text on the icon inside.", sample(empty.map((e) => e.outerHTML.slice(0, 90))));
    },
  },
  {
    id: "a11y-headings",
    category: "accessibility",
    title: "Heading order",
    description: "Headings should go down one level at a time (h1, h2, h3). Skipping from h2 to h4 breaks the outline that screen reader users navigate by.",
    weight: 2,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const levels = c.root!.querySelectorAll("h1, h2, h3, h4, h5, h6").map((h) => Number(h.tagName.slice(1)));
      if (levels.length === 0) return skip("The page has no headings.");
      const jumps: string[] = [];
      let prev = 0;
      for (const l of levels) {
        if (prev && l > prev + 1) jumps.push(`h${prev} followed by h${l}`);
        prev = l;
      }
      return jumps.length ? warn(`${jumps.length} place(s) where the heading level jumps.`, "Do not skip levels: after an h2 use an h3, not an h4.", sample(jumps)) : pass("Headings go down one level at a time.");
    },
  },
  {
    id: "a11y-zoom",
    category: "accessibility",
    title: "Pinch zoom allowed",
    description: "A viewport that disables zooming (user-scalable=no, maximum-scale=1) shuts out people who need to enlarge text.",
    weight: 2,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const v = meta(c.root!, "viewport");
      if (v === undefined) return skip("No viewport tag.");
      const max = Number(/maximum-scale\s*=\s*([\d.]+)/i.exec(v)?.[1] ?? NaN);
      if (/user-scalable\s*=\s*(no|0)/i.test(v) || (Number.isFinite(max) && max < 2)) return fail(`The viewport blocks zooming ("${v}").`, "Remove user-scalable=no and maximum-scale from the viewport tag.");
      return pass("Zooming is not blocked.");
    },
  },
  {
    id: "a11y-landmarks",
    category: "accessibility",
    title: "Main landmark",
    description: "A <main> element lets keyboard and screen reader users jump straight past the navigation to the content.",
    weight: 1,
    run: (c) => {
      const r = needsHtml(c);
      if (r) return r;
      const root = c.root!;
      return root.querySelector("main") || root.querySelector("[role=main]") ? pass("The page has a main landmark.") : warn("No <main> element.", "Wrap the page's primary content in <main>.");
    },
  },
];
