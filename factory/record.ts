import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeDecision, RiskAnswers } from "./decision";
import type { ProofRecord } from "./proof";
import type { RuleResult } from "./rules";
import type { ChangeRef, Checks, PersonRef, TicketRef } from "./seams";
import type { Thresholds } from "./thresholds";
import type { TriageAnswers, TriageOutcome } from "./triage";
import type { FactoryCommands, RouterRow } from "./types";
import type { CommitMessage } from "./steps/precommit-gate";

export const RUN_DIR = "run";

export interface Request { author: PersonRef; body: string; at: string; on: "work item" | "change" }
// One round of @factory requests on the change: what was asked, and what it cost and found.
// conflicts: a conflict round, which merges the base branch and resolves the conflicts; it has no requests.
export interface RequestRound {
  cursor: string; requests: Request[]; conflicts?: true; costAtStart: number; tokensAtStart: { input: number; output: number };
  answer?: string; endedAt?: string; review?: number; gate?: number; costUsd?: number; tokens?: { input: number; output: number };
}

export interface RunRecord {
  runId?: string; // the dashboard's run ID; a resumed run keeps it
  workItem: string;
  startedAt: string;
  steps: { step: string; at: string; data: unknown }[];
  models: { author?: string; reviewer?: string }; // "<harness>/<model>"
  rounds: { review: number; gate: number };
  costUsd: number;
  tokens?: { input: number; output: number };
  summary?: string; // what changed
  ticket?: { title: string; description: string }; // the text Jev 1 checked; agents only see this text
  requestRounds?: RequestRound[];
  heardUntil?: string; // the time of the newest comment already taken into the run
}

// What applyOutcome saves for a stopped or waiting step outcome when an agent run pauses. A paused run resumes from it.
export interface PauseData { sessionId?: string; limit?: true; stopped?: true; switchOff?: boolean; network?: true }

// The data each step saves in the record, by step name. Old records keep loading, so a field that an older
// factory version did not save is optional here.
export interface StepData {
  event: {
    start?: boolean; reason?: string; error?: string; ticket?: TicketRef; actor?: string; action?: string; command?: string; change?: ChangeRef;
    resume?: true; resumeAt?: string; fromPipeline?: string; sessionId?: string; // a resumed run
    round?: number; // a request round starts here: its number, from 1
  };
  triage: { answers: TriageAnswers; outcome: TriageOutcome; row: RouterRow };
  questions: PauseData;
  "prepare-patch": { sessionId: string; commands: FactoryCommands } | (PauseData & { commands?: FactoryCommands });
  "code-review": { passed: true; rounds: number; sessionId?: string; proof: ProofRecord } | PauseData;
  "precommit-gate":
    | { passed: true; rounds: number; branch: string; sha: string; change: ChangeRef; changeUrl: string; images?: Record<string, string>; uploadFailed?: string[]; commit?: CommitMessage }
    | PauseData;
  "risk-check": { headSha: string; checks: Checks; rules: RuleResult[]; risk?: RiskAnswers; riskError?: string; thresholds?: Thresholds; thresholdErrors?: string[]; testOnly?: boolean } | PauseData; // testOnly: the diff changes test files only
  decision: MergeDecision | PauseData;
  apply: { change: ChangeRef; sha: string; skipped?: true; reviewed?: string; rebased?: string[] } | PauseData;
  verify: { status: Checks };
  "result-saved": Record<string, never>;
  blocked: { reason: string; step?: string };
}
export type StepName = keyof StepData;
// The steps that can pause: their agent hit its usage limit, or a person or a switch stopped them.
export type PausableStep = "questions" | "prepare-patch" | "code-review" | "precommit-gate" | "risk-check" | "decision" | "apply";

export function newRecord(): RunRecord {
  return { workItem: "", startedAt: new Date().toISOString(), steps: [], models: {}, rounds: { review: 0, gate: 0 }, costUsd: 0 };
}

export function loadRecord(dir = RUN_DIR): RunRecord {
  return JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
}

export function saveRecord(r: RunRecord, dir = RUN_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "record.json"), JSON.stringify(r, null, 2));
}

export function addStep(r: RunRecord, step: string, data: unknown): RunRecord {
  return { ...r, steps: [...r.steps, { step, at: new Date().toISOString(), data }] };
}

const newestFirst = (r: RunRecord) => [...r.steps].reverse();
// The data of the last record step with this name. The record is JSON from a file, so this trusts its shape.
function last<K extends StepName>(r: RunRecord, step: K): StepData[K] | undefined {
  return newestFirst(r).find((s) => s.step === step)?.data as StepData[K] | undefined;
}

// The facts the steps read from a run record. Each is the newest one the record holds, or undefined.
export function runFacts(r: RunRecord) {
  const event = last(r, "event");
  const triage = last(r, "triage");
  const review = last(r, "code-review");
  const gate = last(r, "precommit-gate");
  const passedGate = gate && "change" in gate ? gate : undefined;
  const risk = last(r, "risk-check");
  const riskCheck = risk && "headSha" in risk ? risk : undefined; // a stop while it waited saves no check
  const decision = last(r, "decision");
  const applied = last(r, "apply");
  const end = r.steps.at(-1);
  const newest = newestFirst(r)[0];
  const pause = end?.data as PauseData | undefined;
  return {
    ticket: event?.ticket, // the event step's ticket
    eventAt: newestFirst(r).find((s) => s.step === "event")?.at, // when this run (or its resume) started
    resumed: !!event?.resume && event.round === undefined, // the newest event is a resume after a pause, not a round start
    roundStart: newest?.step === "event" && (newest.data as StepData["event"]).round !== undefined, // the newest event started a round
    openRound: r.requestRounds?.at(-1)?.endedAt === undefined ? r.requestRounds?.at(-1) : undefined, // the last round, if it has not ended
    requested: !!r.requestRounds?.some((x) => !x.conflicts), // a conflict round is the factory's own, not a person's request
    resumeAt: event?.resumeAt, // a resumed run continues at this build job
    // On a resumed run, the saved session if this job is the one that paused.
    resumeSession: (job: string) => (event?.resumeAt === job ? event.sessionId : undefined),
    row: triage?.row, // the router row: the author and reviewer models
    triageRisk: triage?.outcome.kind === "build" ? triage.outcome.risk : undefined,
    commands: last(r, "prepare-patch")?.commands, // the .factory.yml commands, read before the agent ran
    // The newest author session in the record. Fixes and resumed runs continue it.
    session: newestFirst(r).map((s) => (s.data as PauseData | undefined)?.sessionId).find(Boolean),
    reviewPassed: review && "passed" in review ? review.passed : undefined,
    proof: review && "proof" in review ? review.proof : undefined,
    gatePassed: passedGate?.passed,
    change: passedGate?.change,
    changeUrl: passedGate?.changeUrl,
    branch: passedGate?.branch,
    gateHead: passedGate?.sha, // the commit the gate pushed
    commit: passedGate?.commit, // older records have none
    images: passedGate?.images, // older records have none
    uploadFailed: passedGate?.uploadFailed, // older records have none
    riskCheck,
    reviewedHead: riskCheck?.headSha, // the commit that was reviewed and checked: apply merges only this one
    decisionKind: decision && "kind" in decision ? decision.kind : undefined,
    mergedSha: applied && "sha" in applied ? applied.sha : undefined,
    // The last step, if a stopped or waiting step outcome saved it: where and how the run paused.
    paused: pause?.limit || pause?.stopped ? { step: end!.step, ...pause } : undefined,
    blockedStep: end?.step === "blocked" ? (end.data as StepData["blocked"]).step : undefined, // the job that blocked the run
    // Why this record cannot continue for this work item, or undefined if it can.
    cannotContinue(workItem: string, buildRun: string): string | undefined {
      if (r.workItem !== workItem) return `the record of pipeline ${buildRun} is for another ticket`;
      // A record from before the router named a harness per role cannot be continued.
      if (typeof triage?.row?.author !== "object") return `the record of pipeline ${buildRun} is from an older factory version`;
      return undefined;
    },
  };
}

// A fact the step cannot go on without. An unexpected error fails the job, and runStep blocks the ticket.
export function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The run record has no ${what}`);
  return value;
}

// Plain text for the result comment.
export function formatResult(r: RunRecord, mrUrl: string, pipelineUrl: string, now: Date): string {
  const answers = (name: string) => {
    const s = r.steps.find((x) => x.step === name);
    return s ? `${name}: ${JSON.stringify(s.data)}` : `${name}: did not run`;
  };
  const ms = now.getTime() - new Date(r.startedAt).getTime();
  const time = Number.isNaN(ms) ? "unknown" : `${Math.round(ms / 60000)} min`;
  return [
    `Merge request: ${mrUrl}`,
    `Pipeline: ${pipelineUrl}`,
    answers("triage"),
    answers("risk-check"),
    ...(r.summary ? [`What changed: ${r.summary}`] : []),
    `Models: author ${r.models.author ?? "none"}, reviewer ${r.models.reviewer ?? "none"}`,
    `review rounds: ${r.rounds.review}`,
    `gate rounds: ${r.rounds.gate}`,
    `Cost: $${r.costUsd.toFixed(2)}`,
    ...(r.tokens ? [`Tokens: ${r.tokens.input} in, ${r.tokens.output} out`] : []),
    `Time: ${time}`,
  ].join("\n");
}
