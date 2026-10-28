import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { JevClient, JevQuestion } from "./jev";
import type { RuleResult } from "./rules";
import type { Answer, Risk } from "./types";

const questions = parse(readFileSync(fileURLToPath(new URL("../jev/risk.yml", import.meta.url)), "utf8")) as JevQuestion[];

export interface RiskAnswers { diffRisk: Answer<number>; scopeYes: number; sensitiveYes: number }
export type MergeDecision = { kind: "auto" } | { kind: "needs_approval"; reasons: string[] };

const MAX_DIFF = 8000;
const DIFF_RISK_MAX = 4;
const MIN_CONFIDENCE = 0.9;
const EPSILON = 1e-9; // so 0.9 and 0.1 pass despite float error

export async function askRisk(jev: JevClient, ticket: { title: string; description: string }, diffText: string): Promise<RiskAnswers> {
  const answers = await jev.ask({ title: ticket.title, description: ticket.description, diff: diffText.slice(0, MAX_DIFF) }, questions);
  const get = (id: string) => {
    const a = answers.find((x) => x.id === id);
    if (!a) throw new Error(`Jev gave no answer for "${id}"`);
    return a;
  };
  const risk = get("diff_risk");
  return {
    diffRisk: { value: Number(risk.value), confidence: risk.confidence },
    scopeYes: get("scope").probability,
    sensitiveYes: get("sensitive").probability,
  };
}

export function decideMerge(input: { triageRisk: Risk; reviewPassed: boolean; gateGreen: boolean; rules: RuleResult[]; risk: RiskAnswers }): MergeDecision {
  const { triageRisk, reviewPassed, gateGreen, rules, risk } = input;
  const reasons: string[] = [];
  if (triageRisk !== "trivial" && triageRisk !== "low") reasons.push(`triage risk is ${triageRisk}, only trivial or low can merge alone`);
  if (!reviewPassed) reasons.push("code review did not pass");
  if (!gateGreen) reasons.push("precommit-gate is not green");
  // An empty list passes only because the caller always passes all five rules.
  for (const r of rules) if (!r.passed) reasons.push(`hard rule ${r.rule} failed: ${r.detail}`);
  // NaN fails every check below, so a bad answer goes to a person.
  if (!(risk.diffRisk.value <= DIFF_RISK_MAX)) reasons.push(`diff_risk ${risk.diffRisk.value} is above ${DIFF_RISK_MAX}`);
  if (!(risk.diffRisk.confidence >= MIN_CONFIDENCE - EPSILON)) reasons.push(`diff_risk confidence ${risk.diffRisk.confidence} is below ${MIN_CONFIDENCE}`);
  if (!(risk.scopeYes >= MIN_CONFIDENCE - EPSILON)) reasons.push(`scope yes ${risk.scopeYes} is below ${MIN_CONFIDENCE}`);
  if (!(risk.sensitiveYes <= 1 - MIN_CONFIDENCE + EPSILON)) reasons.push(`sensitive yes ${risk.sensitiveYes} is above ${+(1 - MIN_CONFIDENCE).toFixed(2)}`);
  return reasons.length ? { kind: "needs_approval", reasons } : { kind: "auto" };
}
