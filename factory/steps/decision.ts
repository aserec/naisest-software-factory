import { proofReasons } from "../proof";
import { decideMerge, type MergeDecision } from "../decision";
import type { RuleResult } from "../rules";
import type { Ticket } from "../seams";
import { changeText } from "./precommit-gate";
import { block, data, inbox, isMain, modelRow, notify, person, runStep, save, session, stopped, ticketRef, type StepContext, type StepResult } from "./context";

const FAKE_ERRORS = "this ticket comes from fake errors (logSource files), so a person must merge it";

// A fix for an error that does not exist must never reach the default branch alone.
function decide(ctx: StepContext, ticket: Ticket): MergeDecision {
  const d = decideByChecks(ctx);
  if (!ticket.marks.includes("watcher") || ctx.seams.logSource !== "files") return d;
  return { kind: "needs_approval", reasons: [...(d.kind === "needs_approval" ? d.reasons : []), FAKE_ERRORS] };
}

function decideByChecks(ctx: StepContext): MergeDecision {
  const rc = data(ctx, "risk-check");
  const failedRules = (rc.rules as RuleResult[]).filter((r) => !r.passed).map((r) => `hard rule ${r.rule} failed: ${r.detail}`);
  const proof = proofReasons(data(ctx, "code-review")?.proof, !!data(ctx, "prepare-patch").commands?.preview, data(ctx, "precommit-gate")?.uploadFailed ?? []);
  if (rc.riskError) return { kind: "needs_approval", reasons: [`Jev 2 risk check failed: ${rc.riskError}`, ...failedRules, ...proof] };
  const d = decideMerge({
    triageRisk: data(ctx, "triage").outcome.risk,
    reviewPassed: data(ctx, "code-review")?.passed === true,
    gateGreen: data(ctx, "precommit-gate")?.passed === true,
    rules: rc.rules,
    risk: rc.risk,
  });
  const row = modelRow(ctx);
  if (d.kind === "auto" && !row.mayAutoMerge) return { kind: "needs_approval", reasons: [`the ${row.author.model} router row may not merge alone`, ...proof] };
  if (d.kind === "auto" && proof.length) return { kind: "needs_approval", reasons: proof };
  return d.kind === "needs_approval" ? { ...d, reasons: [...d.reasons, ...proof] } : d;
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const { change, changeUrl, branch } = data(ctx, "precommit-gate");
  // A run continued after the gate job: the change still names the run that opened it. An approval must load this run's record.
  if (["risk-check", "decision"].includes(data(ctx, "event")?.resumeAt)) {
    const { title, body } = changeText(ctx);
    await ctx.codeHost.openChange(branch, title, body, ref);
  }
  const ticket = await ctx.tracker.ticket(ref);
  const d = decide(ctx, ticket);
  // A stop posted after the last author run (during review, the gate or the risk check) must not merge.
  // With no author session the resume blocks, which is still better than a merge.
  if (d.kind === "auto" && (await inbox(ctx).poll()).stop) return stopped(ctx, "decision", session(ctx) ?? "");
  // The finish run loads this run's record from this run.
  if (d.kind === "auto" && !ctx.ci.vars.run) return block(ctx, "This run has no run id, so the finish run could not find this run's record.");
  save(ctx, "decision", d);
  if (d.kind === "auto") {
    const rules = (data(ctx, "risk-check").rules as RuleResult[]).map((r) => `- ${r.rule}: ${r.detail}`).join("\n");
    await ctx.codeHost.commentChange(change, `The factory merges this without a person: triage risk was trivial or low, code review and precommit-gate passed, every hard rule passed and Jev 2 passed.\n\n${rules}`);
    await ctx.ci.start({ kind: "finish", ticket: ref, change, buildRun: ctx.ci.vars.run });
    return "next";
  }
  await ctx.tracker.setState(ref, "needs_approval");
  await ctx.codeHost.commentChange(change, `This change needs a person to review and merge it:\n\n${d.reasons.map((r) => `- ${r}`).join("\n")}`);
  await ctx.codeHost.assignChange(change, person(ctx, ticket));
  await notify(ctx, "needs_approval", d.reasons, changeUrl);
  return "stop";
}

export const main = () => runStep("decision", run);
if (isMain(import.meta.url)) await main();
