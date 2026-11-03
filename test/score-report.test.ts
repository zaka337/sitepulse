import { describe, expect, it } from "vitest";
import { formatMarkdown, formatText, topIssues } from "../src/report.js";
import { gradeFor, scoreOf, summarise } from "../src/score.js";
import type { Category, CheckResult, Report, Status } from "../src/types.js";

const r = (status: Status, weight = 1, category: Category = "seo", extra: Partial<CheckResult> = {}): CheckResult => ({
  id: `${category}-${Math.random().toString(36).slice(2, 7)}`,
  category,
  title: `A ${status} check`,
  status,
  message: `It is ${status}.`,
  weight,
  ...extra,
});

describe("scoreOf", () => {
  it("is 100 when everything passes and 0 when everything fails", () => {
    expect(scoreOf([r("pass"), r("pass", 5)])).toBe(100);
    expect(scoreOf([r("fail"), r("fail", 5)])).toBe(0);
  });

  it("gives a warning half of its weight", () => {
    expect(scoreOf([r("warn")])).toBe(50);
    expect(scoreOf([r("pass"), r("warn")])).toBe(75);
  });

  it("does not count skipped checks, either way", () => {
    expect(scoreOf([r("pass"), r("skip", 100)])).toBe(100);
    expect(scoreOf([r("fail"), r("skip", 100)])).toBe(0);
  });

  it("is null when there is nothing to score", () => {
    expect(scoreOf([])).toBeNull();
    expect(scoreOf([r("skip"), r("skip")])).toBeNull();
  });

  it("weighs important checks more: one failed heavy check costs more than a failed light one", () => {
    const heavyFails = scoreOf([r("fail", 10), r("pass", 1)])!;
    const lightFails = scoreOf([r("pass", 10), r("fail", 1)])!;
    expect(heavyFails).toBe(9);
    expect(lightFails).toBe(91);
  });

  it("rounds to a whole number", () => {
    expect(scoreOf([r("pass"), r("fail"), r("fail")])).toBe(33);
    expect(scoreOf([r("pass"), r("pass"), r("fail")])).toBe(67);
  });
});

describe("gradeFor", () => {
  it.each([
    [100, "A"], [90, "A"], [89, "B"], [80, "B"], [79, "C"], [70, "C"], [69, "D"], [55, "D"], [54, "F"], [0, "F"],
  ])("%i -> %s", (score, grade) => {
    expect(gradeFor(score)).toBe(grade);
  });
});

describe("summarise", () => {
  const rows = [r("pass", 2, "security"), r("fail", 2, "security"), r("warn", 1, "seo"), r("skip", 1, "seo"), r("pass", 1, "links")];
  const s = summarise(rows);

  it("counts the statuses", () => {
    expect(s.summary).toEqual({ pass: 2, warn: 1, fail: 1, skip: 1 });
  });
  it("scores each category on its own", () => {
    expect(s.categories.security).toEqual({ score: 50, pass: 1, warn: 0, fail: 1, skip: 0 });
    expect(s.categories.seo).toEqual({ score: 50, pass: 0, warn: 1, fail: 0, skip: 1 });
    expect(s.categories.links.score).toBe(100);
  });
  it("gives a category with nothing in it a null score, not 0", () => {
    expect(s.categories.performance).toEqual({ score: null, pass: 0, warn: 0, fail: 0, skip: 0 });
    expect(s.categories.accessibility.score).toBeNull();
  });
  it("scores the whole and grades it", () => {
    // earned 2 + 0 + 0.5 + 1 = 3.5 of 6 possible
    expect(s.score).toBe(58);
    expect(s.grade).toBe("D");
  });
  it("is 0 / F for an empty scan rather than a crash", () => {
    expect(summarise([])).toMatchObject({ score: 0, grade: "F" });
  });
});

function reportOf(results: CheckResult[], over: Partial<Report> = {}): Report {
  return { url: "https://example.com", finalUrl: "https://example.com/", scannedAt: "2026-11-03T10:00:00.000Z", durationMs: 2340, ...summarise(results), results, notes: [], ...over };
}

describe("formatText", () => {
  const report = reportOf([
    r("pass", 5, "security", { title: "Served over HTTPS", message: "Yes." }),
    r("fail", 5, "security", { title: "Has HSTS", message: "Missing.", fix: "Send the header.", details: ["one detail", "another"] }),
    r("warn", 3, "seo", { title: "Title length", message: "Short.", fix: "Lengthen it." }),
    r("skip", 1, "links", { title: "Broken links", message: "Off." }),
  ], { notes: ["Something worth knowing."] });

  it("shows the address, the score, the counts and the time", () => {
    const t = formatText(report);
    expect(t).toContain("sitepulse report: https://example.com/");
    expect(t).toContain("(asked for https://example.com)");
    expect(t).toMatch(/Score \d+\/100 \(grade [A-F]\)/);
    expect(t).toContain("1 passed, 1 to improve, 1 failed, 1 skipped");
    expect(t).toContain("2.3 s");
  });

  it("groups by category with the category score, and hides the fix for passes", () => {
    const t = formatText(report);
    expect(t).toContain("Security  50/100");
    expect(t).toContain("SEO and content  50/100");
    expect(t).toContain("FAIL  Has HSTS: Missing.");
    expect(t).toContain("fix: Send the header.");
    expect(t).toContain("- one detail");
    expect(t).toContain("fix: Lengthen it.");
    expect(t).not.toMatch(/pass.*\n\s+fix:/);
  });

  it("shows a category with only skipped checks without a score", () => {
    expect(formatText(report)).toMatch(/\nLinks\n/);
  });

  it("omits a category that has no checks at all, and prints the notes", () => {
    const t = formatText(report);
    expect(t).not.toContain("Performance");
    expect(t).toContain("note: Something worth knowing.");
  });

  it("does not repeat the address when nothing redirected", () => {
    expect(formatText(reportOf([r("pass")], { url: "https://example.com/" }))).not.toContain("asked for");
  });

  it("uses colour only when asked", () => {
    expect(formatText(report)).not.toContain("\u001b[");
    expect(formatText(report, { color: true })).toContain("\u001b[31m");
  });
});

describe("formatMarkdown", () => {
  const report = reportOf([
    r("warn", 3, "seo", { title: "Title length", message: "Short.", fix: "Lengthen it." }),
    r("fail", 5, "security", { title: "Has HSTS", message: "Missing.", fix: "Send the header.", details: ["a `tick` in a detail"] }),
    r("pass", 5, "security", { title: "Served over HTTPS", message: "Yes." }),
  ]);
  const md = formatMarkdown(report);

  it("has a heading, a summary line with the date, and a table", () => {
    expect(md.startsWith("# Website health: https://example.com/")).toBe(true);
    expect(md).toMatch(/\*\*Score \d+\/100 \(grade [A-F]\)\*\*/);
    expect(md).toContain("Scanned 2026-11-03 in 2.3 s");
    expect(md).toContain("| Category | Score | Pass | Improve | Fail |");
    expect(md).toContain("| Security | 50 | 1 | 0 | 1 |");
  });

  it("lists failures before warnings under 'What to fix first', each with its fix", () => {
    const fix = md.slice(md.indexOf("## What to fix first"), md.indexOf("## All checks"));
    expect(fix.indexOf("Has HSTS")).toBeGreaterThan(-1);
    expect(fix.indexOf("Has HSTS")).toBeLessThan(fix.indexOf("Title length"));
    expect(fix).toContain("*Fix:* Send the header.");
    expect(fix).not.toContain("Served over HTTPS");
  });

  it("keeps backticks in details from breaking the code span", () => {
    expect(md).toContain("`a 'tick' in a detail`");
  });

  it("lists every check under 'All checks' and ends with exactly one newline", () => {
    const all = md.slice(md.indexOf("## All checks"));
    expect(all).toContain("Served over HTTPS");
    expect(all).toContain("Title length");
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("leaves out 'What to fix first' when there is nothing to fix", () => {
    expect(formatMarkdown(reportOf([r("pass"), r("skip")]))).not.toContain("What to fix first");
  });

  it("shows a category score of n/a when nothing in it could be checked", () => {
    expect(formatMarkdown(reportOf([r("skip", 1, "links")]))).toContain("| Links | n/a |");
  });
});

describe("topIssues", () => {
  const rows = [
    r("warn", 9, "seo", { id: "w9" }),
    r("fail", 2, "seo", { id: "f2" }),
    r("fail", 8, "security", { id: "f8" }),
    r("warn", 3, "seo", { id: "w3" }),
    r("pass", 10, "seo", { id: "p" }),
    r("skip", 10, "seo", { id: "s" }),
  ];
  const report = reportOf(rows);

  it("puts failures first, the heaviest first, then warnings", () => {
    expect(topIssues(report).map((x) => x.id)).toEqual(["f8", "f2", "w9", "w3"]);
  });
  it("never includes passes or skips, and respects the maximum", () => {
    expect(topIssues(report, 2).map((x) => x.id)).toEqual(["f8", "f2"]);
    expect(topIssues(report, 100).some((x) => x.status === "pass" || x.status === "skip")).toBe(false);
  });
  it("does not change the report", () => {
    const before = report.results.map((x) => x.id);
    topIssues(report);
    expect(report.results.map((x) => x.id)).toEqual(before);
  });
});
