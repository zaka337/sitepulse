import { CATEGORIES, type CategoryScore, type CheckResult, type Grade, type Report } from "./types.js";

/* How the score works, in one place. Every check has a weight. A pass earns all of it, a warning half, a failure none,
   and a skipped check does not count at all (so a page with no forms is not marked down for form labels). The score is
   what was earned out of what could have been earned, from 0 to 100, overall and for each category. */

const POINTS = { pass: 1, warn: 0.5, fail: 0 } as const;

export function gradeFor(score: number): Grade {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 55 ? "D" : "F";
}

export function scoreOf(results: readonly CheckResult[]): number | null {
  let earned = 0;
  let possible = 0;
  for (const r of results) {
    if (r.status === "skip") continue;
    possible += r.weight;
    earned += r.weight * POINTS[r.status];
  }
  return possible === 0 ? null : Math.round((earned / possible) * 100);
}

export function summarise(results: readonly CheckResult[]): Pick<Report, "score" | "grade" | "categories" | "summary"> {
  const categories = {} as Record<(typeof CATEGORIES)[number], CategoryScore>;
  for (const cat of CATEGORIES) {
    const mine = results.filter((r) => r.category === cat);
    categories[cat] = {
      score: scoreOf(mine),
      pass: mine.filter((r) => r.status === "pass").length,
      warn: mine.filter((r) => r.status === "warn").length,
      fail: mine.filter((r) => r.status === "fail").length,
      skip: mine.filter((r) => r.status === "skip").length,
    };
  }
  const score = scoreOf(results) ?? 0;
  return {
    score,
    grade: gradeFor(score),
    categories,
    summary: {
      pass: results.filter((r) => r.status === "pass").length,
      warn: results.filter((r) => r.status === "warn").length,
      fail: results.filter((r) => r.status === "fail").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
  };
}
