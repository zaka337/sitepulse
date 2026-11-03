import { CATEGORIES, type CheckResult, type Report, type Status } from "./types.js";

/* Turning a Report into text. The Report itself is the data (and is what --json prints); these are the two readable
   forms: plain text for a terminal and Markdown for pasting into an issue, a chat or an AI assistant. */

const TITLE: Record<string, string> = { security: "Security", seo: "SEO and content", performance: "Performance", accessibility: "Accessibility", links: "Links" };

const WORD: Record<Status, string> = { pass: "pass", warn: "warn", fail: "FAIL", skip: "skip" };
const COLOR: Record<Status, string> = { pass: "32", warn: "33", fail: "31", skip: "90" };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function formatText(report: Report, opts: { color?: boolean } = {}): string {
  const c = (code: string, s: string) => (opts.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const out: string[] = [];
  out.push(c("1", `sitepulse report: ${report.finalUrl}`));
  if (report.finalUrl !== report.url) out.push(`(asked for ${report.url})`);
  const s = report.summary;
  out.push(`Score ${c("1", `${report.score}/100`)} (grade ${report.grade})   ${s.pass} passed, ${s.warn} to improve, ${s.fail} failed, ${s.skip} skipped   ${seconds(report.durationMs)}`);
  for (const cat of CATEGORIES) {
    const rows = report.results.filter((r) => r.category === cat);
    if (!rows.length) continue;
    const score = report.categories[cat].score;
    out.push("", c("1", `${TITLE[cat]}${score === null ? "" : `  ${score}/100`}`));
    for (const r of rows) {
      out.push(`  ${c(COLOR[r.status], WORD[r.status].padEnd(4))}  ${r.title}: ${r.message}`);
      if (r.status === "warn" || r.status === "fail") {
        if (r.fix) out.push(`        fix: ${r.fix}`);
        for (const d of r.details ?? []) out.push(`        - ${d}`);
      }
    }
  }
  if (report.notes.length) out.push("", ...report.notes.map((n) => `note: ${n}`));
  return out.join("\n");
}

const ICON: Record<Status, string> = { pass: "✅", warn: "⚠️", fail: "❌", skip: "⏭️" };

export function formatMarkdown(report: Report): string {
  const out: string[] = [];
  out.push(`# Website health: ${report.finalUrl}`, "");
  out.push(`**Score ${report.score}/100 (grade ${report.grade})** — ${report.summary.pass} passed, ${report.summary.warn} to improve, ${report.summary.fail} failed, ${report.summary.skip} skipped. Scanned ${report.scannedAt.slice(0, 10)} in ${seconds(report.durationMs)}.`, "");
  out.push("| Category | Score | Pass | Improve | Fail |", "|---|---|---|---|---|");
  for (const cat of CATEGORIES) {
    const k = report.categories[cat];
    if (k.pass + k.warn + k.fail + k.skip === 0) continue;
    out.push(`| ${TITLE[cat]} | ${k.score === null ? "n/a" : `${k.score}`} | ${k.pass} | ${k.warn} | ${k.fail} |`);
  }
  const issues = (rows: CheckResult[]) => rows.filter((r) => r.status === "fail" || r.status === "warn");
  const todo = issues(report.results);
  if (todo.length) {
    out.push("", "## What to fix first", "");
    for (const r of [...todo.filter((r) => r.status === "fail"), ...todo.filter((r) => r.status === "warn")]) {
      out.push(`- ${ICON[r.status]} **${r.title}** — ${r.message}${r.fix ? ` *Fix:* ${r.fix}` : ""}`);
      for (const d of r.details ?? []) out.push(`  - \`${d.replace(/`/g, "'")}\``);
    }
  }
  out.push("", "## All checks", "");
  for (const cat of CATEGORIES) {
    const rows = report.results.filter((r) => r.category === cat);
    if (!rows.length) continue;
    out.push(`### ${TITLE[cat]}`, "");
    for (const r of rows) out.push(`- ${ICON[r.status]} ${r.title}: ${r.message}`);
    out.push("");
  }
  if (report.notes.length) out.push(...report.notes.map((n) => `> ${n}`), "");
  return out.join("\n").trimEnd() + "\n";
}

/** The most important findings, worst first (for a short summary or a chat reply) */
export function topIssues(report: Report, max = 5): CheckResult[] {
  const order = (r: CheckResult) => (r.status === "fail" ? 0 : 1) * 1000 - r.weight;
  return report.results.filter((r) => r.status === "fail" || r.status === "warn").sort((a, b) => order(a) - order(b)).slice(0, max);
}
