/* The shapes shared by the whole package. A scan produces a Report: one CheckResult per check, a score per category and
   an overall score. Everything a front end needs (the CLI, the MCP server, a web page) is in the Report, so none of them
   has to know how a check works. */

export const CATEGORIES = ["security", "seo", "performance", "accessibility", "links"] as const;
export type Category = (typeof CATEGORIES)[number];

/** pass: fine. warn: worth fixing. fail: a real problem. skip: could not be checked (counts for nothing either way). */
export type Status = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  category: Category;
  title: string;
  status: Status;
  /** What was found, in one sentence */
  message: string;
  /** What to do about it (only when there is something to do) */
  fix?: string;
  /** Specifics: the broken links, the cookies without flags... */
  details?: string[];
  /** How much this check counts in the score */
  weight: number;
}

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface CategoryScore {
  /** 0 to 100, or null when nothing in the category could be checked */
  score: number | null;
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface Report {
  /** What was asked for, and where it ended up after redirects */
  url: string;
  finalUrl: string;
  scannedAt: string;
  durationMs: number;
  score: number;
  grade: Grade;
  categories: Record<Category, CategoryScore>;
  summary: { pass: number; warn: number; fail: number; skip: number };
  results: CheckResult[];
  /** Things worth knowing about the scan itself (a truncated page, a slow link check...) */
  notes: string[];
}

export interface ScanOptions {
  /** Longest wait for one request, in ms (default 8000) */
  timeoutMs?: number;
  /** Longest the whole scan may take, in ms (default 15000) */
  budgetMs?: number;
  /** How many links to try (0 turns the link check off; default 12, at most 30) */
  maxLinks?: number;
  /** Only run these categories (default: all) */
  categories?: readonly Category[];
  /**
   * Allow addresses on private networks (localhost, 192.168.x.x ...). Off by default: a scanner that fetches whatever it is
   * told to is an easy way to reach things behind a firewall. Turn it on to check a site you are developing locally.
   */
  allowPrivate?: boolean;
  /** Ports that may be requested (default 80 and 443; "any" with allowPrivate for local development servers) */
  allowedPorts?: readonly number[] | "any";
  userAgent?: string;
  signal?: AbortSignal;
}

/** Why a scan could not even start. These are the caller's problem (a bad or refused URL), not a failed check. */
export type ScanErrorCode =
  | "invalid-url"
  | "bad-protocol"
  | "credentials-in-url"
  | "port-not-allowed"
  | "blocked-host"
  | "blocked-address"
  | "too-many-redirects"
  | "timeout"
  | "aborted";

export class ScanError extends Error {
  readonly code: ScanErrorCode;
  constructor(code: ScanErrorCode, message: string) {
    super(message);
    this.name = "ScanError";
    this.code = code;
  }
}
