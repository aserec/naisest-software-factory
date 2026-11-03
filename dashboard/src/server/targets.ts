import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { STUCK_MINUTES } from "software-factory/run-events";

export interface TargetInfo {
  name: string;
  projectPath: string;
  stuckMinutes: Record<string, number>;
  githubIssues?: string; // the issues page, for a target whose file picks a github tracker
}

// A raw read of targets/*.yml. It does not use the factory's loadTarget, which refuses placeholder approvers.
// The default dir is TARGETS_DIR, else ../targets from the dashboard cwd (Ruling R8).
export function readTargets(dir = process.env.TARGETS_DIR ?? "../targets"): TargetInfo[] {
  const root = resolve(dir);
  return readdirSync(root)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f) => {
      const t = (parse(readFileSync(join(root, f), "utf8")) ?? {}) as { name?: string; projectPath?: string; stuckMinutes?: Record<string, number>; tracker?: string; githubRepo?: string };
      if (!t.projectPath) throw new Error(`${f}: projectPath is missing`);
      const githubIssues = t.tracker?.startsWith("github") && t.githubRepo ? `https://github.com/${t.githubRepo}/issues` : undefined;
      return { name: t.name ?? f.replace(/\.yml$/, ""), projectPath: t.projectPath, stuckMinutes: { ...STUCK_MINUTES, ...t.stuckMinutes }, githubIssues };
    });
}
