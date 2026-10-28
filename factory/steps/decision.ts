import { decideMerge, type MergeDecision } from "../decision";
import type { RuleResult } from "../rules";
import { card, data, isMain, modelRow, person, runStep, save, workItem, type StepContext, type StepResult } from "./context";

function decide(ctx: StepContext): MergeDecision {
  const rc = data(ctx, "risk-check");
  const failedRules = (rc.rules as RuleResult[]).filter((r) => !r.passed).map((r) => `hard rule ${r.rule} failed: ${r.detail}`);
  if (rc.riskError) return { kind: "needs_approval", reasons: [`Jev 2 risk check failed: ${rc.riskError}`, ...failedRules] };
  const d = decideMerge({
    triageRisk: data(ctx, "triage").outcome.risk,
    reviewPassed: data(ctx, "code-review")?.passed === true,
    gateGreen: data(ctx, "precommit-gate")?.passed === true,
    rules: rc.rules,
    risk: rc.risk,
  });
  const row = modelRow(ctx);
  if (d.kind === "auto" && !row.mayAutoMerge) return { kind: "needs_approval", reasons: [`the ${row.author} router row may not merge alone`] };
  return d;
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const { projectId, iid } = await workItem(ctx);
  const { mrIid, mrUrl } = data(ctx, "precommit-gate");
  const d = decide(ctx);
  save(ctx, "decision", d);
  if (d.kind === "auto") {
    await ctx.startFinish({ FACTORY_PIPELINE: "finish", FACTORY_TARGET: ctx.target.name, FACTORY_WORK_ITEM_IID: String(iid), FACTORY_MR_IID: String(mrIid) });
    return "next";
  }
  const item = await ctx.gitlab.getWorkItem(projectId, iid);
  await ctx.gitlab.setState(projectId, iid, "factory_needs_approval");
  await ctx.gitlab.commentMergeRequest(projectId, mrIid, `This change needs a person to approve it:\n\n${d.reasons.map((r) => `- ${r}`).join("\n")}`);
  await ctx.gitlab.assignMergeRequest(projectId, mrIid, await person(ctx, item.assigneeIds));
  await card(ctx, "needs_approval", d.reasons, mrUrl);
  return "stop";
}

export const main = () => runStep("decision", run);
if (isMain(import.meta.url)) await main();
