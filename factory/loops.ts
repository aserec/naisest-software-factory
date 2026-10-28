import type { ClaudeResult, Finding } from "./agents.js";
import type { FactoryCommands } from "./types.js";

export interface LoopDeps {
  review(): Promise<Finding[]>;
  fix(feedback: string): Promise<ClaudeResult>;
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
}
export type LoopResult =
  | { kind: "passed"; rounds: number }
  | { kind: "blocked"; rounds: number; open: string[] }
  | { kind: "limit"; sessionId: string };

// Runs fix. Returns a final result if the loop must stop, otherwise undefined.
async function fixOrStop(deps: LoopDeps, feedback: string, rounds: number): Promise<LoopResult | undefined> {
  const r = await deps.fix(feedback);
  if (r.limitHit) return { kind: "limit", sessionId: r.sessionId };
  if (r.isError) return { kind: "blocked", rounds, open: [`author run failed: ${r.resultText.slice(0, 500)}`] };
  return undefined;
}

export async function codeReviewLoop(deps: LoopDeps, maxRounds = 3): Promise<LoopResult> {
  for (let round = 1; ; round++) {
    const blocking = (await deps.review()).filter((f) => f.blocking);
    if (blocking.length === 0) return { kind: "passed", rounds: round };
    const lines = blocking.map((f) => (f.file ? `${f.file}: ${f.text}` : f.text));
    if (round >= maxRounds) return { kind: "blocked", rounds: round, open: blocking.map((f) => f.text) };
    const stop = await fixOrStop(deps, lines.join("\n"), round);
    if (stop) return stop;
  }
}

export async function precommitGate(deps: LoopDeps, cmds: FactoryCommands, maxRounds = 3): Promise<LoopResult> {
  for (let round = 1; ; round++) {
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
