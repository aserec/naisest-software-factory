import { emit } from "../emit";
import { need } from "../record";
import { proofReasons } from "../proof";
import { decideMerge, type MergeDecision } from "../decision";
import type { Ticket } from "../seams";
import { changeText } from "./precommit-gate";
import { facts, inbox, isMain, modelRow, notify, person, runStep, save, switchOn, ticketRef, type StepContext, type StepResult } from "./context";
import { block, stopReason, stopped } from "./run";

const FAKE_ERRORS = "this ticket comes from fake errors (logSource files), so a person must merge it";

// A fix for an error that does not exist must never reach the default branch alone.
function decide(ctx: StepContext, ticket: Ticket): MergeDecision {
  const d = decideByChecks(ctx);
  if (!ticket.marks.includes("watcher") || ctx.seams.logSource !== "files") return d;
  return { kind: "needs_approval", reasons: [...(d.kind === "needs_approval" ? d.reasons : []), FAKE_ERRORS] };
}

function decideByChecks(ctx: StepContext): MergeDecision {
  const f = facts(ctx);
  const rc = need(f.riskCheck, "risk check");
  const failedRules = rc.rules.filter((r) => !r.passed).map((r) => `hard rule ${r.rule} failed: ${r.detail}`);
  const proof = proofReasons(f.proof, !!need(f.commands, ".factory.yml commands").preview, f.uploadFailed ?? []);
  if (rc.riskError) return { kind: "needs_approval", reasons: [`Jev 2 risk check failed: ${rc.riskError}`, ...failedRules, ...proof] };
  const d = decideMerge({
    triageRisk: need(f.triageRisk, "triage risk"),
    reviewPassed: f.reviewPassed === true,
    gateGreen: f.gatePassed === true,
    rules: rc.rules,
    risk: need(rc.risk, "Jev 2 risk answers"),
  });
  const row = modelRow(ctx);
  if (d.kind === "auto" && !row.mayAutoMerge) return { kind: "needs_approval", reasons: [`the ${row.author.model} router row may not merge alone`, ...proof] };
  if (d.kind === "auto" && proof.length) return { kind: "needs_approval", reasons: proof };
  return d.kind === "needs_approval" ? { ...d, reasons: [...d.reasons, ...proof] } : d;
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const f = facts(ctx);
  const change = need(f.change, "change");
  // A run continued after the gate job: the change still names the run that opened it. An approval must load this run's record.
  if (["risk-check", "decision"].includes(f.resumeAt ?? "")) {
    const { title, body } = changeText(ctx);
    await ctx.codeHost.openChange(need(f.branch, "change branch"), title, body, ref);
  }
  const ticket = await ctx.tracker.ticket(ref);
  let d = decide(ctx, ticket);
  if (d.kind === "auto" && !(await switchOn(ctx, "auto_merge"))) d = { kind: "needs_approval", reasons: ["auto-merge is switched off"] };
  // A stop posted after the last author run (during review, the gate or the risk check) must not merge.
  // With no author session the resume blocks, which is still better than a merge.
  if (d.kind === "auto" && (await inbox(ctx).poll()).stop) return stopped(ctx, "decision", { session: facts(ctx).session, reason: stopReason(ctx) });
  // The finish run loads this run's record from this run.
  if (d.kind === "auto" && !ctx.ci.vars.run) return block(ctx, "This run has no run id, so the finish run could not find this run's record.");
  save(ctx, "decision", d);
  emit(ctx, "decision", { auto: d.kind === "auto", reasons: d.kind === "auto" ? [] : d.reasons });
  if (d.kind === "auto") {
    const rules = need(facts(ctx).riskCheck, "risk check").rules.map((r) => `- ${r.rule}: ${r.detail}`).join("\n");
    await ctx.codeHost.commentChange(change, `The factory merges this without a person: triage risk was trivial or low, code review and precommit-gate passed, every hard rule passed and Jev 2 passed.\n\n${rules}`);
    await ctx.ci.start({ kind: "finish", ticket: ref, change, buildRun: ctx.ci.vars.run });
    return "next";
  }
  return askPerson(ctx, d.reasons);
}

// Send the change to a person to review and merge: state, a comment with the reasons on the change, the assignee and a card.
export async function askPerson(ctx: StepContext, reasons: string[]): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const { change, changeUrl } = facts(ctx);
  if (!change) throw new Error("The run record has no change");
  const ticket = await ctx.tracker.ticket(ref);
  await ctx.tracker.setState(ref, "needs_approval");
  await ctx.codeHost.commentChange(change, `This change needs a person to review and merge it:\n\n${reasons.map((r) => `- ${r}`).join("\n")}`);
  await ctx.codeHost.assignChange(change, person(ctx, ticket));
  await notify(ctx, "needs_approval", reasons, changeUrl ?? "");
  return "stop";
}

export const main = () => runStep("decision", run);
if (isMain(import.meta.url)) await main();
