import { emit } from "../emit";
import { askRisk, riskReasons } from "../decision";
import { need } from "../record";
import { checkHardRules, parseNumstat, type RuleResult } from "../rules";
import type { Target } from "../types";
import { facts, isMain, runStep, save, ticketRef, waitFor, type StepContext, type StepResult } from "./context";

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
  // headSha is the commit that was reviewed and checked. apply merges only that commit.
  const f = facts(ctx);
  const change = need(f.change, "change");
  const headSha = need(f.gateHead, "pushed commit");
  const checks = await waitFor(ctx, () => ctx.codeHost.checks({ change, sha: headSha }));
  const diff = await ctx.repo.diff();
  const rules = hardRules(diff.numstat, diff.text, ctx.target, checks === "green");
  for (const r of rules) emit(ctx, "rule_check", { rule: r.rule, passed: r.passed, detail: r.detail });
  let risk;
  try {
    risk = await askRisk(ctx.judge, ctx.record.ticket!, diff.text);
  } catch (e) {
    // No guessing: the decision step sends this change to a person.
    save(ctx, "risk-check", { headSha, checks, rules, riskError: String(e) });
    return "next";
  }
  save(ctx, "risk-check", { headSha, checks, rules, risk });
  if (riskReasons(risk).length === 0) await ctx.tracker.mark(ticketRef(ctx), "risk_checked");
  return "next";
}

export const main = () => runStep("risk-check", run);
if (isMain(import.meta.url)) await main();
