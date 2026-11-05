import { emit } from "../emit";
import { need } from "../record";
import { conversation, later, md } from "../conversation";
import { proofReasons } from "../proof";
import { decideMerge, type MergeDecision } from "../decision";
import type { PersonRef, Ticket } from "../seams";
import { CODEOWNERS_PATHS, parseCodeowners, topOwners } from "../codeowners";
import { changeText } from "./precommit-gate";
import { facts, inbox, isMain, modelRow, notify, runStep, save, switchOn, ticketRef, type StepContext, type StepResult } from "./context";
import { block, endIfClosed, stopReason, stopped } from "./run";

export const ASKED = "a person asked for changes";
const FAKE_ERRORS = "this ticket comes from fake errors (logSource files), so a person must merge it";

// A fix for an error that does not exist must never reach the default branch alone.
// A run with a person's request never merges without a person, also when it resumes later.
function decide(ctx: StepContext, ticket: Ticket): MergeDecision {
  let d = decideByChecks(ctx);
  const reasons = () => (d.kind === "needs_approval" ? d.reasons : []);
  if (ticket.marks.includes("watcher") && ctx.seams.logSource === "files") d = { kind: "needs_approval", reasons: [...reasons(), FAKE_ERRORS] };
  const bad = facts(ctx).riskCheck?.thresholdErrors ?? [];
  if (bad.length) d = { kind: "needs_approval", reasons: [...reasons(), ...bad] };
  return facts(ctx).requested ? { kind: "needs_approval", reasons: [ASKED, ...reasons()] } : d;
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
    thresholds: rc.thresholds,
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
  // After that re-open, or a continued run whose change was closed would block again at once.
  const end = await endIfClosed(ctx);
  if (end) return end;
  const ticket = await ctx.tracker.ticket(ref);
  let d = decide(ctx, ticket);
  if (d.kind === "auto" && !(await switchOn(ctx, "auto_merge"))) d = { kind: "needs_approval", reasons: ["auto-merge is switched off"] };
  // A stop posted after the last author run (during review, the gate or the risk check) must not merge.
  // With no author session the resume blocks, which is still better than a merge.
  if (d.kind === "auto" && (await inbox(ctx).poll()).stop) return stopped(ctx, "decision", { session: facts(ctx).session, reason: stopReason(ctx) });
  // The finish run loads this run's record from this run.
  if (d.kind === "auto" && !ctx.ci.vars.run) return block(ctx, "This run has no run id, so the finish run could not find this run's record.");
  save(ctx, "decision", d);
  emit(ctx, "decision", { auto: d.kind === "auto", reasons: d.kind === "auto" ? [] : d.reasons, risk: f.riskCheck?.risk?.diffRisk.value, riskMax: f.riskCheck?.thresholds?.diffRiskMax, changeUrl: f.changeUrl });
  if (d.kind === "auto") {
    const rules = need(facts(ctx).riskCheck, "risk check").rules.map((r) => `- **${r.rule}:** ${r.detail}`).join("\n");
    await ctx.codeHost.commentChange(change, md("🚀", "Merging without a person", "Triage risk was trivial or low. Code review, precommit-gate, every hard rule and Jev 2 passed.", rules));
    await ctx.ci.start({ kind: "finish", ticket: ref, change, buildRun: ctx.ci.vars.run });
    return "next";
  }
  return askPerson(ctx, d.reasons);
}

// Who reviews: the newest request's author of the last round, else the ticket assignee, else the top code owner of the changed files who may command the factory, else the default approver.
// Nothing here may stop the run, so any read that fails falls back to the default approver.
export async function reviewer(ctx: StepContext, ticket: Ticket): Promise<PersonRef> {
  const asker = ctx.record.requestRounds?.at(-1)?.requests.at(-1)?.author;
  if (asker) return asker;
  if (ticket.assignees[0]) return ticket.assignees[0];
  try {
    const sha = facts(ctx).gateHead;
    let text: string | undefined;
    for (const path of CODEOWNERS_PATHS) if ((text = await ctx.codeHost.readFile(path)) !== undefined) break;
    if (!text || !sha) return ctx.target.defaultApprover;
    for (const owner of topOwners(parseCodeowners(text), Object.keys(await ctx.codeHost.branchDiff(sha)))) {
      // A name the host does not know makes trusted throw: skip it like an untrusted one.
      const ok = await ctx.tracker.trusted(owner).then(async (t) => t && !(await ctx.tracker.isFactory(owner)), () => false);
      if (ok) return owner;
    }
  } catch (e) {
    console.log(`Could not pick a code owner, using the default approver: ${e instanceof Error ? e.message : e}`);
  }
  return ctx.target.defaultApprover;
}

// Send the change to a person to review and merge: state, the round's answer, a comment with the reasons on the change, the assignee and a card.
// The comment ends with the cursor line: the requests the run has read, so the poller starts a round only for newer ones.
export async function askPerson(ctx: StepContext, reasons: string[]): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const { change, changeUrl } = facts(ctx);
  if (!change) throw new Error("The run record has no change");
  const ticket = await ctx.tracker.ticket(ref);
  await ctx.tracker.setState(ref, "needs_approval");
  const f = facts(ctx);
  const round = f.openRound;
  if (round) {
    const authors = [...new Set(round.requests.map((r) => r.author))].map((a) => `@${a}`).join(" ");
    await ctx.codeHost.commentChange(change, md("✅", "Round finished", `The factory finished the round for the requests of ${authors}.`, round.answer?.slice(0, 4000)));
  }
  // With nothing read yet: the run's first event, so a request written while the run was paused still counts as new.
  // After a resume the agent never saw what was written during the pause, so the cursor stays where this run or its round started reading.
  const first = ctx.record.steps.find((s) => s.step === "event")?.at;
  const read = f.resumed ? (ctx.record.requestRounds?.at(-1)?.cursor ?? first) : (later(ctx.record.heardUntil, round?.cursor) ?? first);
  await conversation(ctx).writeOnChange(change, { kind: "cursor", text: md("👀", "Needs a person", "This change needs a person to review and merge it.", reasons.map((r) => `- ${r}`).join("\n")), at: read });
  if (round) {
    const t = ctx.record.tokens ?? { input: 0, output: 0 };
    const closed = { ...round, endedAt: new Date().toISOString(), ...ctx.record.rounds, costUsd: ctx.record.costUsd - round.costAtStart, tokens: { input: t.input - round.tokensAtStart.input, output: t.output - round.tokensAtStart.output } };
    ctx.record = { ...ctx.record, requestRounds: ctx.record.requestRounds!.map((x) => (x === round ? closed : x)) };
  }
  await ctx.codeHost.assignChange(change, await reviewer(ctx, ticket));
  await notify(ctx, "needs_approval", reasons, changeUrl ?? "");
  return "stop";
}

export const main = () => runStep("decision", run);
if (isMain(import.meta.url)) await main();
