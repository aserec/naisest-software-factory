import type { Finding } from "./agents.js";
import type { HarnessResult } from "./seams.js";
import type { FactoryCommands } from "./types.js";

export interface LoopDeps {
  review(): Promise<Finding[]>;
  fix(feedback: string): Promise<HarnessResult>;
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
}
export type LoopResult =
  | { kind: "passed"; rounds: number }
  | { kind: "blocked"; rounds: number; open: string[] }
  | { kind: "limit" | "stopped"; rounds: number; sessionId: string }; // rounds: the round the limit or the stop came in

// Runs fix. Returns a final result if the loop must stop, otherwise undefined.
async function fixOrStop(deps: LoopDeps, feedback: string, rounds: number): Promise<LoopResult | undefined> {
  const r = await deps.fix(feedback);
  if (r.stopped) return { kind: "stopped", rounds, sessionId: r.session };
  if (r.limitHit) return { kind: "limit", rounds, sessionId: r.session };
  if (!r.ok) return { kind: "blocked", rounds, open: [`author run failed: ${r.text.slice(0, 500)}`] };
  return undefined;
}

// start > 1 continues a resumed loop, so maxRounds counts every round of the run.
export async function codeReviewLoop(deps: LoopDeps, maxRounds = 3, start = 1): Promise<LoopResult> {
  for (let round = start; ; round++) {
    const blocking = (await deps.review()).filter((f) => f.blocking);
    if (blocking.length === 0) return { kind: "passed", rounds: round };
    const lines = blocking.map((f) => (f.file ? `${f.file}: ${f.text}` : f.text));
    if (round >= maxRounds) return { kind: "blocked", rounds: round, open: blocking.map((f) => f.text) };
    const stop = await fixOrStop(deps, lines.join("\n"), round);
    if (stop) return stop;
  }
}

export async function precommitGate(deps: LoopDeps, cmds: FactoryCommands, maxRounds = 3, start = 1): Promise<LoopResult> {
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
    const stop = await fixOrStop(deps, `${failed.cmd} failed:\n${failed.tail}`, round);
    if (stop) return stop;
  }
}
