import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { JevClient, JevQuestion } from "./jev";
import type { RuleResult } from "./rules";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./thresholds";
import type { Answer, Risk } from "./types";

const questions = parse(readFileSync(fileURLToPath(new URL("../jev/risk.yml", import.meta.url)), "utf8")) as JevQuestion[];

export interface RiskAnswers { diffRisk: Answer<number>; scopeYes: number; sensitiveYes: number }
export type MergeDecision = { kind: "auto" } | { kind: "needs_approval"; reasons: string[] };

const MAX_DIFF = 8000;
const RULE_NAMES: RuleResult["rule"][] = ["protected-path", "dependency-file", "size", "secret", "pipeline"];
const EPSILON = 1e-9; // so 0.9 and 0.1 pass despite float error

export async function askRisk(jev: JevClient, ticket: { title: string; description: string }, diffText: string): Promise<RiskAnswers> {
  const answers = await jev.ask({ title: ticket.title, description: ticket.description, diff: diffText.slice(0, MAX_DIFF) }, questions);
  const get = (id: string) => {
    const a = answers.find((x) => x.id === id);
    if (!a) throw new Error(`Jev gave no answer for "${id}"`);
    return a;
  };
  const risk = get("diff_risk");
  if (typeof risk.value !== "number") throw new Error(`Jev diff_risk answer is not a number: ${JSON.stringify(risk.value)}`);
  return {
    diffRisk: { value: risk.value, confidence: risk.confidence },
    scopeYes: get("scope").probability,
    sensitiveYes: get("sensitive").probability,
  };
}

// Why Jev 2's answers do not let the change merge alone. Empty: they pass.
export function riskReasons(risk: RiskAnswers, t: Thresholds = DEFAULT_THRESHOLDS): string[] {
  const reasons: string[] = [];
  const min = t.autoMergeConfidenceMin;
  // NaN fails every check below, so a bad answer goes to a person.
  const v = risk.diffRisk.value;
  if (!(Number.isInteger(v) && v >= 2 && v <= 10)) reasons.push(`diff_risk ${v} is not a whole number from 2 to 10`);
  else if (v > t.diffRiskMax) reasons.push(`diff_risk ${v} is above ${t.diffRiskMax}`);
  const inRange = (n: number) => n >= 0 && n <= 1;
  if (!inRange(risk.diffRisk.confidence)) reasons.push(`diff_risk confidence ${risk.diffRisk.confidence} is not between 0 and 1`);
  if (!inRange(risk.scopeYes)) reasons.push(`scope yes ${risk.scopeYes} is not between 0 and 1`);
  if (!inRange(risk.sensitiveYes)) reasons.push(`sensitive yes ${risk.sensitiveYes} is not between 0 and 1`);
  if (!(risk.diffRisk.confidence >= min - EPSILON)) reasons.push(`diff_risk confidence ${risk.diffRisk.confidence} is below ${min}`);
  if (!(risk.scopeYes >= min - EPSILON)) reasons.push(`scope yes ${risk.scopeYes} is below ${min}`);
  if (!(risk.sensitiveYes <= 1 - min + EPSILON)) reasons.push(`sensitive yes ${risk.sensitiveYes} is above ${+(1 - min).toFixed(2)}`);
  return reasons;
}

export function decideMerge(input: { triageRisk: Risk; reviewPassed: boolean; gateGreen: boolean; rules: RuleResult[]; risk: RiskAnswers; thresholds?: Thresholds }): MergeDecision {
  const { triageRisk, reviewPassed, gateGreen, rules, risk, thresholds } = input;
  const reasons: string[] = [];
  if (triageRisk !== "trivial" && triageRisk !== "low") reasons.push(`triage risk is ${triageRisk}, only trivial or low can merge alone`);
  if (!reviewPassed) reasons.push("code review did not pass");
  if (!gateGreen) reasons.push("precommit-gate is not green");
  // All five rules must be present and passed. Missing or unknown names go to a person.
  for (const name of RULE_NAMES) {
    if (!rules.some((r) => r.rule === name)) reasons.push(`hard rule ${name} is missing`);
  }
  for (const r of rules) {
    if (!RULE_NAMES.includes(r.rule)) reasons.push(`unknown hard rule ${String(r.rule)}`);
    else if (r.passed !== true) reasons.push(`hard rule ${r.rule} failed: ${r.detail}`);
  }
  reasons.push(...riskReasons(risk, thresholds));
  return reasons.length ? { kind: "needs_approval", reasons } : { kind: "auto" };
}
