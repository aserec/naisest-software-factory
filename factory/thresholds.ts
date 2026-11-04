import { parse } from "yaml";
import { DIFF_RISK_MAX } from "./run-events";

export const THRESHOLDS_PATH = ".factory/thresholds.yml";

export interface Thresholds { diffRiskMax: number; autoMergeConfidenceMin: number; clarityMin: number; maxAgentRounds: number }
export const DEFAULT_THRESHOLDS: Thresholds = { diffRiskMax: DIFF_RISK_MAX, autoMergeConfidenceMin: 0.9, clarityMin: 6, maxAgentRounds: 5 };

const whole = (lo: number, hi: number) => ({ rule: `a whole number from ${lo} to ${hi}`, ok: (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi });
const RULES: Record<keyof Thresholds, { rule: string; ok: (v: unknown) => boolean }> = {
  diffRiskMax: whole(2, 10),
  // Below 0.5 the scope and sensitive checks would pass a "no".
  autoMergeConfidenceMin: { rule: "a number from 0.5 to 1", ok: (v) => typeof v === "number" && v >= 0.5 && v <= 1 },
  clarityMin: whole(2, 10),
  maxAgentRounds: whole(1, 10),
};

// Fails closed: a bad key keeps its default and adds an error, and the decision step sends the change to a person.
export function readThresholds(text: string | undefined): { values: Thresholds; errors: string[] } {
  const values = { ...DEFAULT_THRESHOLDS };
  const errors: string[] = [];
  if (text === undefined) return { values, errors };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { values, errors: [`${THRESHOLDS_PATH} is not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : e}`] };
  }
  if (doc === null || doc === undefined) return { values, errors };
  if (typeof doc !== "object" || Array.isArray(doc)) return { values, errors: [`${THRESHOLDS_PATH} is not a YAML map`] };
  for (const [key, v] of Object.entries(doc)) {
    if (!Object.hasOwn(RULES, key)) errors.push(`${THRESHOLDS_PATH}: unknown key ${key}`);
    else if (!RULES[key as keyof Thresholds].ok(v)) errors.push(`${THRESHOLDS_PATH}: ${key} must be ${RULES[key as keyof Thresholds].rule}`);
    else values[key as keyof Thresholds] = v as number;
  }
  return { values, errors };
}
