import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { STUCK_MINUTES } from "software-factory/run-events";

export interface TargetInfo {
  name: string;
  projectPath: string;
  stuckMinutes: Record<string, number>;
  tracker: string; // the board adapter, as the factory's tracker key; gitlab when the file has none
  codeHost: string; // the code host adapter; gitlab when the file has none
  githubRepo?: string; // owner/repo, for a github tracker
  githubProject?: number; // the board number, for a github-project tracker
  weeklyBudgetUsd?: number; // the cost a week of runs should stay under; Insights warns from 80%
}

// A raw read of targets/*.yml. It does not use the factory's loadTarget, which refuses placeholder approvers.
// The default dir is TARGETS_DIR, else ../targets: the dashboard runs from dashboard/, next to the repo's targets/.
export function readTargets(dir = process.env.TARGETS_DIR ?? "../targets"): TargetInfo[] {
  const root = resolve(dir);
  return readdirSync(root)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f) => {
      const t = (parse(readFileSync(join(root, f), "utf8")) ?? {}) as { name?: string; projectPath?: string; stuckMinutes?: Record<string, number>; tracker?: string; codeHost?: string; githubRepo?: string; githubProject?: number; weeklyBudgetUsd?: number };
      if (!t.projectPath) throw new Error(`${f}: projectPath is missing`);
      const tracker = t.tracker ?? "gitlab";
      if (tracker.startsWith("github") && !t.githubRepo) throw new Error(`${f}: githubRepo is missing`);
      return {
        name: t.name ?? f.replace(/\.yml$/, ""), projectPath: t.projectPath, stuckMinutes: { ...STUCK_MINUTES, ...t.stuckMinutes }, tracker, codeHost: t.codeHost ?? "gitlab",
        ...(tracker.startsWith("github") ? { githubRepo: t.githubRepo } : {}),
        ...(tracker === "github-project" && t.githubProject !== undefined ? { githubProject: t.githubProject } : {}),
        ...(typeof t.weeklyBudgetUsd === "number" && t.weeklyBudgetUsd > 0 ? { weeklyBudgetUsd: t.weeklyBudgetUsd } : {}),
      };
    });
}
