import { askRisk } from "../decision";
import { checkHardRules, parseNumstat, type RuleResult } from "../rules";
import type { Target } from "../types";
import { data, isMain, runStep, save, waitFor, workItem, type StepContext, type StepResult } from "./context";

// Fails closed: if the changed files cannot be read, the three rules that need them fail.
function hardRules(numstat: string, diffText: string, target: Target, pipelineGreen: boolean): RuleResult[] {
  try {
    return checkHardRules(parseNumstat(numstat), diffText, target, pipelineGreen);
  } catch (e) {
    const needsFiles = ["protected-path", "dependency-file", "size"];
    return checkHardRules([], diffText, target, pipelineGreen).map((r) => (needsFiles.includes(r.rule) ? { ...r, passed: false, detail: `Could not read the changed files: ${String(e)}` } : r));
  }
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const { projectId, defaultBranch } = await workItem(ctx);
  const { mrIid } = data(ctx, "precommit-gate");
  const mrPipeline = await waitFor(ctx, () => ctx.gitlab.mergeRequestPipelineStatus(projectId, mrIid));
  const diff = await ctx.repo.diff(defaultBranch);
  const rules = hardRules(diff.numstat, diff.text, ctx.target, mrPipeline === "success");
  try {
    save(ctx, "risk-check", { mrPipeline, rules, risk: await askRisk(ctx.jev, ctx.record.ticket!, diff.text) });
  } catch (e) {
    // No guessing: the decision step sends this change to a person.
    save(ctx, "risk-check", { mrPipeline, rules, riskError: String(e) });
  }
  return "next";
}

export const main = () => runStep("risk-check", run);
if (isMain(import.meta.url)) await main();
