import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { answerOf, type JevClient, type JevQuestion } from "./jev";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import type { Answer, Risk } from "./types";

const questions = parse(readFileSync(fileURLToPath(new URL("../jev/triage.yml", import.meta.url)), "utf8")) as JevQuestion[];

export const injectionQuestion = questions.find((q) => q.id === "injection")!;

export interface TriageAnswers { injectionYes: number; type: Answer<string>; risk: Answer<Risk>; clarity: Answer<number>; effort: Answer<number> }
export type TriageOutcome = { kind: "blocked"; reason: string } | { kind: "needs_info" } | { kind: "build"; risk: Risk; effort: number };

const MAX_DESCRIPTION = 8000;
export const INJECTION_LIMIT = 0.3;

// The probability that the state tries to instruct an agent. NaN when the judge gives no answer, which callers treat as an injection.
export async function injectionYes(judge: JevClient, state: object): Promise<number> {
  const [a] = await judge.ask(state, [injectionQuestion]);
  return a ? a.probability : NaN;
}
const RISK_CONFIDENCE_MIN = 0.7;
const RISKS: Risk[] = ["trivial", "low", "medium", "high"];
const isRisk = (v: unknown): v is Risk => RISKS.some((r) => r === v);

export function buildTriageState(title: string, description: string, labels: string[]) {
  return { title, description: description.slice(0, MAX_DESCRIPTION), labels };
}

export async function askTriage(jev: JevClient, state: object): Promise<TriageAnswers> {
  const answers = await jev.ask(state, questions);
  const get = (id: string) => answerOf(answers, id);
  const risk = get("risk").value;
  return {
    injectionYes: get("injection").probability,
    type: { value: String(get("type").value), confidence: get("type").confidence },
    // An unknown risk counts as high, as decideTriage does for older records.
    risk: { value: isRisk(risk) ? risk : "high", confidence: get("risk").confidence },
    clarity: { value: Number(get("clarity").value), confidence: get("clarity").confidence },
    effort: { value: Number(get("effort").value), confidence: get("effort").confidence },
  };
}

export function decideTriage(a: TriageAnswers, clarityMin = DEFAULT_THRESHOLDS.clarityMin): TriageOutcome {
  // Every check fails closed: NaN or an unknown value never lets a ticket through.
  if (!(a.injectionYes < INJECTION_LIMIT)) return { kind: "blocked", reason: `Possible prompt injection (P(yes) ${a.injectionYes})` };
  if (!(a.clarity.value >= clarityMin)) return { kind: "needs_info" };
  // An unknown risk counts as high. An unsure risk answer counts as one level higher.
  const known = RISKS.includes(a.risk.value) ? a.risk.value : "high";
  const i = RISKS.indexOf(known);
  const risk = a.risk.confidence >= RISK_CONFIDENCE_MIN ? known : RISKS[Math.min(i + 1, RISKS.length - 1)];
  return { kind: "build", risk, effort: a.effort.value };
}
