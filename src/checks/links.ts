import { fail, pass, sample, skip, warn, type CheckDef } from "./types.js";

export const linkChecks: CheckDef[] = [
  {
    id: "links-broken",
    category: "links",
    title: "No broken links",
    description:
      "A sample of the page's links (mostly its own, some external) is requested to see whether they still work. Sites that refuse automated requests (403, 429) are reported as unverifiable, not broken.",
    weight: 6,
    needs: ["links"],
    run: (c) => {
      const links = c.extras.links;
      if (!links) return skip("Link checking is off.");
      if (links.length === 0) return skip("The page has no links to check.");
      const broken = links.filter((l) => l.kind === "broken");
      const blocked = links.filter((l) => l.kind === "blocked");
      const skipped = links.filter((l) => l.kind === "skipped");
      const checked = links.length - skipped.length;
      const tail = [blocked.length ? `${blocked.length} could not be verified because the site refuses automated requests` : "", skipped.length ? `${skipped.length} skipped (private address)` : ""].filter(Boolean).join("; ");
      if (broken.length === 0) return pass(`${checked} link(s) checked, none broken${tail ? ` (${tail})` : ""}.`);
      const detail = sample(broken.map((l) => `${l.status ?? "no answer"}  ${l.url}  (${l.note})`));
      const msg = `${broken.length} of ${checked} checked links are broken${tail ? ` (${tail})` : ""}.`;
      const fix = "Fix or remove each broken link, or redirect the old address to its replacement.";
      return broken.length >= 3 || broken.length / Math.max(1, checked) > 0.25 ? fail(msg, fix, detail) : warn(msg, fix, detail);
    },
  },
];
