import type { Fetched } from "../net/fetcher.js";
import type { Root } from "../html.js";
import type { Category, ScanOptions, Status } from "../types.js";

/* A check is one small question about the page ("does it send an HSTS header?"). It is a pure function of what was
   fetched, so every check can be tested by handing it a made-up page, with no network and no server. */

/** The answer of a request made for a check (robots.txt, the sitemap...): got an answer, or an error to report */
export type Probe = { ok: true; res: Fetched } | { ok: false; error: string };

export type LinkKind = "ok" | "broken" | "blocked" | "skipped";
export interface LinkProbe {
  url: string;
  internal: boolean;
  status: number | null;
  kind: LinkKind;
  note: string;
}

/** Everything a check may look at */
export interface Ctx {
  opts: Required<Pick<ScanOptions, "maxLinks">>;
  /** The page as first requested, and the answer after redirects */
  inputUrl: string;
  page: Fetched;
  isHttps: boolean;
  isHtml: boolean;
  /** The parsed page (null when the answer was not HTML) */
  root: Root | null;
  extras: {
    robots?: Probe;
    sitemap?: Probe;
    httpVariant?: Probe;
    favicon?: Probe;
    links?: LinkProbe[];
  };
}

export type Extra = keyof Ctx["extras"];

export interface Outcome {
  status: Status;
  message: string;
  fix?: string;
  details?: string[];
}

export interface CheckDef {
  id: string;
  category: Category;
  title: string;
  /** What the check looks at and why it matters (shown by `list_checks` and in the docs) */
  description: string;
  weight: number;
  /** Extra requests this check needs the scanner to make first */
  needs?: readonly Extra[];
  run(ctx: Ctx): Outcome;
}

export const pass = (message: string): Outcome => ({ status: "pass", message });
export const warn = (message: string, fix?: string, details?: string[]): Outcome => ({ status: "warn", message, fix, details });
export const fail = (message: string, fix?: string, details?: string[]): Outcome => ({ status: "fail", message, fix, details });
export const skip = (message: string): Outcome => ({ status: "skip", message });

/** A few items for the "details" list, with "and N more" when there are many */
export function sample(items: string[], max = 5): string[] {
  return items.length <= max ? items : [...items.slice(0, max), `and ${items.length - max} more`];
}
