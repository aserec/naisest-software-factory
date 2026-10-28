import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunRecord {
  workItem: string;
  startedAt: string;
  steps: { step: string; at: string; data: unknown }[];
  models: { author?: string; reviewer?: string };
  rounds: { review: number; gate: number };
  costUsd: number;
}

export function loadRecord(dir = "run"): RunRecord {
  return JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
}

export function saveRecord(r: RunRecord, dir = "run"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "record.json"), JSON.stringify(r, null, 2));
}

export function addStep(r: RunRecord, step: string, data: unknown): RunRecord {
  return { ...r, steps: [...r.steps, { step, at: new Date().toISOString(), data }] };
}

// Plain text for the result comment.
export function formatResult(r: RunRecord, mrUrl: string, pipelineUrl: string, now: Date): string {
  const answers = (name: string) => `${name}: ${JSON.stringify(r.steps.find((s) => s.step === name)?.data ?? null)}`;
  const minutes = Math.round((now.getTime() - new Date(r.startedAt).getTime()) / 60000);
  return [
    `Merge request: ${mrUrl}`,
    `Pipeline: ${pipelineUrl}`,
    answers("triage"),
    answers("risk-check"),
    `Models: author ${r.models.author ?? "none"}, reviewer ${r.models.reviewer ?? "none"}`,
    `review rounds: ${r.rounds.review}`,
    `gate rounds: ${r.rounds.gate}`,
    `Cost: $${r.costUsd.toFixed(2)}`,
    `Time: ${minutes} min`,
  ].join("\n");
}
