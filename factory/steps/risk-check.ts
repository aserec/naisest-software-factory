import { emit } from "../emit";
import { askRisk, riskReasons } from "../decision";
import { need } from "../record";
import { checkHardRules, parseNumstat, testOnly, type ChangedFile, type RuleResult } from "../rules";
import type { Target } from "../types";
import { stopReason, stopped } from "./run";
import { facts, inbox, isMain, runStep, save, thresholds as readThresholds, ticketRef, waitFor, type StepContext, type StepResult } from "./context";

// Fails closed: if the changed files cannot be read, the three rules that need them fail.
function hardRules(files: ChangedFile[] | Error, diffText: string, target: Target, pipelineGreen: boolean, pipelineDetail?: string): RuleResult[] {
  if (!(files instanceof Error)) return checkHardRules(files, diffText, target, pipelineGreen, pipelineDetail);
  const needsFiles = ["protected-path", "dependency-file", "size"];
  return checkHardRules([], diffText, target, pipelineGreen, pipelineDetail).map((r) => (needsFiles.includes(r.rule) ? { ...r, passed: false, detail: `Could not read the changed files: ${String(files)}` } : r));
}

function changedFiles(numstat: string): ChangedFile[] | Error {
  try {
    return parseNumstat(numstat);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

export async function run(ctx: StepContext): Promise<StepResult> {
  // headSha is the commit that was reviewed and checked. apply merges only that commit.
  const f = facts(ctx);
  const change = need(f.change, "change");
  const headSha = need(f.gateHead, "pushed commit");
  // The wait can take an hour, and no agent runs to hear a stop: ask the inbox on each try. A failed read does not stop.
  const box = inbox(ctx);
  const checks = await waitFor(ctx, async () => ((await box.poll().catch(() => undefined))?.stop ? ("stopped" as const) : ctx.codeHost.checks({ change, sha: headSha })));
  if (checks === "stopped") return stopped(ctx, "risk-check", { session: f.session, reason: stopReason(ctx) });
  const diff = await ctx.repo.diff();
  const files = changedFiles(diff.numstat);
  // A repo with no CI: the precommit gate, which ran the target's lint, test and build on this head, stands in for the pipeline.
  const gateStandsIn = checks === "absent" && f.gatePassed === true;
  const rules = hardRules(files, diff.text, ctx.target, checks === "green" || gateStandsIn, gateStandsIn ? "The repo has no CI, so the green precommit gate counts as the pipeline" : undefined);
  const tests = !(files instanceof Error) && testOnly(files);
  for (const r of rules) emit(ctx, "rule_check", { rule: r.rule, passed: r.passed, detail: r.detail });
  // From the Settings page, which the agent cannot change. A bad value sends the change to a person in the decision step.
  const { values: thresholds, errors: thresholdErrors } = await readThresholds(ctx);
  let risk;
  try {
    risk = await askRisk(ctx.judge, ctx.record.ticket!, diff.text);
  } catch (e) {
    // No guessing: the decision step sends this change to a person.
    save(ctx, "risk-check", { headSha, checks, rules, riskError: String(e), thresholds, thresholdErrors, testOnly: tests });
    return "next";
  }
  save(ctx, "risk-check", { headSha, checks, rules, risk, thresholds, thresholdErrors, testOnly: tests });
  if (thresholdErrors.length === 0 && riskReasons(risk, thresholds).length === 0) await ctx.tracker.mark(ticketRef(ctx), "risk_checked");
  return "next";
}

export const main = () => runStep("risk-check", run);
if (isMain(import.meta.url)) await main();
