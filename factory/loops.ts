import type { Finding } from "./agents.js";
import type { HarnessResult } from "./seams.js";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";
import type { FactoryCommands } from "./types.js";

// The agent loops default to DEFAULT_THRESHOLDS.maxAgentRounds; the steps pass the target's value. The rebase limit in steps/merge.ts is separate.

// Each loop takes only what it calls: the author's fix, and the review or the gate's commands.
interface FixDeps { fix(feedback: string): Promise<HarnessResult> }
// diff: the change's text. A fix that leaves it the same ends the loop, since the next review would see the same code.
// The gate has no such check: a flaky command may pass on the same code.
export interface ReviewDeps extends FixDeps { review(): Promise<Finding[]>; diff?(): Promise<string> }
export interface GateDeps extends FixDeps { run(cmd: string): Promise<{ ok: boolean; output: string }> }
export type LoopResult =
  | { kind: "passed"; rounds: number }
  | { kind: "blocked"; rounds: number; open: string[] }
  | { kind: "limit" | "stopped"; rounds: number; sessionId: string }; // rounds: the round the limit or the stop came in

// Runs fix on the open problems. Returns a final result if the loop must stop, otherwise undefined.
// A failed fix keeps the problems in the result, so the person sees what the author was asked to fix.
async function fixOrStop(deps: FixDeps & { diff?(): Promise<string> }, open: string[], rounds: number): Promise<LoopResult | undefined> {
  const before = await deps.diff?.();
  const r = await deps.fix(open.join("\n"));
  if (r.stopped) return { kind: "stopped", rounds, sessionId: r.session };
  if (r.limitHit) return { kind: "limit", rounds, sessionId: r.session };
  if (!r.ok) return { kind: "blocked", rounds, open: [...open, `author run failed: ${r.text.slice(0, 2000)}`] };
  // The author's answer says why, for example a command its sandbox denied.
  if (before !== undefined && (await deps.diff!()) === before) return { kind: "blocked", rounds, open: [...open, `The author changed no code. Its answer: ${r.text.slice(0, 2000)}`] };
  return undefined;
}

// start > 1 continues a resumed loop, so maxRounds counts every round of the run.
export async function codeReviewLoop(deps: ReviewDeps, maxRounds = DEFAULT_THRESHOLDS.maxAgentRounds, start = 1): Promise<LoopResult> {
  for (let round = start; ; round++) {
    const blocking = (await deps.review()).filter((f) => f.blocking);
    if (blocking.length === 0) return { kind: "passed", rounds: round };
    const lines = blocking.map((f) => (f.file ? `${f.file}: ${f.text}` : f.text));
    if (round >= maxRounds) return { kind: "blocked", rounds: round, open: blocking.map((f) => f.text) };
    const stop = await fixOrStop(deps, lines, round);
    if (stop) return stop;
  }
}

export async function precommitGate(deps: GateDeps, cmds: FactoryCommands, maxRounds = DEFAULT_THRESHOLDS.maxAgentRounds, start = 1): Promise<LoopResult> {
  for (let round = start; ; round++) {
    let failed: { cmd: string; tail: string } | undefined;
    for (const cmd of [cmds.lint, cmds.test, cmds.build]) {
      const r = await deps.run(cmd);
      if (!r.ok) {
        failed = { cmd, tail: r.output.slice(-2000) };
        break;
      }
    }
    if (!failed) return { kind: "passed", rounds: round };
    if (round >= maxRounds) return { kind: "blocked", rounds: round, open: [`${failed.cmd} failed:\n${failed.tail}`] };
    const stop = await fixOrStop(deps, [`${failed.cmd} failed:\n${failed.tail}`], round);
    if (stop) return stop;
  }
}
