import { DIFF_RISK_MAX } from "./run-events";

// A target's thresholds come from the dashboard's Settings page, sent with the switches in the control answer.
// Medium and high use the router's high row, whose mayAutoMerge stops them first, so they are not offered.
export const TRIAGE_RISKS = ["trivial", "low"] as const;
export type AutoMergeTriageMax = (typeof TRIAGE_RISKS)[number];

export interface Thresholds { diffRiskMax: number; autoMergeConfidenceMin: number; clarityMin: number; maxAgentRounds: number; autoMergeTriageMax: AutoMergeTriageMax }
export const DEFAULT_THRESHOLDS: Thresholds = { diffRiskMax: DIFF_RISK_MAX, autoMergeConfidenceMin: 0.8, clarityMin: 6, maxAgentRounds: 10, autoMergeTriageMax: "low" };

const whole = (lo: number, hi: number) => ({ rule: `a whole number from ${lo} to ${hi}`, ok: (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi });
export const THRESHOLD_RULES: Record<keyof Thresholds, { rule: string; ok: (v: unknown) => boolean }> = {
  diffRiskMax: whole(2, 10),
  // Below 0.5 the scope and sensitive checks would pass a "no".
  autoMergeConfidenceMin: { rule: "a number from 0.5 to 1", ok: (v) => typeof v === "number" && v >= 0.5 && v <= 1 },
  clarityMin: whole(2, 10),
  maxAgentRounds: whole(1, 10),
  autoMergeTriageMax: { rule: `one of ${TRIAGE_RISKS.join(", ")}`, ok: (v) => TRIAGE_RISKS.includes(v as AutoMergeTriageMax) },
};

// Fails closed: a bad key keeps its default and adds an error, and the decision step sends the change to a person.
export function checkThresholds(doc: unknown): { values: Thresholds; errors: string[] } {
  const values = { ...DEFAULT_THRESHOLDS };
  const errors: string[] = [];
  if (doc === null || doc === undefined) return { values, errors };
  if (typeof doc !== "object" || Array.isArray(doc)) return { values, errors: ["The thresholds setting is not a map"] };
  for (const [key, v] of Object.entries(doc)) {
    if (!Object.hasOwn(THRESHOLD_RULES, key)) errors.push(`Settings: unknown threshold ${key}`);
    else if (!THRESHOLD_RULES[key as keyof Thresholds].ok(v)) errors.push(`Settings: ${key} must be ${THRESHOLD_RULES[key as keyof Thresholds].rule}`);
    else (values as Record<string, unknown>)[key] = v;
  }
  return { values, errors };
}
