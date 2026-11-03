import { accessibilityChecks } from "./accessibility.js";
import { linkChecks } from "./links.js";
import { performanceChecks } from "./performance.js";
import { securityChecks } from "./security.js";
import { seoChecks } from "./seo.js";
import type { CheckDef } from "./types.js";

/** Every check, in report order. This list is also the catalogue the CLI and the MCP server describe. */
export const CHECKS: readonly CheckDef[] = [...securityChecks, ...seoChecks, ...performanceChecks, ...accessibilityChecks, ...linkChecks];

export type { CheckDef, Ctx, Outcome, Probe, LinkProbe } from "./types.js";
