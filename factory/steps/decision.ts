import { decideMerge, type MergeDecision } from "../decision";
import type { RuleResult } from "../rules";
import { block, data, isMain, modelRow, notify, person, runStep, save, ticketRef, type StepContext, type StepResult } from "./context";

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
  if (d.kind === "auto" && !row.mayAutoMerge) return { kind: "needs_approval", reasons: [`the ${row.author.model} router row may not merge alone`] };
  return d;
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const { change, changeUrl } = data(ctx, "precommit-gate");
  const d = decide(ctx);
  // The finish run loads this run's record from this run.
  if (d.kind === "auto" && !ctx.ci.vars.run) return block(ctx, "This run has no run id, so the finish run could not find this run's record.");
  save(ctx, "decision", d);
  if (d.kind === "auto") {
    const rules = (data(ctx, "risk-check").rules as RuleResult[]).map((r) => `- ${r.rule}: ${r.detail}`).join("\n");
    await ctx.codeHost.commentChange(change, `The factory merges this without a person: triage risk was trivial or low, code review and precommit-gate passed, every hard rule passed and Jev 2 passed.\n\n${rules}`);
    await ctx.ci.start({ kind: "finish", ticket: ref, change, buildRun: ctx.ci.vars.run });
    return "next";
  }
  const ticket = await ctx.tracker.ticket(ref);
  await ctx.tracker.setState(ref, "needs_approval");
  await ctx.codeHost.commentChange(change, `This change needs a person to approve it:\n\n${d.reasons.map((r) => `- ${r}`).join("\n")}`);
  await ctx.codeHost.assignChange(change, person(ctx, ticket));
  await notify(ctx, "needs_approval", d.reasons, changeUrl);
  return "stop";
}

export const main = () => runStep("decision", run);
if (isMain(import.meta.url)) await main();
