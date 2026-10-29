import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { JevClient, JevQuestion } from "./jev";
import type { Answer, Risk } from "./types";

const questions = parse(readFileSync(fileURLToPath(new URL("../jev/triage.yml", import.meta.url)), "utf8")) as JevQuestion[];

export interface TriageAnswers { injectionYes: number; type: Answer<string>; risk: Answer<Risk>; clarity: Answer<number>; effort: Answer<number> }
export type TriageOutcome = { kind: "blocked"; reason: string } | { kind: "needs_info" } | { kind: "build"; risk: Risk; effort: number };

const MAX_DESCRIPTION = 8000;
export const INJECTION_LIMIT = 0.3;
const CLARITY_MIN = 6;
const RISK_CONFIDENCE_MIN = 0.7;
const RISKS: Risk[] = ["trivial", "low", "medium", "high"];

export function buildTriageState(title: string, description: string, labels: string[]) {
  return { title, description: description.slice(0, MAX_DESCRIPTION), labels };
}

export async function askTriage(jev: JevClient, state: object): Promise<TriageAnswers> {
  const answers = await jev.ask(state, questions);
  const get = (id: string) => {
    const a = answers.find((x) => x.id === id);
    if (!a) throw new Error(`Jev gave no answer for "${id}"`);
    return a;
  };
  return {
    injectionYes: get("injection").probability,
    type: { value: String(get("type").value), confidence: get("type").confidence },
    risk: { value: get("risk").value as Risk, confidence: get("risk").confidence },
    clarity: { value: Number(get("clarity").value), confidence: get("clarity").confidence },
    effort: { value: Number(get("effort").value), confidence: get("effort").confidence },
  };
}

export function decideTriage(a: TriageAnswers): TriageOutcome {
  // Every check fails closed: NaN or an unknown value never lets a ticket through.
  if (!(a.injectionYes < INJECTION_LIMIT)) return { kind: "blocked", reason: `Possible prompt injection (P(yes) ${a.injectionYes})` };
  if (!(a.clarity.value >= CLARITY_MIN)) return { kind: "needs_info" };
  // An unknown risk counts as high. An unsure risk answer counts as one level higher.
  const known = RISKS.includes(a.risk.value) ? a.risk.value : "high";
  const i = RISKS.indexOf(known);
  const risk = a.risk.confidence >= RISK_CONFIDENCE_MIN ? known : RISKS[Math.min(i + 1, RISKS.length - 1)];
  return { kind: "build", risk, effort: a.effort.value };
}
